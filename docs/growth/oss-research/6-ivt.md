# 6 — Invalid-Traffic (IVT) Filtering for Watrloo Ad Events

Research from fingerprintjs/BotD, readthedocs/ethical-ad-server, and IAB/MRC GIVT
basics, mapped onto our stack (React SPA + Supabase; `analytics_events` per
`docs/growth/ANALYTICS.md` §3 — the "ad_events" of this brief are the rows with
`event in ('ad_impression','ad_click')`; if a dedicated `ad_events` table ships
instead, every query below ports 1:1). Extends `docs/growth/ABUSE_AND_LIMITS.md`
§6.2 with concrete mechanics. IAB/MRC framing: **GIVT** = invalid traffic
catchable by routine, list-based filtration (known crawlers, non-browser UAs,
prefetch); **SIVT** = requires advanced analytics/human review. We aim for solid
GIVT coverage + the cheap end of SIVT (velocity, dedupe, self-click) — that is
the right scope before billing depends on counts.

---

## 1. Signal inventory

### 1.1 Client-side signals (from BotD's detector set — MIT, verified)

BotD (`@fingerprintjs/botd`, github.com/fingerprintjs/BotD) is MIT-licensed
(LICENSE checked: standard MIT, no BSL — the *commercial Fingerprint API* is the
paid thing; the open library is unrestricted). Its `src/detectors/` modules are
tiny pure functions over `src/sources/` readers. The top cheap ones, with the JS
each actually reads:

| # | Signal | JS to read it | Bot it catches |
|---|--------|---------------|----------------|
| 1 | WebDriver flag | `navigator.webdriver === true` | any WebDriver/CDP automation (Selenium, Playwright, Puppeteer) |
| 2 | UA substrings | `/Headless\|PhantomJS\|Electron\|slimerjs/i.test(navigator.userAgent)` | headless Chrome/Firefox, PhantomJS, Electron shells |
| 3 | Automation globals ("distinctive properties") | `'callPhantom' in window`, `'_phantom' in window`, `'__nightmare' in window`, `'_selenium' in window`, `'_Selenium_IDE_Recorder' in window`, `'CefSharp' in window`, `'awesomium' in window`, `'domAutomation' in window` | PhantomJS, NightmareJS, Selenium, CEF/CefSharp, Chromium automation |
| 4 | DOM attributes | `document.documentElement.getAttributeNames()` contains `'selenium'`, `'webdriver'`, or `'driver'` | Selenium (it stamps the root element) |
| 5 | Empty plugins on desktop Chrome | `navigator.plugins.length === 0` **and** UA says desktop Chrome | headless Chrome (real desktop Chrome always exposes ≥1, e.g. PDF viewer) |
| 6 | Languages inconsistency | `navigator.languages` is `undefined` or an empty array/string | headless Chrome variants |
| 7 | Zero window metrics | `window.outerWidth === 0 && window.outerHeight === 0` | older headless Chrome (no real window) |
| 8 | Notification permission contradiction | `Notification.permission === 'denied'` while `navigator.permissions.query({name:'notifications'})` resolves `state === 'prompt'` | headless Chrome (async — run once at boot, cache the bit) |

Also in BotD but skippable for us: `window.external` stringify (`Sequentum`),
`process` object (Electron), `eval.toString().length`, `Error.prototype.stack`
shape, `productSub`/`appVersion` cross-checks, WebGL vendor strings, `rtt`.
BotD's README is explicit that the OSS library only catches *basic* automation —
which is exactly the GIVT tier we want; do not oversell it as fraud-proof.

**Recommendation: don't add the dependency.** The 8 checks above are ~40 lines
of TS (sketch in §2.1); BotD's value is the curated list, which MIT lets us
mirror. No network call, no async init (except #8), no bundle weight.

### 1.2 Server-side signals

- **Known-crawler UA regex list.** `monperrus/crawler-user-agents` (MIT,
  verified; active — last push 2026-07-02, ~1.4k stars) ships one JSON file,
  entries like `{"pattern": "Googlebot\\/", "url": ..., "instances": [...]}`.
  Vendor the JSON, compile `new RegExp(patterns.join('|'), 'i')` once in the
  ingest Edge Function. Alternative: matomo-org/device-detector's bot YAML
  (verified to exist, but **LGPL-3.0** — prefer the MIT list).
- **Non-browser / degenerate UA.** Empty UA, UA < 20 chars, or UA the parser
  can't classify. EthicalAds rejects `os.family == "Other" or browser.family ==
  "Other"` ("probably a bot/proxy/prefetcher"). Cheap approximation without a
  parser: require the UA to contain `Mozilla/` and a known engine token.
- **Datacenter/proxy IP.** EthicalAds uses an IP2Proxy DB + explicit blocklist.
  For us the IP is visible **only in the Edge Function** (never in SQL — a
  constraint `RATE_LIMITING.md §4` already documents), so this check must live
  at the edge if we ever adopt it. Phase-2: a vendored datacenter-CIDR list
  checked in the ingest function. Not a launch blocker at our stakes.
- **Velocity / rate.** Per-session and per-user click caps over a window
  (reuse `check_rate_limit`'s fixed-window pattern from `RATE_LIMITING.md §2`).
- **Dedupe.** ≥2 clicks on the same placement by the same session/day count
  once (ABUSE_AND_LIMITS §6.2 rule 2).
- **Self-click via membership.** `analytics_events.user_id` joins
  `business_members` of the campaign's business → not billable (§3 below).
- **Impossible timing.** Click < 1s after the impression, repeatedly, across
  placements.
- **Clock sanity.** Already specced: clamp `occurred_at` to
  `[ingested_at - 48h, ingested_at + 5m]` at ingest (ANALYTICS.md §3).

### 1.3 The reference validity chain (EthicalAds — study only, AGPL)

`adserver/views.py::BaseProxyView.ignore_tracking_reason()` runs this ordered
reject list on every view/click before it counts (each returns a stored string
reason — kept, not silently dropped):

1. unknown offer → 2. **stale or reused nonce** (`is_valid_offer`: an offer id
   is minted at ad-serve time; a *view* is valid only if not yet viewed; a
   *click* only if viewed-and-not-yet-clicked; old offers expire) →
3. **bot UA** (`parsed_ua.is_bot or "bot" in ua.lower()`) → 4. internal IPs →
5. **unrecognized UA** (os/browser family "Other") → 6. **known logged-in staff
   user** (their own team's traffic never counts — the ancestor of our
   self-click rule) → 7. blocklisted UA regexes (env-configurable) →
8. blocklisted referrer → 9. blocklisted/proxy IP → 10. geo-targeting
   re-check at click time → 11. **click ratelimit** / 12. **view ratelimit**
   (per-IP, configurable list of rates) → 13/14. **OS/browser family mismatch**
   between offer-time and click-time UA (replayed nonce from another machine).
   IP mismatch between offer and click is *logged but not rejected*.

Rows carry `is_bot`, `is_refunded`, `viewed`, `clicked` — invalid traffic is
**recorded with a reason and excluded from billing**, not discarded. Their
client identity is `sha256(secret + anonymized_ip + ua)` (IP last 2 bytes
zeroed; rare UAs collapsed to "Rare user agent"). Patterns to copy; code not to
copy (AGPL-3.0 — see §4).

The **offer-nonce pattern** is their strongest idea: a click is only valid
against a server-minted, single-use, short-lived id. Our analogue: `ad_click`
must reference a `placement_id` that `active_featured()` actually served, and
we can later mint per-render nonces if abuse warrants.

---

## 2. Layered filter design for Watrloo

Events flow: `trackEvent` (client) → `analytics-ingest` Edge Function →
`track_events` RPC (service-role; the only writer). One layer per hop.

### Layer 1 — client pre-filter (don't even send the event)

Not a security control (a bot can skip our JS); it removes the *dumb* 95% for
free and keeps the table small. Silent: no error, no telltale.

```ts
// src/lib/analytics/ivt.ts — BotD-style cheap checks (list mirrored from
// fingerprintjs/BotD, MIT). Sync, ~0ms; run once and cache.
let cached: boolean | null = null;

export function isLikelyBot(): boolean {
  if (cached !== null) return cached;
  const w = window as any, n = navigator as any;
  const automationProps = ['callPhantom', '_phantom', '__nightmare', '_selenium',
    'callSelenium', '_Selenium_IDE_Recorder', 'CefSharp', 'awesomium', 'domAutomation'];
  const ua = navigator.userAgent;
  const desktopChrome = /Chrome\//.test(ua) && !/Android|Mobile/i.test(ua);
  cached =
    n.webdriver === true ||                                            // 1
    /Headless|PhantomJS|Electron|slimerjs/i.test(ua) ||                // 2
    automationProps.some((p) => p in w) ||                             // 3
    document.documentElement.getAttributeNames()
      .some((a) => /selenium|webdriver|driver/i.test(a)) ||            // 4
    (desktopChrome && navigator.plugins.length === 0) ||               // 5
    !navigator.languages || navigator.languages.length === 0 ||        // 6
    (window.outerWidth === 0 && window.outerHeight === 0);             // 7
  return cached;
}

// Async check #8 — refine the cached bit shortly after boot.
export async function refineBotCheck(): Promise<void> {
  try {
    if (Notification?.permission === 'denied') {
      const s = await navigator.permissions.query({ name: 'notifications' });
      if (s.state === 'prompt') cached = true;   // headless Chrome contradiction
    }
  } catch { /* permissions API missing — no signal */ }
}
```

Wire-up in `trackEvent` (ANALYTICS.md §5.1): ad events short-circuit —
`if ((e.event === 'ad_impression' || e.event === 'ad_click') && isLikelyBot()) return;`
Non-ad product analytics can still flow (bot traffic on `route_view` is a
separate question); only *billable-ish* events are gated.

### Layer 2 — ingest/RPC-side rejection (authoritative, synchronous)

Two halves, because only the Edge Function sees headers and only SQL sees the
ledger.

**2a. Edge Function (UA list + shape checks)** — in `analytics-ingest`, before
calling the RPC:

```ts
// supabase/functions/analytics-ingest — GIVT gate on ad events.
// crawlerPatterns: vendored from monperrus/crawler-user-agents (MIT).
import patterns from './crawler-user-agents.json' with { type: 'json' };
const CRAWLER_RE = new RegExp(patterns.map((p: any) => p.pattern).join('|'), 'i');

function uaIsInvalid(ua: string | null): boolean {
  if (!ua || ua.length < 20) return true;          // degenerate / non-browser
  if (CRAWLER_RE.test(ua)) return true;            // known crawler (GIVT list)
  if (/\bbot\b|headless/i.test(ua)) return true;   // EthicalAds' belt-and-braces
  return false;
}
// For ad events only: drop with 204 (same response as success — never tell a
// bot it was filtered; EthicalAds hides the reason header from non-staff too).
const adEvents = batch.filter(e => e.event === 'ad_impression' || e.event === 'ad_click');
if (adEvents.length && uaIsInvalid(req.headers.get('user-agent'))) {
  batch = batch.filter(e => !adEvents.includes(e));
}
```

**2b. RPC (rate + dedupe within session)** — inside `track_events` (or a
dedicated `record_ad_event`), for ad events only. Same-transaction, so nothing
invalid ever lands unflagged:

```sql
-- Click dedupe: at most 1 billable ad_click per (session, placement, day).
-- Partial expression unique index — clicks are rare, index stays tiny.
create unique index if not exists ad_click_dedupe_idx
  on public.analytics_events (session_id, ((props->>'placement_id')::uuid),
                              (occurred_at::date))
  where event = 'ad_click' and session_id is not null;
-- Writer inserts ad_click with ON CONFLICT DO NOTHING → duplicate = no row.

-- Velocity: silent drop (return, don't raise — a 429 tells the bot it's seen).
-- Same fixed-window shape as check_rate_limit, keyed by session not user.
create or replace function public.ad_event_over_rate(p_session uuid, p_kind text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_limit  int := case p_kind when 'ad_click' then 20 else 300 end; -- per hour
  v_bucket timestamptz := date_trunc('hour', now());
  v_count  int;
begin
  if p_session is null then return false; end if;  -- Tier A: post-hoc only
  insert into public.rate_limits as rl (user_id, action, bucket, count)
  values (p_session, 'ivt_' || p_kind, v_bucket, 1)   -- session uuid reuses the pk slot
  on conflict (user_id, action, bucket) do update set count = rl.count + 1
  returning rl.count into v_count;
  return v_count > v_limit;
end; $$;
-- In the ad-event branch of track_events:
--   if public.ad_event_over_rate(p_session, v_event.event) then continue; end if;
```

### Layer 3 — post-hoc flagging (SQL over the ledger; audit-preserving)

Events are immutable append-only (ANALYTICS.md §3), so flags live in a side
table, written by a nightly pg_cron job. Flagged rows are **excluded from
billable rollups but kept** — same posture as EthicalAds' `is_bot`/reason
columns.

```sql
create table public.ad_event_flags (
  event_id   bigint not null references public.analytics_events (id) on delete cascade,
  reason     text   not null check (reason in
               ('self_click','velocity','duplicate','fast_click','ctr_anomaly')),
  flagged_at timestamptz not null default now(),
  primary key (event_id, reason)
);
alter table public.ad_event_flags enable row level security;  -- no policies: RPC/cron only

create or replace function public.flag_invalid_ad_events()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- (a) self-click / self-impression — exact SQL in §3.
  -- (b) velocity: sessions with implausible click volume in any hour.
  insert into public.ad_event_flags (event_id, reason)
  select e.id, 'velocity'
  from public.analytics_events e
  join (select session_id, date_trunc('hour', occurred_at) h
        from public.analytics_events
        where event = 'ad_click' and occurred_at > now() - interval '2 days'
        group by 1, 2 having count(*) > 20) hot
    on hot.session_id = e.session_id
   and date_trunc('hour', e.occurred_at) = hot.h
  where e.event = 'ad_click'
  on conflict do nothing;
  -- (c) duplicates that predate the unique index (or same-day Tier-A repeats).
  insert into public.ad_event_flags (event_id, reason)
  select id, 'duplicate' from (
    select id, row_number() over (partition by session_id,
             (props->>'placement_id'), occurred_at::date order by occurred_at) rn
    from public.analytics_events
    where event = 'ad_click' and session_id is not null
      and occurred_at > now() - interval '2 days') d
  where d.rn > 1
  on conflict do nothing;
  -- (d) impossible timing: click < 1s after that session's impression of the
  --     same placement (EthicalAds/ABUSE §6.2 "impossible timing").
  insert into public.ad_event_flags (event_id, reason)
  select c.id, 'fast_click'
  from public.analytics_events c
  join public.analytics_events i
    on i.event = 'ad_impression' and i.session_id = c.session_id
   and i.props->>'placement_id' = c.props->>'placement_id'
   and c.occurred_at - i.occurred_at between interval '0' and interval '1 second'
  where c.event = 'ad_click' and c.occurred_at > now() - interval '2 days'
  on conflict do nothing;
end; $$;
select cron.schedule('ivt_flagging', '30 2 * * *', $$select public.flag_invalid_ad_events()$$);
```

Billable rollup (the `campaign_daily` job from ANALYTICS.md §7) then counts
`... where not exists (select 1 from public.ad_event_flags f where f.event_id = e.id)`
— and the admin view can show `raw`, `flagged`, `billable` side by side. CTR
anomaly (>5× surface baseline → `ctr_anomaly` + admin-queue item) stays a
detection, never an auto-action, per ABUSE §6.2 rule 5.

---

## 3. Self-click exclusion — exact SQL against our schema

`ad_campaigns.business_id` → `business_members(business_id, user_id)` (both in
`supabase/migrations/2026071{1,2}000000_*.sql`). Any member — owner, manager,
or staff — clicking their own business's campaign is non-billable:

```sql
insert into public.ad_event_flags (event_id, reason)
select e.id, 'self_click'
from public.analytics_events e
join public.ad_campaigns    c on c.id = (e.props->>'campaign_id')::uuid
join public.business_members m on m.business_id = c.business_id
                              and m.user_id     = e.user_id
where e.event in ('ad_click', 'ad_impression')
  and e.user_id is not null
  and e.occurred_at > now() - interval '2 days'
on conflict do nothing;
```

Caveats: (a) Tier-A/anon events have `user_id is null` — a logged-out
self-clicker isn't caught here; velocity/dedupe are the backstop (we key on
session, not IP, by design — `RATE_LIMITING.md §4`). (b) Membership is checked
*as of flagging time*; if someone leaves the business the day after clicking,
the flag stands (fine — flags are conservative, and re-running is idempotent
via the PK). (c) The same join, inverted, powers an advertiser-console notice:
"N of your clicks came from your own team and are not counted."

---

## 4. Licenses of everything referenced (all verified this session)

| Source | License | Our use |
|---|---|---|
| fingerprintjs/BotD | **MIT** (LICENSE read; not BSL — no usage restriction) | mirror its detector *list* in ~40 lines of our own TS, or `npm i @fingerprintjs/botd` if we'd rather |
| monperrus/crawler-user-agents | **MIT** (pre-Nov-2016 history was CC-SA; current is MIT) | vendor `crawler-user-agents.json` into the ingest Edge Function |
| matomo-org/device-detector (bot YAML) | **LGPL-3.0** | reference only; prefer the MIT list above |
| readthedocs/ethical-ad-server | **AGPL-3.0** | **design study only — copy no code.** Rules/ordering are ideas (not copyrightable); verbatim code would obligate source disclosure of our service |
| selwin/python-user-agents (what EthicalAds parses UAs with) | MIT | not used; noted for completeness |
| IAB/MRC IVT standards (GIVT/SIVT definitions) | public standards docs | terminology + scope framing only |

Sources: github.com/fingerprintjs/BotD (`src/detectors/`, `src/sources/`, LICENSE);
github.com/readthedocs/ethical-ad-server (`adserver/views.py` BaseProxyView,
`adserver/utils.py`, `adserver/models.py::is_valid_offer`, `config/settings/base.py`);
github.com/monperrus/crawler-user-agents; mediaratingcouncil.org IVT Detection &
Filtration Addendum; pixalate.com/blog/mrc-definitions-sivt-givt; repo files
`docs/growth/ABUSE_AND_LIMITS.md` §6, `docs/growth/ANALYTICS.md` §3–5,
`docs/ops/RATE_LIMITING.md` §2/§4.
