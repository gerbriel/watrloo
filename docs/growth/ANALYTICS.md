# A4 — First-Party Analytics (`ANALYTICS.md`)

**Summary.** All product and campaign analytics live **first-party, in our own
Postgres** (`analytics_events` + rollups) — no Google Analytics, no third-party
pixels, no analytics SaaS, nothing that would falsify "we don't sell or share."
Events split into two consent tiers: **anonymous aggregate telemetry** (no
identity, no device storage, runs under legitimate interest) and **identified
session/user analytics** (gated behind an explicit analytics opt-in and killed by
GPC/DNT). Capture is a tiny `trackEvent` batcher that POSTs to an `analytics-ingest`
Edge Function, which stamps coarse region server-side, honors the `Sec-GPC` request
header authoritatively, validates against an event allow-list, and writes via a
`SECURITY DEFINER` RPC; advertisers see only aggregate metrics for **their** campaigns,
admins see everything, nobody sees another user's raw event stream except admins for
audit (logged).

**Dependencies.** This doc relies on:
- **`DATA_MODEL.md` (A2)** — owns the authoritative DDL/RLS for `analytics_events`,
  `campaign_sends`, and the new columns/tables I request below (search "REQUEST TO A2").
- **`COMPLIANCE.md` / `PRIVACY_POLICY_v2.md` (A1)** — the consent model, GPC as a
  mandatory opt-out, CAN-SPAM, "we don't sell/share," and the existing
  `docs/legal/PRIVACY_NOTES.md` audit that this design must not regress.
- **`LOCATION.md` (A3)** — coarse IP→region derivation (the source of the `region`
  string; analytics reuses it and never derives its own precise location).
- **`CAMPAIGNS.md` (A5)** / **`EMAIL_DELIVERY.md` (A6)** — `ad_campaigns`,
  `campaign_sends`, Resend send pipeline; email engagement feeds their metrics.
- **`INAPP_ADS.md` (A7)** — `featured_placements`; impression/click semantics.
- **`ADVERTISER_CONSOLE.md` (A10)** / **`ADMIN_CRM.md` (A11)** — consumers of the
  aggregate vs. full dashboards defined here.
- **`SCALING_COST.md` (A13)** — owns retention/partition/cost depth; I give the seams.

> Conventions followed (per contract + existing migrations): snake_case; RLS on every
> table; mutations through `SECURITY DEFINER` RPCs with `set search_path = ''`;
> `(select auth.uid())` / `(select public.is_admin())` InitPlan form; extensions live
> in the `extensions` schema. Patterns mirror
> `supabase/migrations/20260711000000_business_accounts.sql`.

---

## 0. Where this fits — the gap we're closing

`src/pages/business/BusinessAnalytics.tsx` today renders review-count/rating KPIs and
ends with a literal placeholder:

> "Listing impressions, 'near me' appearances, and direction taps. **We don't collect
> that telemetry yet** — it lands with the paid analytics add-on."

This doc is the telemetry that closes that box, plus the product-side analytics admins
need and the campaign metrics advertisers get. `PRIVACY_NOTES.md` §5 currently
certifies "no analytics, pixels, trackers, or cookies today." **The pivot deliberately
adds first-party analytics; this design is written so that certification becomes "no
*third-party* analytics, and first-party analytics is consent-gated and stores nothing
non-essential on the device without opt-in" — not a regression into the cookie-banner /
Do-Not-Sell regimes.** See §2 for the exact line.

---

## 1. Principles (non-negotiable)

1. **First-party, in Postgres, no third parties.** Data never leaves to an analytics
   vendor. Nothing here is a "sale" or a "share" (no disclosure to a third party, no
   cross-context behavioral advertising) under Cal. Civ. Code § 1798.140(ad)/(ah), so
   it does **not** falsify the "we do not sell or share" statement A1 relies on. This is
   the whole reason we build it ourselves instead of dropping in GA4/Segment/PostHog.
2. **No PII in `props`.** Event `props` carry IDs and enums only — never email, name,
   username, free-text review bodies, precise coordinates, IPs, or user-agent strings.
   The ingest layer strips/rejects anything outside a per-event allow-list (§5).
3. **Coarse region only.** The only location on an event is a coarse `region` string
   (country, or country + first-level region) derived **server-side** from edge geo —
   never lat/lng, never city-block, never the raw IP. Consistent with the owner's
   "coarse location only" decision and A3.
4. **Consent-first, GPC-honoring.** Identity-linked analytics require the user's
   opt-in and are killed by a GPC or DNT signal (§2). Consent is re-checked **server-side
   at ingest**, not just trusted from the client.
5. **Cheap by construction.** Raw events are short-lived and pre-aggregated by pg_cron
   into small rollup tables; dashboards read rollups, not raw events. Free-tier Postgres
   is **500 MB** — an unbounded event log would blow it, so retention + sampling +
   rollups are load-bearing, not nice-to-have (§8, hand off depth to A13).

---

## 2. The consent line — two tiers (the "analyze the line" deliverable)

The judgment call the task asks for: **which events need opt-in, and which are lawful
as anonymous product telemetry.** ePrivacy consent attaches when you *store or read
information on the user's device* for a non-strictly-necessary purpose, or when you
build a profile; analytics is not "strictly necessary," so identity/device-storage
analytics needs consent. Pure server-side counting that touches no device storage and
attaches no identity is legitimate-interest territory. We split accordingly:

### Tier A — Anonymous aggregate telemetry (no consent required)
- **No `user_id`. No device storage. No session stitching** beyond the single HTTP
  request. Coarse `region` from edge geo only.
- Emitted **server-side** (Edge Functions / RPCs already handling the request) or as a
  fire-and-forget beacon that carries **no client identifier**.
- Answers gross-count questions: total route hits, total searches, total ad impressions,
  email opens/clicks (server-observed), signups-per-day. **Cannot** compute DAU, dwell,
  or per-user funnels (no identity to join on).
- Lawful basis: **legitimate interest** (aggregate service statistics), consistent with
  GDPR Recital 26 (truly aggregate ≠ personal). Still respects GPC by never attaching
  identity in the first place.

### Tier B — Identified session/user analytics (opt-in + not GPC/DNT)
- Uses a **first-party, ephemeral `session_id`** (sessionStorage, per-tab, §5) and, when
  the user is signed in and opted in, the `user_id`.
- Enables DAU/WAU, the signup→consent→first-review funnel, dwell, and admin
  support/audit lookups.
- **Requires** `user_consents.analytics_opt_in = true` (REQUEST TO A2 below) **and** the
  absence of a GPC/DNT signal. If either fails, the client falls back to Tier A (drops
  `session_id` and `user_id`, or emits nothing for events that are meaningless without
  identity).

> **REQUEST TO A2:** add `analytics_opt_in boolean not null default false` to
> `user_consents` (canonical row currently has `marketing_opt_in`, `location_opt_in`,
> `gpc_detected`, `consent_updated_at`, `source`). Rationale: analytics is a *distinct*
> purpose from marketing and from location; bundling consent is a GDPR "granularity"
> problem. Absence/false = Tier A only. If A2/A1 prefer to fold analytics under an
> existing consent, note the mapping and I'll follow — but a separate flag is cleanest.

### GPC / DNT handling (server-authoritative)
- **GPC** (`Sec-GPC: 1` request header / `navigator.globalPrivacyControl === true`) is
  a **mandatory opt-out signal in California** (AG *Sephora* settlement, 2022;
  Cal. Civ. Code § 1798.120(c)) per A1. The `analytics-ingest` Edge Function reads the
  **`Sec-GPC` header on the ingest request itself** — this is authoritative and cannot
  be spoofed away by client JS. On `Sec-GPC: 1` we **force Tier A**: drop `user_id` and
  `session_id`, set `gpc` in the audit, and never attach identity. We also set
  `user_consents.gpc_detected = true` (A1's field) when we see it for a signed-in user.
- **DNT** (`DNT: 1` / `navigator.doNotTrack === "1"`) — the DNT standard is
  **discontinued/deprecated in favor of GPC**; Firefox removed the DNT UI in **v135
  (2025-02-04)**, Safari removed it, Chrome disables it by default. We still honor it as
  a courtesy: `DNT: 1` also forces Tier A. We do **not** rely on it as the primary
  signal (GPC is the meaningful one).
- The client mirrors this so it doesn't even send identified events (defense in depth),
  but the **server decision is the one that counts.**

**Net effect on `PRIVACY_NOTES.md`:** Tier A adds no device storage → **no cookie
banner needed for Tier A**. Tier B's only device storage is a first-party,
per-tab `session_id` in `sessionStorage` that exists **only after the user opts in** —
so it never stores non-essential data without consent. No cookies at all (we never use
`document.cookie`; a session id in a cookie would ride cross-site — we specifically
avoid that). This preserves the "strictly-necessary first-party storage only" posture
A1 documented, plus one consented analytics key.

---

## 3. The `analytics_events` table (A2 owns the DDL — this is what I need)

Canonical shape (from the contract): `id`, `user_id` (nullable/anon), `session_id`,
`event`, `props jsonb`, `occurred_at`, coarse `region`. **A2 owns the DDL.** Reference
shape I depend on, with the extra columns I need called out:

```sql
-- OWNED BY A2 (DATA_MODEL.md). Shown here as the interface A4 consumes; do not
-- treat this as the source of truth for the DDL.
create table public.analytics_events (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),   -- client event time (clamped server-side)
  ingested_at   timestamptz not null default now(),   -- REQUEST TO A2: server receipt time
  event         text        not null,                 -- from the allow-list (§4)
  event_version smallint    not null default 1,        -- REQUEST TO A2: props schema version
  user_id       uuid        references public.profiles (id) on delete set null, -- null in Tier A
  session_id    uuid,                                  -- null in Tier A
  region        text,                                  -- coarse: 'US' or 'US-CA'; server-set (§5)
  surface       text,                                  -- REQUEST TO A2: 'web' | 'email' | 'server'
  props         jsonb       not null default '{}'::jsonb,
  sample_rate   real        not null default 1.0       -- REQUEST TO A2: for scaling counts back up (§8)
);
```

> **REQUEST TO A2 — `analytics_events`:**
> 1. `ingested_at timestamptz not null default now()` — separate server receipt time; we
>    clamp `occurred_at` to `[ingested_at - 48h, ingested_at + 5m]` to defang bad client
>    clocks without losing the real event time.
> 2. `event_version smallint not null default 1` — lets `props` schemas evolve without a
>    migration; rollups switch on it.
> 3. `surface text` (`'web' | 'email' | 'server'`) with a CHECK — cheap partitioning of
>    web vs. email-pixel vs. server-emitted events.
> 4. `sample_rate real not null default 1.0` — so a 0.1-sampled `route_view` still yields
>    an unbiased count (`sum(1/sample_rate)`), see §8.
> 5. **Indexes:** `(event, occurred_at desc)`; a **BRIN** on `occurred_at` (append-only,
>    time-ordered → BRIN is tiny and ideal); partial `(user_id, occurred_at)` where
>    `user_id is not null` for the funnel/support lookups. No index on `props`
>    (we don't filter ad-hoc on raw JSON in production paths; rollups do that once).
> 6. **Partition by month** on `occurred_at` (range) **or** treat it as a rolling
>    retention table (A13 to decide). Monthly partitions make "drop events older than N
>    days" a `DROP TABLE` instead of a `DELETE` — critical on 500 MB free tier.
> 7. **No `updated_at`, no soft-delete** — events are immutable append-only facts.

### RLS for `analytics_events` (request to A2, but here's the exact policy set)
```sql
alter table public.analytics_events enable row level security;

-- Nobody reads raw events directly through PostgREST. Not anon, not authenticated,
-- not even a business. Reads happen ONLY through admin RPCs / rollup views (§6, §7).
-- (No SELECT policy = no rows selectable by anon/authenticated. Admin reads go through
--  SECURITY DEFINER functions that check is_admin() and log the access.)

-- Writes never come straight from the browser either — they go through the ingest
-- RPC (SECURITY DEFINER, §5), which is the only writer. So: no INSERT policy for
-- anon/authenticated; grant EXECUTE on the RPC instead. This prevents a client from
-- forging region/user_id or bypassing the allow-list.
revoke all on public.analytics_events from anon, authenticated;
```

This is stricter than "insert-only RLS": because region must be derived server-side and
the event name must be validated, **the client is never a direct writer.** The RPC is
the throat.

---

## 4. Event taxonomy

Naming: **`object_action`**, snake_case, past-tenseish, stable. `event` is validated
against an allow-list (§5) so typos/junk never enter the table. `props` is a small,
fixed, documented set of keys per event — **IDs and enums only, no PII, coarse region
handled by the column not props.**

| `event` | Tier | When | `props` (all optional unless noted) |
|---|---|---|---|
| `route_view` | B (A if no consent) | SPA route settles | `{ route: '/browse' \| '/bathrooms/:id' \| ... (pattern, not the raw URL), ref?: 'internal'\|'email'\|'external' }` |
| `search` | B/A | user runs a search | `{ has_query: bool, result_count: int, filters?: {wheelchair?:bool, gender_neutral?:bool, changing_table?:bool} }` — **never the query string** (free text = potential PII) |
| `bathroom_view` | B/A | bathroom detail opens | `{ bathroom_id: uuid, from: 'map'\|'browse'\|'search'\|'email'\|'featured', featured: bool }` |
| `directions_tap` | B/A | user taps directions/near-me | `{ bathroom_id: uuid, surface: 'detail'\|'map' }` — this is the "direction taps" the BusinessAnalytics placeholder promised |
| `review_submit` | B | a review is created | `{ bathroom_id: uuid, rating: 1..5, has_photo: bool }` — **no review body** |
| `signup` | B | account created | `{ method: 'password' }` (extend for OAuth later) |
| `consent_change` | B (always logged) | consent toggles | `{ marketing: bool, location: bool, analytics: bool, gpc: bool, source: 'signup'\|'settings'\|'banner' }` — mirrors A1's `user_consents`; the authoritative record is `user_consents`, this is the timeline copy |
| `ad_impression` | A (server) or B | a featured placement renders in view | `{ placement_id: uuid, campaign_id: uuid, surface: 'map'\|'browse'\|'detail', slot: int }` — A7 owns placement semantics |
| `ad_click` | A/B | featured placement clicked | `{ placement_id: uuid, campaign_id: uuid, surface: ... }` |
| `email_open` | A (server, email pixel) | tracking pixel fetched | `{ campaign_id: uuid, edition_id?: uuid }` — keyed by opaque send token, see §9 |
| `email_click` | A (server, redirect) | tracked link followed | `{ campaign_id: uuid, link_id: text }` |
| `campaign_conversion` | B | attributed post-click action | `{ campaign_id: uuid, kind: 'bathroom_view'\|'review'\|'signup'\|'directions', attribution: 'click'\|'view' }` (§9.4) |

Notes:
- **`route` is a *pattern*, not the raw URL** — `/bathrooms/:id`, never
  `/bathrooms/<uuid>?q=<free text>`. Query strings can carry PII; we drop them at the
  client and re-drop at ingest.
- **`search.has_query` not the query text.** Product needs "how often is search used and
  how many results," not what people typed. Storing raw queries risks names/addresses.
- **`ad_impression` volume is the scary one** — every card render. It is **sampled** and
  can run Tier A (server-rendered count) to keep the table small (§8). A7/A5 need
  aggregate reach, not per-user impression rows.

### Props schema, as TypeScript (client-side source of truth, mirrored by the ingest allow-list)
```ts
// src/lib/analytics/events.ts  (spec — A4 hands this to the implementer)
export type AnalyticsEvent =
  | { event: 'route_view';   props: { route: string; ref?: 'internal' | 'email' | 'external' } }
  | { event: 'search';       props: { has_query: boolean; result_count: number;
                                       filters?: Partial<Record<'wheelchair'|'gender_neutral'|'changing_table', boolean>> } }
  | { event: 'bathroom_view';props: { bathroom_id: string; from: 'map'|'browse'|'search'|'email'|'featured'; featured?: boolean } }
  | { event: 'directions_tap';props:{ bathroom_id: string; surface: 'detail'|'map' } }
  | { event: 'review_submit';props: { bathroom_id: string; rating: 1|2|3|4|5; has_photo: boolean } }
  | { event: 'signup';       props: { method: 'password' } }
  | { event: 'consent_change';props:{ marketing: boolean; location: boolean; analytics: boolean; gpc: boolean;
                                       source: 'signup'|'settings'|'banner' } }
  | { event: 'ad_impression';props: { placement_id: string; campaign_id: string; surface: 'map'|'browse'|'detail'; slot: number } }
  | { event: 'ad_click';     props: { placement_id: string; campaign_id: string; surface: 'map'|'browse'|'detail' } }
  | { event: 'campaign_conversion'; props: { campaign_id: string; kind: 'bathroom_view'|'review'|'signup'|'directions';
                                             attribution: 'click'|'view' } };
// email_open / email_click are emitted server-side (§9), not from this client type.
```

---

## 5. Capture — the client helper + the ingest path

### 5.1 `trackEvent` — batching client helper (spec)

Design goals: batch to minimize requests; never block the UI; drop cleanly under
GPC/DNT/no-consent; survive tab close; carry no PII; hold the `session_id`
ephemerally. Sketch (`src/lib/analytics/track.ts`):

```ts
import { supabase } from '@/lib/supabase';

// --- consent + signal gate (Tier A vs Tier B) -------------------------------
type Mode = 'off' | 'anon' | 'identified';
function analyticsMode(consent: { analytics_opt_in: boolean }): Mode {
  // GPC/DNT are hard opt-outs of identity. navigator.globalPrivacyControl reflects
  // the Sec-GPC header; doNotTrack is the deprecated courtesy signal.
  const gpc = (navigator as any).globalPrivacyControl === true;
  const dnt = navigator.doNotTrack === '1' || (window as any).doNotTrack === '1';
  if (gpc || dnt) return 'anon';                 // never attach identity
  if (consent.analytics_opt_in) return 'identified';
  return 'anon';                                 // default: aggregate only, no identity
}

// --- ephemeral first-party session id ---------------------------------------
// sessionStorage: per-tab, cleared on tab close, NEVER a cookie (so it can't ride
// cross-site), rotates after 30 min idle, random (no fingerprint). Only created in
// 'identified' mode — Tier A carries no id at all.
const SID_KEY = 'wl_sid';
const SID_TS  = 'wl_sid_ts';
function sessionId(mode: Mode): string | null {
  if (mode !== 'identified') return null;
  const now = Date.now();
  const last = Number(sessionStorage.getItem(SID_TS) ?? 0);
  let sid = sessionStorage.getItem(SID_KEY);
  if (!sid || now - last > 30 * 60_000) sid = crypto.randomUUID();
  sessionStorage.setItem(SID_KEY, sid);
  sessionStorage.setItem(SID_TS, String(now));
  return sid;
}

// --- batch buffer ------------------------------------------------------------
type Queued = { event: string; props: Record<string, unknown>; occurred_at: string };
let buffer: Queued[] = [];
let timer: number | undefined;
const FLUSH_MS = 5_000;
const MAX_BATCH = 25;

// Per-event client-side sampling (server also samples; see §8). Keep rare/valuable
// events at 1.0; sample floods.
const SAMPLE: Record<string, number> = { route_view: 0.5, ad_impression: 0.1 };

export function trackEvent(e: AnalyticsEvent, consent: { analytics_opt_in: boolean }) {
  const mode = analyticsMode(consent);
  if (mode === 'off') return;
  // events meaningless without identity are skipped in anon mode
  if (mode === 'anon' && IDENTITY_REQUIRED.has(e.event)) return;
  if (Math.random() > (SAMPLE[e.event] ?? 1)) return;         // sampled out
  buffer.push({ event: e.event, props: e.props as any, occurred_at: new Date().toISOString() });
  if (buffer.length >= MAX_BATCH) flush(mode);
  else if (timer === undefined) timer = window.setTimeout(() => flush(mode), FLUSH_MS);
}

async function flush(mode: Mode) {
  window.clearTimeout(timer); timer = undefined;
  const batch = buffer; buffer = [];
  if (batch.length === 0) return;
  const body = JSON.stringify({ events: batch, sid: sessionId(mode) });   // NO region, NO ip — server derives
  // Prefer sendBeacon so the batch survives navigation/tab close; fall back to fetch
  // with keepalive. Auth: the user's JWT rides via the Supabase functions client.
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analytics-ingest`;
  const blob = new Blob([body], { type: 'application/json' });
  if (!navigator.sendBeacon?.(url, blob)) {
    await fetch(url, { method: 'POST', body, keepalive: true,
      headers: { 'content-type': 'application/json',
                 authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}` } });
  }
}

// flush on page hide so we don't lose the tail of a session
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush('identified'); });

const IDENTITY_REQUIRED = new Set(['review_submit','signup','consent_change','campaign_conversion']);
```

Key points:
- **The client sends no region and no IP.** The server derives coarse region (below).
- **`session_id` is client-generated but the server decides whether to keep it** (it is
  dropped on `Sec-GPC: 1`). It's a UUID, not a fingerprint, per-tab, non-persistent.
- **Batched + `sendBeacon`** → at most ~1 request / 5 s / tab, and the tail survives
  navigation. This keeps request volume (and Supabase egress) low.
- **Sampling** happens client-side (cheap) and is recorded so counts scale back up.

### 5.2 `analytics-ingest` Edge Function (the throat)

Why an Edge Function and not a bare PostgREST insert: only the edge sees the request IP
and the `Sec-GPC` header, and we want **region derived server-side, GPC honored
server-side, and the event allow-list enforced server-side** — none of which a client
can be trusted to do. Mirrors the existing `supabase/functions/notify-access-request`
deployment pattern.

Responsibilities, in order:
1. **Read `Sec-GPC` (and `DNT`) request headers.** If `Sec-GPC: 1` → force anon: null
   out `sid`, ignore any `user_id` from the JWT.
2. **Derive coarse `region`** from edge geo — **Cloudflare `CF-IPCountry`** header if the
   function sits behind Cloudflare, else a bundled **MaxMind GeoLite2-Country/City**
   lookup (free; A3's pick). Output is `'US'` or `'US-CA'` granularity — **country or
   country+region, never city-block, never lat/lng, and the raw IP is never stored.**
3. **Resolve identity:** `user_id` from the verified Supabase JWT (never from the body).
   In anon mode, `user_id = null`.
4. **Validate** each event against the allow-list: known `event` name, `props` keys ⊆
   the event's allow-list, value types/ranges OK, total `props` size < 2 KB, batch ≤ 50.
   **Reject unknown keys and coerce/strip** — this is the PII backstop (e.g. a stray
   `email` key never lands).
5. **Rate-limit** per `user_id`/IP (token bucket, e.g. 240 events/min) to blunt flooding
   — coordinate the shared limiter with `docs/ops/RATE_LIMITING.md` / A12.
6. **Insert** via the RPC below (service role), stamping `region`, `ingested_at`,
   `surface = 'web'`, and clamping `occurred_at`.

### 5.3 The write RPC (SECURITY DEFINER — request the DDL from A2, spec here)
```sql
-- Called only by the ingest Edge Function (service role). Not granted to anon/authenticated.
create or replace function public.track_events(
  p_events   jsonb,     -- [{event, props, occurred_at}, ...] already validated by the edge fn
  p_user_id  uuid,      -- from verified JWT, or null (anon / GPC)
  p_session  uuid,      -- or null (anon / GPC)
  p_region   text,      -- coarse, server-derived
  p_surface  text default 'web'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  -- Re-check consent server-side for Tier B: if this user hasn't opted in, strip identity.
  if p_user_id is not null
     and not exists (select 1 from public.user_consents c
                     where c.user_id = p_user_id and c.analytics_opt_in) then
    p_user_id := null;
    p_session := null;
  end if;

  insert into public.analytics_events (occurred_at, event, user_id, session_id, region, surface, props, sample_rate)
  select
    -- clamp bad client clocks to a sane window around receipt time
    greatest(now() - interval '48 hours',
             least(now() + interval '5 minutes', coalesce((e->>'occurred_at')::timestamptz, now()))),
    e->>'event',
    p_user_id, p_session, p_region, p_surface,
    coalesce(e->'props', '{}'::jsonb),
    coalesce((e->>'sample_rate')::real, 1.0)
  from jsonb_array_elements(p_events) e
  where e->>'event' in (   -- allow-list, second line of defense after the edge fn
    'route_view','search','bathroom_view','directions_tap','review_submit','signup',
    'consent_change','ad_impression','ad_click','email_open','email_click','campaign_conversion');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.track_events(jsonb, uuid, uuid, text, text) from public;
-- grant execute only to the service role used by the Edge Function.
```

**Fallback if we ever skip the Edge Function** (e.g. an emergency direct path): a bare
`insert`-only RLS policy could let authenticated clients write their own rows
(`with check (user_id = (select auth.uid()) or user_id is null)`), but then region can't
be server-derived and the allow-list can't be enforced — so we **do not** ship that as
the primary path. The Edge Function is the design.

---

## 6. What advertisers see vs. what admins see

| | **Advertiser (business member)** | **Admin (`is_admin()`)** |
|---|---|---|
| Scope | **Only their own campaigns** (`ad_campaigns.business_id` they belong to) | Everything |
| Grain | **Aggregate only** — reach, impressions, opens, clicks, CTR, conversions, by day/region-bucket | Aggregate **and** (for support/audit) raw event lookup |
| Individuals | **Never** — no user ids, no per-user rows, no locations | Can look up a user's own stream for support/audit — **logged** |
| Small counts | **Suppressed** (< k, e.g. `< 5`) to prevent re-identification | Seen |
| Mechanism | `SECURITY DEFINER` RPCs gated by `is_business_member(business_id)`, reading **rollups** not raw events | RPCs/views gated by `is_admin()` |

- **Advertiser aggregates never touch `analytics_events` directly.** They read the
  campaign rollups (§7) and `campaign_sends` counters (§9), both already aggregate.
  Featured-placement impression/click counts come from a `placement_daily` rollup keyed
  by `campaign_id`.
- **k-anonymity floor:** advertiser-facing RPCs return `null`/"—" for any bucket with
  fewer than **5** distinct users, so "reach in region X = 1" can't finger a person.
  (Reach is *distinct users*, computed inside the definer function; the advertiser only
  ever gets the number, gated on the floor.)
- **Admin raw lookups are audited.** Any admin call that returns a specific user's events
  writes a `moderation_actions` row (`action = 'view_user_analytics'`, `detail` = the
  target + reason), reusing the existing audit table. **REQUEST TO A2:** add
  `'view_user_analytics'` to the `moderation_actions_action_check` CHECK list.

Advertiser RPC sketch (aggregate, own-campaign, k-floored):
```sql
create or replace function public.campaign_metrics(p_campaign_id uuid)
returns table (day date, reach int, impressions bigint, opens bigint, clicks bigint,
               ctr numeric, conversions bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- authz: caller must belong to the business that owns this campaign
  if not exists (
    select 1 from public.ad_campaigns a
    where a.id = p_campaign_id and public.is_business_member(a.business_id)
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select d.day,
         case when d.reach < 5 then null else d.reach end,   -- k-anonymity floor
         d.impressions, d.opens, d.clicks,
         case when d.impressions > 0 then round(d.clicks::numeric / d.impressions, 4) end,
         d.conversions
  from public.campaign_daily d
  where d.campaign_id = p_campaign_id
  order by d.day;
end;
$$;
grant execute on function public.campaign_metrics(uuid) to authenticated;
```

---

## 7. Dashboards — metrics + SQL

Dashboards read **rollups**, never raw `analytics_events`. Two admin-facing rollup
tables plus per-campaign rollups, all refreshed by **pg_cron** (available on this
project per the contract). Rollup *tables* (upserted incrementally) beat materialized
views here because `REFRESH MATERIALIZED VIEW` recomputes the whole thing every run,
whereas an incremental `insert … on conflict … do update` only touches recent days —
cheaper on the free tier. (A13 owns the depth/tradeoff.)

### 7.1 Rollup tables (request DDL from A2; defined here)
```sql
-- Product rollup: one row per (day, event, region_bucket).
create table public.analytics_daily (
  day          date not null,
  event        text not null,
  region       text,                          -- coarse
  events       bigint not null,               -- sum(1/sample_rate), unbiased count
  users        bigint not null default 0,     -- distinct user_id (Tier B only)
  sessions     bigint not null default 0,     -- distinct session_id
  primary key (day, event, coalesce(region, ''))
);

-- Campaign rollup: one row per (day, campaign). Feeds both advertiser + admin views.
create table public.campaign_daily (
  campaign_id  uuid not null,
  day          date not null,
  reach        int  not null default 0,       -- distinct users reached that day
  impressions  bigint not null default 0,
  opens        bigint not null default 0,
  clicks       bigint not null default 0,
  conversions  bigint not null default 0,
  primary key (campaign_id, day)
);
```

### 7.2 The pg_cron rollup job (runs a few minutes past the hour; re-does last 2 days)
```sql
-- Idempotent: recompute the trailing window so late-arriving events (email pixels,
-- offline beacons) are captured. ON CONFLICT makes reruns safe.
create or replace function public.roll_up_analytics()
returns void language sql security definer set search_path = '' as $$
  insert into public.analytics_daily (day, event, region, events, users, sessions)
  select date_trunc('day', occurred_at)::date, event, region,
         sum(1.0 / greatest(sample_rate, 0.0001))::bigint,
         count(distinct user_id),
         count(distinct session_id)
  from public.analytics_events
  where occurred_at >= (current_date - 2)
  group by 1, 2, 3
  on conflict (day, event, coalesce(region, '')) do update
    set events = excluded.events, users = excluded.users, sessions = excluded.sessions;
$$;

-- schedule (pg_cron): every hour at :07
select cron.schedule('roll_up_analytics', '7 * * * *', $$select public.roll_up_analytics();$$);
```
(An analogous `roll_up_campaigns()` populates `campaign_daily` from `campaign_sends` +
the `ad_impression`/`ad_click`/`email_*`/`campaign_conversion` events.)

### 7.3 Key metrics (SQL over the rollups)

**DAU / WAU / MAU** (identified activity; Tier B):
```sql
-- DAU for a day
select users as dau from public.analytics_daily where day = current_date and event = 'route_view';
-- WAU / MAU: distinct users need raw or a HLL sketch; on free tier just approximate from
-- the funnel table, or keep a weekly rollup. Exact distinct over 30 days:
select count(distinct user_id) as mau
from public.analytics_events
where occurred_at >= current_date - 30 and user_id is not null;
```
> Note: `count(distinct user_id)` over 30 days of raw events is the one query that still
> reads raw rows. If retention is < 30 days, keep a **weekly `user_active` rollup**
> (`(week, user_id)` unique) so MAU is a cheap count. Flag for A13 (HLL/`postgres_hll`
> is the scale answer).

**Funnel: signup → consent → first review** (per weekly cohort):
```sql
with cohort as (
  select user_id, min(occurred_at) as signed_up
  from public.analytics_events where event = 'signup' group by user_id
),
consented as (   -- authoritative source is user_consents, joined for accuracy
  select user_id, consent_updated_at as consented_at
  from public.user_consents where analytics_opt_in or marketing_opt_in
),
first_review as (
  select user_id, min(occurred_at) as first_review_at
  from public.analytics_events where event = 'review_submit' group by user_id
)
select date_trunc('week', c.signed_up)::date         as cohort_week,
       count(*)                                        as signups,
       count(con.user_id)                              as gave_consent,
       count(fr.user_id)                               as wrote_first_review,
       round(100.0 * count(con.user_id) / nullif(count(*),0), 1) as consent_pct,
       round(100.0 * count(fr.user_id)  / nullif(count(*),0), 1) as activation_pct
from cohort c
left join consented con on con.user_id = c.user_id
left join first_review fr on fr.user_id = c.user_id and fr.first_review_at >= c.signed_up
group by 1 order by 1 desc;
```

**Campaign performance** (admin, all; advertiser gets the k-floored slice via §6):
```sql
select campaign_id,
       sum(reach)        as reach,
       sum(impressions)  as impressions,
       sum(opens)        as opens,
       sum(clicks)       as clicks,
       round(sum(clicks)::numeric / nullif(sum(impressions),0), 4) as ctr,
       sum(conversions)  as conversions
from public.campaign_daily
group by campaign_id order by reach desc;
```

**Email deliverability / open / click** (from `campaign_sends`, §9):
```sql
select s.campaign_id,
       count(*)                                            as sent,
       count(*) filter (where s.status = 'delivered')      as delivered,
       count(*) filter (where s.status in ('bounced','complained')) as failed,
       count(*) filter (where s.opened_at is not null)     as opened,
       count(*) filter (where s.first_clicked_at is not null) as clicked,
       round(100.0 * count(*) filter (where s.opened_at is not null)
             / nullif(count(*) filter (where s.status='delivered'),0), 1) as open_rate,
       round(100.0 * count(*) filter (where s.first_clicked_at is not null)
             / nullif(count(*) filter (where s.status='delivered'),0), 1) as click_rate
from public.campaign_sends s
group by s.campaign_id;
```

**Top regions** (coarse, product-wide):
```sql
select region, sum(events) as hits, sum(users) as users
from public.analytics_daily
where day >= current_date - 30 and event = 'route_view' and region is not null
group by region order by hits desc limit 20;
```

---

## 8. Sampling, retention, cost (seams for A13)

- **Free-tier reality:** 500 MB Postgres, 5 GB egress, 50k MAU on Supabase free
  (verified July 2026). A single `analytics_events` row is ~150–250 B; unsampled
  `route_view` + `ad_impression` at even modest traffic fills 500 MB fast. So:
  - **Sample floods** client-side and record `sample_rate`; scale counts back up in the
    rollup with `sum(1/sample_rate)` (unbiased). Keep valuable/rare events at 1.0
    (`signup`, `review_submit`, `consent_change`, `campaign_conversion`).
  - **Short raw retention** (e.g. **30–45 days**), then the row is gone — dashboards live
    on rollups, which are tiny (one row per day×event×region). Monthly partitions make
    expiry a `DROP TABLE`.
  - **Batched `sendBeacon`** keeps request count and egress down.
- **pg_cron** does the rollups and the retention drop; `pg_net` is available if any push
  is ever needed. **A13 owns the depth** (partition cadence, `postgres_hll` for cheap
  distinct-user counts, exact retention windows, archival to R2 if ever needed).

---

## 9. Email engagement tracking (open pixel + click redirect)

Email is where "analytics" is most privacy-sensitive, so this section is deliberately
explicit. All email engagement is **Tier A / server-observed** (the recipient's mail
client makes the request; there is no browser session), and it is only ever sent to
users who are **already opted into marketing** (`user_consents.marketing_opt_in`, checked
at send time per A1/A6). It writes to **`campaign_sends` counters** (the canonical
"powers advertiser reach counts") and mirrors into `analytics_events` for the unified
funnel.

### 9.1 The opaque send token
Every `campaign_sends` row gets a **random, single-purpose `send_token uuid`** (distinct
from `unsubscribe_token`). The pixel/redirect URLs carry only this token — never an
email, user id, or campaign id in the clear.

> **REQUEST TO A2 — `campaign_sends`** (canonical row today: `campaign_id`, `user_id`,
> `sent_at`, `channel`, `status`, `unsubscribe_token`). Add:
> - `send_token uuid not null default gen_random_uuid()` (unique) — pixel/redirect key.
> - `opened_at timestamptz`, `open_count int not null default 0`.
> - `first_clicked_at timestamptz`, `click_count int not null default 0`.
> - `last_event_region text` — coarse region of the last open/click (product only).
>
> Optional granular table (admin-only, for per-link detail / debugging), if A6/A11 want
> it: `campaign_send_events (send_token, kind 'open'|'click', link_id, occurred_at,
> region)`. Otherwise the counters above are enough for all dashboards.

### 9.2 Open pixel
- Email HTML embeds `<img>` from an Edge Function:
  `https://watrloo.com/e/o/<send_token>.gif` (served via the function; can be fronted by
  Cloudflare). The function:
  1. Looks up the `campaign_sends` row by `send_token`.
  2. Records the open: `open_count += 1`, set `opened_at = coalesce(opened_at, now())`,
     `last_event_region = <coarse region from edge geo>`; emit an `email_open` event
     (`surface = 'email'`, `user_id` = the send's user, coarse region, **no IP, no
     user-agent stored**).
  3. Returns a **1×1 transparent GIF** with `Cache-Control: no-store` so re-opens
     re-count (subject to the caveats below).
- Rate/dedup: cap `open_count` increments (e.g. ignore repeats within 2 s) to avoid
  prefetch double-counting.

### 9.3 Click redirect
- Every link in the email is rewritten to
  `https://watrloo.com/e/c/<send_token>?l=<link_id>&s=<sig>` where `link_id` indexes the
  campaign's stored creative links and `sig` is an HMAC over `(send_token, link_id)`.
  The function:
  1. **Validates `sig`** and that `link_id` maps to a link **stored on the campaign's
     creative** — this is an **open-redirect guard**: we only ever 302 to an allow-listed
     destination (watrloo.com or the advertiser's stored link), never to an arbitrary
     `?url=` from the query. (Open redirectors are a classic phishing vector.)
  2. Records the click: `click_count += 1`,
     `first_clicked_at = coalesce(first_clicked_at, now())`; emit `email_click`
     (coarse region, no IP/UA). A click also implies delivery+open, so it backfills
     `opened_at` if unset.
  3. **302** to the resolved target.

### 9.4 Attribution → `campaign_conversion`
When a click redirect lands the user in-app, the redirect appends a transient
`?c=<campaign_id>` that the client stashes in `sessionStorage` for the tab. If the user
then performs a valued action within an attribution window (default **7 days** for
click-through; conversions from mere `ad_impression`/`email_open` use a shorter
**1-day view-through** and are labeled `attribution:'view'`), `trackEvent` emits
`campaign_conversion { campaign_id, kind, attribution }`. `roll_up_campaigns()` counts
these into `campaign_daily.conversions`.

### 9.5 Privacy assessment of open-tracking (the part to be honest about)
- **Open pixels are the canonical invisible tracker.** Under GDPR/ePrivacy, open
  tracking generally needs a lawful basis; here the basis is that the message itself is
  **consented marketing** (opt-in, CAN-SPAM sender/address/one-click-unsubscribe per
  A1/A6), the pixel carries **no third party**, stores **no IP/UA/precise location**, and
  the token is **single-purpose and per-send**. That is a defensible, minimal design —
  but it is still tracking, so:
- **Opens are unreliable and must be de-emphasized.** **Apple Mail Privacy Protection**
  pre-fetches all remote images from Apple proxies, inflating "opens" and hiding real IP
  — so `open_rate` is a soft, upward-biased signal. Many clients block images by default,
  under-counting the other way. **We treat clicks (and conversions) as the trustworthy
  engagement metric and label opens as indicative only** in both the advertiser and admin
  UIs.
- **User control.** A recipient who blocks images simply doesn't record an open — no
  degraded experience, no dark pattern. Unsubscribe (one-click, honored at send time via
  `email_suppressions`) is the real off-switch and lives with A6. We do **not** need a
  browser GPC check here (there is no browser in the loop); the consent lever is
  `marketing_opt_in` + suppression, checked at send time, not send-then-check.
- **No open-tracking for non-marketing / transactional mail.** Confirmation and
  system emails carry no pixel. Tracking rides only on consented promotional sends.

### 9.6 Relationship to Resend's native events (defer mechanism to A6)
Resend can itself emit `email.sent/delivered/bounced/complained/opened/clicked` webhooks
(open/click tracking is a domain-level toggle). Two viable wirings, A6's call:
1. **First-party pixel/redirect (this section)** for opens/clicks + **Resend webhooks**
   for the delivery-lifecycle states (`delivered`, `bounced`, `complained`) that only the
   sender can know. This keeps engagement first-party and still gets authoritative
   bounce/complaint data to drive `email_suppressions`.
2. Rely on Resend's open/click tracking entirely — simpler, but engagement then rides on
   Resend's tracking domain rather than ours. **Recommendation: option 1** — it keeps
   engagement first-party (our stated principle) while using Resend only for the
   deliverability states it uniquely observes. Either way, the **counters land on
   `campaign_sends`** and dashboards don't change.

---

## 10. Seams for A14 (integration surface)

- **Tables (A2 owns DDL):** `analytics_events` (+ requested columns), `analytics_daily`,
  `campaign_daily`; requested additions to `campaign_sends` and `user_consents`
  (`analytics_opt_in`); optional `campaign_send_events`; new `moderation_actions.action`
  value `'view_user_analytics'`.
- **RPCs:** `track_events()` (service-role writer), `campaign_metrics(campaign_id)`
  (advertiser, k-floored), admin rollup readers, `roll_up_analytics()` /
  `roll_up_campaigns()` (cron), `admin_user_events()` (audited support lookup).
- **Edge Functions:** `analytics-ingest` (batch write, region, GPC, allow-list),
  `e/o/<token>.gif` (open pixel), `e/c/<token>` (click redirect) — the last two coordinate
  with A6's send pipeline.
- **Client:** `src/lib/analytics/{events.ts,track.ts}` (`trackEvent`), wired into the
  router (`route_view`), search, bathroom detail, review submit, signup, consent, and
  A7's placement components (`ad_impression`/`ad_click`).
- **Cron:** hourly `roll_up_analytics` / `roll_up_campaigns`; daily retention drop
  (A13 owns cadence).
- **Consumers:** A10 advertiser console (aggregate campaign metrics), A11 admin CRM
  (full product analytics + audited user lookup), the existing
  `BusinessAnalytics.tsx` placeholder (impressions/directions/near-me).

## 11. Open questions / requests summary
1. **REQUEST TO A2:** `user_consents.analytics_opt_in` (§2); `analytics_events`
   `ingested_at`/`event_version`/`surface`/`sample_rate` + indexes + partitioning (§3);
   `campaign_sends` engagement columns + `send_token` (§9.1); `moderation_actions` action
   value `'view_user_analytics'` (§6); rollup tables `analytics_daily`/`campaign_daily`
   (§7).
2. **A1:** confirm the Tier A "anonymous aggregate telemetry under legitimate interest,
   no device storage, no identity" line is acceptable for the v2 policy, and that a
   *separate* analytics consent (not bundled with marketing) is the granular-consent
   posture they want. Confirm GPC/DNT → force-anon is the intended honoring.
3. **A3:** the coarse `region` string format (`'US'` vs `'US-CA'`) and the shared IP→geo
   source (CF header vs GeoLite2) so analytics and location agree.
4. **A6:** which email-engagement wiring (§9.6 option 1 vs 2); who owns the pixel/redirect
   Edge Functions vs. the send pipeline.
5. **A13:** exact retention window, partition cadence, and the distinct-user counting
   strategy (`postgres_hll`) — this doc assumes 30–45 day raw retention and hourly
   rollups as a starting point.

---

### Sources
- Global Privacy Control — spec & platform signal:
  [W3C GPC](https://www.w3.org/TR/gpc/),
  [MDN `Sec-GPC` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-GPC),
  [MDN `Navigator.globalPrivacyControl`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/globalPrivacyControl).
  California treats GPC as a mandatory opt-out (AG *Sephora* settlement; Cal. Civ. Code
  § 1798.120(c)) — see `docs/legal/PRIVACY_NOTES.md` / A1.
- Do Not Track — deprecated in favor of GPC; Firefox removed the DNT UI in v135
  (2025-02-04), Safari removed it, Chrome off by default:
  [MDN `Navigator.doNotTrack`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/doNotTrack),
  [MDN `DNT` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/DNT).
- Resend webhook events (delivery/open/click; open/click tracking is a domain toggle):
  [Resend webhooks](https://resend.com/docs/webhooks/introduction),
  [Capture email events with Webhooks](https://resend.com/blog/webhooks).
- Supabase free-tier limits (500 MB DB, 5 GB egress, 50k MAU; projects pause after 1 wk
  idle), verified July 2026:
  [Supabase pricing](https://supabase.com/pricing),
  [Supabase billing docs](https://supabase.com/docs/guides/platform/billing-on-supabase).
  Depth deferred to `SCALING_COST.md` (A13).
- Apple Mail Privacy Protection inflates opens / hides IP — rationale for de-emphasizing
  open rate (see §9.5); mechanism documented widely, confirm specifics with A6.
```
