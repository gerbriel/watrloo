# Plausible + Umami — cookieless reach & frequency capping for Watrloo

Research for: unique reach + frequency capping without user profiles or cookies, on a
lean Postgres event pipeline (Supabase). Sources: Plausible's public docs/marketing
pages (`plausible.io/data-policy`, `plausible.io/cookieless-web-analytics`) — **AGPL
repo was deliberately not fetched**, since the technique is fully documented publicly
and copying AGPL source is the one licensing trap worth avoiding by construction —
and `umami-software/umami` (MIT), whose actual source was pulled via `gh api` (schema,
session/visit-id hashing, IP-header parsing, ingest route, one aggregation query).
Cross-checked against this repo's existing `docs/growth/*` design docs, which already
have real infrastructure decisions load-bearing for §2 below.

---

## 1. The rotating-salt design, precisely (Plausible)

**The formula, as Plausible states it themselves:**

> `hash(daily_salt + website_domain + ip_address + user_agent)`

- **`daily_salt`** — a random string, generated fresh and **rotated and deleted every
  24 hours**. Plausible's public docs do not disclose the generation mechanism, storage
  location, or whether it ever touches disk — only the rotation/deletion cadence.
- **`website_domain`** — namespaces the hash per tracked site, so the same visitor
  hitting two different Plausible-tracked sites on the same day gets two unrelated
  hashes (no cross-site linkage from the hash itself).
- **`ip_address`** — used only as hash input; **the raw IP is never stored** in logs,
  database, or on disk.
- **`user_agent`** — same treatment: consumed by the hash, then discarded.

**Rotation cadence:** every 24 hours (day boundary, not a rolling 24h window). Old
salts are deleted at rotation, which is the actual privacy mechanism — even Plausible
itself cannot recompute yesterday's hash for a given IP+UA once the salt is gone,
because the hash is one-way and the input needed to reproduce it no longer exists.

**What breaks at day boundaries (Plausible's own stated tradeoff):**
- A visitor active both just before and just after midnight is **hashed twice** (two
  different daily salts → two different hashes → counted as two unique visitors that
  day-pair), even though it's one person. Plausible frames this as a *feature*, not a
  bug: "this approach prevents tracking users across days while still providing useful
  aggregate analytics" — the inability to link across days **is** the privacy
  guarantee, not a side effect to minimize.
- The public pages do not quantify the resulting error margin, nor do they address:
  - **Shared/carrier-grade NAT or corporate proxies** — many real visitors behind one
    IP collapse toward fewer hashes if their UA strings also collide (undercount).
  - **VPNs / mobile network handover** — a phone roaming between cell towers can get a
    new IP mid-session, changing the hash mid-day and creating a phantom second
    "visitor" (overcount) — the mirror image of the NAT case.
  - **Multi-device / multi-browser same person** — different UA per device/browser
    means the same human is legitimately multiple hashes, by design (Plausible has
    never claimed to solve device graphing — this would require exactly the persistent
    cross-context identifier privacy-first tools refuse to build).
- Net: this is a **statistical estimation technique**, not a precise headcount. It
  trades a bounded, self-admitted day-boundary/NAT/roaming error for the much larger
  win of "no persistent identifier exists anywhere, ever." That framing — approximate
  but non-invasive — is the right one to import into Watrloo's design in §2; it
  matches the "aggregate reach is an estimate" posture Watrloo's own `CAMPAIGNS.md`
  §2.3 and `ANALYTICS.md` §8 already take for other numbers (sampling, k-anonymity
  floors).

**Licensing note (expanded in §4):** `plausible/analytics` is AGPLv3. Everything above
came from `plausible.io/data-policy` and `plausible.io/cookieless-web-analytics` —
public marketing/docs pages, not the source tree. That was a deliberate choice: the
technique is fully specified by the prose formula above, so there was no need to open
AGPL code and risk unconsciously reproducing it later in a plpgsql/Edge Function
implementation, which would be exactly the failure mode AGPL is designed to catch.

---

## 2. Adaptation to Supabase

### 2.1 The constraint that changes everything: the anon key is public

Plausible's salt lives inside a backend the public internet never talks to directly —
every request goes through their own ingest service, which is the only thing that ever
sees the salt. Watrloo's `anon` key, by contrast, is **embedded in the shipped JS
bundle** and is designed to be used for direct `supabase-js` calls from the browser.
Two consequences that don't exist for Plausible:

1. **The salt must never be a query parameter, a client-visible column, or anything
   returned by any RPC.** If it's ever computable client-side, the whole scheme
   collapses to "no salt" — anyone can rehash themselves out of the cap.
2. **The client cannot be trusted to report its own IP or the day.** A direct
   PostgREST call (or an Edge Function call) must derive both from **request context
   Watrloo's own infrastructure observes**, never from a request body field — same
   doctrine `ANALYTICS.md` §5.2 already uses for `analytics-ingest` ("only the edge
   sees the request IP... none of which a client can be trusted to do").

This repo's own `ARCHITECTURE.md` (Decision D4) already confirms the sharper version
of the general PostgREST-can't-see-IP problem the task flagged: **the SPA is hosted on
GitHub Pages, not behind Cloudflare**, so `CF-IPCountry`/`cf-connecting-ip` are **not**
available unless Cloudflare is explicitly put in front of the Supabase endpoints (an
idea `ad-ideas/10-privacy.md` #4 floats but hasn't shipped). That leaves
`x-forwarded-for` as the only realistic signal today.

### 2.2 What Supabase actually exposes to RPCs — confirmed, with a correction

Per Supabase's own docs (`supabase.com/docs/guides/api/securing-your-api`), PostgREST
RPCs and RLS policies can read the whole header set inside the function body via
`current_setting()`:

```sql
-- all headers, as json
select current_setting('request.headers', true)::json;
-- one header (works on Postgres 14+ back-compat form Supabase documents)
select current_setting('request.headers', true)::json ->> 'user-agent';
```

Supabase's docs give this exact worked example for extracting the caller's IP from
`x-forwarded-for`:

```sql
select split_part(
  current_setting('request.headers', true)::json ->> 'x-forwarded-for',
  ',', 1
);
```

**That example is dangerous to copy verbatim.** An open, unresolved Supabase GitHub
discussion (`orgs/supabase/discussions/34647`, "Is `x-forwarded-for` safe?") shows a
user directly confirming that a client calling a PostgREST RPC with the public anon key
can **inject their own `x-forwarded-for` header**, and Supabase's gateway does not
strip it — it **appends** the real client IP after whatever the client sent:
`x-forwarded-for: <attacker-supplied>, <real-ip>`. `split_part(..., ',', 1)` (Supabase's
own docs example) returns the **attacker-controlled first hop**, not the real IP. The
real IP is the **last** comma-separated element:

```sql
-- last element, not first — the client can prepend forged hops, but (per the observed
-- behavior above) cannot make Supabase's own gateway drop the hop it appends itself.
select trim(
  (regexp_split_to_array(
     current_setting('request.headers', true)::json ->> 'x-forwarded-for', ','
  ))[array_length(
       regexp_split_to_array(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ','),
       1)]
);
```

Caveats to carry forward, stated plainly rather than glossed over:
- This "real IP is always the last hop" behavior is an **empirical community
  observation, not a documented Supabase guarantee** — no Supabase staff response
  confirms it in that thread. Treat it as best-effort, not load-bearing.
- A separate report (Supabase Edge Functions discussion #7884) notes `x-forwarded-for`
  is **sometimes just empty** — observed roughly half the time in one user's testing.
  Any design here has to degrade gracefully when the header is missing entirely, not
  just when it's spoofed.
- This repo already made the load-bearing call implicitly: `ANALYTICS.md`/`LOCATION.md`
  route IP-dependent logic through an **Edge Function** (`ip-geo`, `analytics-ingest`)
  rather than a bare PostgREST RPC, specifically because "only the edge sees the
  request IP." The visitor-hash RPC should follow the same doctrine — see §2.4.

### 2.3 Salt storage: a locked table, never a client-visible column

```sql
-- Mirrors the house convention: extensions live in `extensions`, not public
-- (ANALYTICS.md's stated convention; pgcrypto already enabled in this project).
create table public.ad_visitor_salt (
  salt_day date primary key,
  salt     text not null default encode(extensions.gen_random_bytes(32), 'hex')
);

alter table public.ad_visitor_salt enable row level security;
-- No SELECT/INSERT/UPDATE policy for anon or authenticated, at all. Only
-- SECURITY DEFINER functions (below) ever read this table. Matches the
-- `analytics_events` doctrine in ANALYTICS.md §3: "no SELECT policy = no rows
-- selectable by anon/authenticated."
revoke all on public.ad_visitor_salt from anon, authenticated;

-- pg_cron: pre-create tomorrow's salt and prune anything older than 2 days.
-- The 2-day (not 1-day) retention gives a grace window for events whose client
-- clock is skewed across midnight — same clamping instinct ANALYTICS.md §3 uses
-- for `occurred_at` — without ever letting a salt live long enough to become a
-- de-facto multi-day identifier.
select cron.schedule(
  'rotate_ad_visitor_salt', '0 0 * * *',
  $$
    insert into public.ad_visitor_salt (salt_day) values (current_date + 1)
      on conflict (salt_day) do nothing;
    delete from public.ad_visitor_salt where salt_day < current_date - 1;
  $$
);
```

**Why daily, specifically, rather than Umami's monthly default (§3.2):** the task
frames this as *frequency capping per campaign per day*. The hash only needs to be
**stable within the cap window**, and Watrloo's cap window is a day (mirroring
`INAPP_ADS.md` §5.3's existing "≤3 impressions per placement per day" cap). A daily
salt is the minimum rotation that satisfies that — anything longer (weekly/monthly,
Umami's default) would let the *same* hash persist across cap windows, which starts to
look like the exact persistent identifier this design is trying to avoid. Plausible's
24h cadence and Watrloo's daily cap window happen to want the same salt lifetime for
different reasons (dedup vs. capping) — worth noting as a coincidence, not a law.

### 2.4 The RPC sketch — Edge-Function-fronted (recommended) and direct-RPC (fallback)

**Recommended path** mirrors the house pattern already established for
`analytics-ingest`/`ip-geo`: an Edge Function is the one thing that reliably sees
`Deno`'s connection info and can apply IP-header-priority logic (Umami's `ip.ts`, MIT,
is a genuinely good reference for the *header priority list* — `cf-connecting-ip`,
`fastly-client-ip`, `x-real-ip`, `x-forwarded-for` (first-hop-strip), `forwarded` —
even though Watrloo isn't behind any of those CDNs today except conditionally). The
Edge Function extracts `(ip, user_agent)` itself and hands them to the RPC as **plain
parameters**, so the RPC never has to trust `request.headers` at all:

```sql
-- Called ONLY by the ad-event Edge Function (service-role client). Not granted to
-- anon/authenticated directly — same "the client is never a direct writer" doctrine
-- ANALYTICS.md §3 states for analytics_events.
create or replace function public.record_ad_event(
  p_campaign_id  uuid,
  p_placement_id uuid,
  p_surface      text,               -- 'browse' | 'map' | 'detail'
  p_kind         text,               -- 'impression' | 'click'
  p_ip           text,               -- resolved by the Edge Function, or null
  p_user_agent   text,
  p_client_seed  uuid default null,  -- localStorage fallback (§2.6)
  p_domain       text default 'watrloo.com'
) returns boolean                    -- true if under cap and recorded, false if capped
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salt text;
  v_hash text;
  v_cap  int := 3;   -- same-placement daily cap; mirrors INAPP_ADS.md §5.3
  v_count int;
begin
  select salt into v_salt from public.ad_visitor_salt where salt_day = current_date;
  if v_salt is null then
    -- cron hasn't run yet / cold start: mint today's row on demand rather than fail
    insert into public.ad_visitor_salt (salt_day) values (current_date)
      on conflict (salt_day) do nothing
      returning salt into v_salt;
    if v_salt is null then
      select salt into v_salt from public.ad_visitor_salt where salt_day = current_date;
    end if;
  end if;

  -- IP-or-client-seed fallback, folded into one hash input. If both are null
  -- (header missing AND no localStorage seed passed), hash still succeeds but
  -- collapses every such caller into one bucket for the day — degrades toward
  -- undercounting reach, never toward blocking ad serving. Matches INAPP_ADS.md's
  -- stated doctrine: capping "fails in the user-friendly direction."
  v_hash := encode(
    extensions.digest(
      v_salt || p_domain || coalesce(p_ip, '') || coalesce(p_user_agent, '')
             || coalesce(p_client_seed::text, ''),
      'sha256'
    ),
    'hex'
  );

  insert into public.ad_visitor_frequency (visitor_hash, campaign_id, placement_id, day, impressions, clicks)
  values (v_hash, p_campaign_id, p_placement_id, current_date,
          (p_kind = 'impression')::int, (p_kind = 'click')::int)
  on conflict (visitor_hash, campaign_id, placement_id, day) do update
    set impressions = public.ad_visitor_frequency.impressions
                       + (p_kind = 'impression')::int,
        clicks       = public.ad_visitor_frequency.clicks
                       + (p_kind = 'click')::int
  returning impressions into v_count;

  return v_count <= v_cap;   -- caller (Edge Function / active_featured_placements)
                              -- uses this to decide whether to keep showing this
                              -- placement to this hash for the rest of the day.
end;
$$;

revoke all on function public.record_ad_event(uuid,uuid,text,text,text,text,uuid,text) from public;
-- grant execute only to the service role used by the Edge Function.
```

**Direct-RPC fallback** (no Edge Function hop, cheaper, lower-fidelity): a
`STABLE SECURITY DEFINER` function that reads `request.headers` itself, using the
last-element extraction from §2.2, for surfaces where an extra network hop isn't
justified (e.g. a low-stakes impression ping vs. a click that already round-trips
through a redirect). This is a reasonable place to start and upgrade later — it does
**not** need its own migration path, just a second entry point that calls the same
`record_ad_event` internals with `p_ip` resolved from the GUC instead of a parameter.

### 2.5 Frequency-capping table

```sql
create table public.ad_visitor_frequency (
  visitor_hash text not null,
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  placement_id uuid references public.featured_placements (id) on delete cascade,
  day          date not null default current_date,
  impressions  int  not null default 0,
  clicks       int  not null default 0,
  primary key (visitor_hash, campaign_id, placement_id, day)
);
alter table public.ad_visitor_frequency enable row level security;
revoke all on public.ad_visitor_frequency from anon, authenticated;  -- writer-RPC only

-- Nightly prune, same lifetime discipline as the salt table — a row here can never
-- outlive 2 days, so `visitor_hash` never becomes a usable historical identifier.
select cron.schedule(
  'prune_ad_visitor_frequency', '15 0 * * *',
  $$ delete from public.ad_visitor_frequency where day < current_date - 1; $$
);
```

`visitor_hash` never leaves the database (no RPC returns it), is never joined to
`user_id`, and is unrecoverable within 48 hours by construction (salt deleted, table
pruned). That's a *stronger* privacy posture than the existing `session_id`-based
per-session cap in `INAPP_ADS.md` §5.3, because it never touches device storage at
all in the common case — no cookie, no `localStorage` write — unlike a `sessionStorage`
`session_id`, which at least exists on the device even though it's non-persistent.
This should read as a **complement** to `INAPP_ADS.md` §5.3, not a replacement: keep
the per-session cap for consented/identified viewers (finer-grained, ties into the
existing `analytics_events`/rollup pipeline) and add the visitor-hash cap as the
anonymous, no-consent-required backstop that closes the multi-tab/multi-visit-same-day
gap a `sessionStorage`-scoped id can't.

### 2.6 localStorage fallback (when IP-hashing proves unreliable)

If `x-forwarded-for` is empty (observed ~50% of the time in one report) or the app
isn't yet routed through an Edge Function for a given call site, fold in a
client-minted seed instead of (or in addition to) IP — same non-cookie, same-origin,
random-token doctrine `ANALYTICS.md` §5.1 already uses for `session_id`, and literally
the same pattern `ad-ideas/13-serving-arch.md` #1 already proposed for the placement
shuffle (`p_client_seed`, "a random UUID the client mints once into `localStorage`, no
PII"). Reusing that exact name/shape means one seed can serve both the rotation-shuffle
use case and this one instead of minting a second device token:

```ts
// src/lib/ads/clientSeed.ts — mirrors ad-ideas/13-serving-arch.md's p_client_seed
const KEY = 'wl_ad_seed';
export function clientSeed(): string {
  let seed = localStorage.getItem(KEY);
  if (!seed) { seed = crypto.randomUUID(); localStorage.setItem(KEY, seed); }
  return seed;
}
```

Tradeoffs to state plainly: `localStorage` (unlike `sessionStorage`) **persists across
tabs and browser restarts**, so a client-seed fallback is stickier than IP-hashing —
that's a feature for capping fidelity (one device = one hash, indefinitely, until
cleared) but a small regression on the "nothing survives the day" property that makes
the IP-hash path attractive in the first place. Recommended framing for the ads
policy/UI: this seed is not itself PII (random, unlinked to identity), is used **only**
for frequency-cap counting inside the 2-day-pruned table above, and is cleared like any
other site data if the user clears storage — put it in the same bucket as
`sessionStorage`'s `session_id`, not in a new consent tier.

---

## 3. Umami's event schema, distilled

Pulled directly from `umami-software/umami`'s current `prisma/schema.prisma` and
`src/lib/crypto.ts` / `src/app/api/send/route.ts` (MIT; fetched via `gh api`, not
scraped through a doc site, so this is the actual shipping schema, not a stale blog
post).

### 3.1 `website_event` — the pageview/event fact table

Columns (Postgres, via Prisma `@map`): `event_id` (uuid pk), `website_id`,
`session_id`, `visit_id`, `created_at`, `url_path` (varchar 500), `url_query`,
`referrer_path`, `referrer_query`, `referrer_domain`, `page_title`, `event_type` (int:
1 = pageview, 2 = custom event, plus a performance/link/pixel variant), `event_name`
(varchar 50), `tag`, `hostname`, five UTM columns, six ad-click-id columns (`gclid`,
`fbclid`, `msclkid`, `ttclid`, `li_fat_id`, `twclid`), and five Web Vitals columns
(`lcp`, `inp`, `cls`, `fcp`, `ttfb`, each `decimal`). Custom event *properties* are
**not** inline JSON — they live in a separate `event_data` EAV table
(`data_key`, `string_value`, `number_value`, `date_value`, `data_type`), joined by
`website_event_id`. Twelve indexes on `website_event` alone, mostly
`(website_id, created_at, <dimension>)` composites — one per filterable column
(`url_path`, `url_query`, `referrer_domain`, `page_title`, `event_name`, `tag`,
`hostname`), plus `(website_id, session_id, created_at)` and
`(website_id, visit_id, created_at)`.

### 3.2 `session` — the visitor/device fact table, hashed not stored

Columns: `session_id` (uuid pk — itself the hash output, see below), `website_id`,
`browser`/`os`/`device`/`screen`/`language` (all short varchars, truncated at ingest),
`country` (char 2), `region`, `city`, `distinct_id` (optional client- or
server-supplied stable id for logged-in "identify" calls), `created_at`. **Ten**
indexes, again one composite per dimension crossed with `(website_id, created_at)`.

**Session/visit ID generation (`src/lib/crypto.ts` + `api/send/route.ts`), the part
directly relevant to §2:**

```
uuid(...args) = uuidv5( sha512(args.join('') + secret()), UUID_DNS_NAMESPACE )
secret()      = sha512(APP_SECRET || DATABASE_URL)          # server-only, never shipped
getSalt(rotation, createdAt) = sha512(startOf<rotation>(createdAt).toUTCString())
                                # rotation ∈ {day, week, month}; env SALT_ROTATION, default 'month'

sessionSalt = getSalt(SALT_ROTATION, createdAt)              # default: rotates monthly
visitSalt   = sha512(startOfHour(createdAt).toUTCString())    # always rotates hourly

sessionId = id                                                # "identify" override
              ? uuid(websiteId, id)
              : uuid(websiteId, ip, userAgent, sessionSalt)   # anonymous path

visitId   = uuid(sessionId, visitSalt)                        # re-minted after 30 min idle
```

This is the same shape as Plausible's `hash(salt + domain + ip + ua)` — deterministic,
salted, one-way — but two differences worth carrying into Watrloo's design:
1. **`uuid()` is UUID-v5, not a raw hex hash.** Deterministic given the same inputs
   (so re-computing on a second pageview in the same salt window naturally collides
   into the same row — `on conflict (session_id) do nothing`, no read-before-write
   race), but *shaped* like every other id column in the schema. Watrloo's design in
   §2.4 uses a plain `digest(...)::hex` instead, which is fine (it's stored as `text`,
   never joined as a foreign key to anything user-identity-shaped), but the "hash
   output looks like the rest of your id columns" trick is worth remembering if a
   `visitor_hash uuid` column is ever preferred over `text`.
2. **Umami defaults to a *monthly* session salt**, not daily. That's a deliberate
   product choice for *analytics* (Umami wants "returning visitor" to mean something
   across a month, not reset nightly) — it is **not** the right default to copy for
   Watrloo's *frequency-capping* use case, which wants the shortest salt lifetime that
   still spans the cap window (§2.3 explains why daily is correct here). Umami's `id`
   override path (skip the salt entirely, hash a client- or account-supplied stable
   id) is the closer analog to Watrloo's `p_client_seed` fallback in §2.6.

**IP resolution (`src/lib/ip.ts`)** — a genuinely reusable reference regardless of
which CDN Watrloo ends up behind: a priority list of proxy/CDN headers
(`x-umami-client-ip`, `true-client-ip`, `cf-connecting-ip`, `fastly-client-ip`,
`x-nf-client-connection-ip`, `do-connecting-ip`, `x-real-ip`,
`x-appengine-user-ip`, `x-forwarded-for`, `forwarded`, `x-client-ip`,
`x-cluster-client-ip`, `x-forwarded`), first-match-wins, with IPv4-mapped-IPv6
normalization and port-stripping. For `x-forwarded-for` specifically Umami takes the
**first** element (`split(',')[0]`) — i.e. it makes the same assumption Supabase's own
docs example makes, and would have the same spoofing exposure §2.2 describes **if**
Umami were deployed directly behind a public anon-key-style client. It isn't: Umami's
collect endpoint is a first-party server route the *website owner* controls, not a
public RPC anyone holding a published key can call, so client-side header injection
isn't the same threat there. This is exactly the gap Watrloo's anon-key model creates
and Umami's deployment model doesn't — worth stating explicitly as the reason this
research doc can't just port Umami's IP logic unmodified.

### 3.3 Batching + transport

- `/api/send` (single event) and `/api/batch` (array of the same payload, each
  forwarded internally to `/api/send`) — a plain array-of-JSON batch endpoint, not a
  bespoke batch format. Documented use case: client buffers events in
  `localStorage`/`IndexedDB` while offline and flushes the batch when back online.
- Transport had a real back-and-forth in Umami's own issue tracker:
  `navigator.sendBeacon()` → switched to `fetch(..., { keepalive: true })` (to dodge
  ad-blockers that pattern-match `sendBeacon` calls) → an open discussion asking to
  revert, because `sendBeacon` reportedly delivers **more reliably** on tab-close/
  navigation ("post-mortem" events) than `fetch keepalive` in some browsers. No
  resolved consensus in Umami's own repo. Watrloo's `ANALYTICS.md` §5.1 already lands
  on "prefer `sendBeacon`, fall back to `fetch keepalive`" — that is the *safer* of the
  two positions Umami has held and doesn't need revisiting on Umami's word alone.
- **Cache token, the one clever bit worth stealing (structurally, it's a generic JWT
  pattern, not Umami-specific IP):** every `/api/send` response includes a short-lived
  signed token (`x-umami-cache` request header on the next call) carrying
  `{ websiteId, sessionId, visitId, iat }`. This lets the *next* event from the same
  tab skip re-deriving `sessionId`/`visitId` (no re-hash, no `createSession` DB hit) —
  it just presents the token and the server trusts it until the 30-minute visit
  timeout. Directly applicable to Watrloo's `trackEvent`/`record_ad_event` batcher: the
  first call in a page session can compute (or receive) `visitor_hash` once and the
  client can cache it in memory for the rest of the tab's life instead of resending
  raw IP/UA-shaped material on every impression — though because Watrloo's hash must
  stay **server-computed** (§2.1), the cache would hold the *resulting* hash or a
  signed token wrapping it, never let the client recompute it itself.

### 3.4 Aggregation query shape (small-Postgres dashboard pattern)

Umami's `getWebsiteStats` (pageviews/visitors/visits/bounces/total-time) is a two-level
query: an inner `group by session_id, visit_id` producing per-visit
`(pageview_count, min_time, max_time)`, wrapped by an outer aggregate that does
`count(distinct session_id) as visitors`, `count(distinct visit_id) as visits`,
`sum(...) as pageviews`, and a bounce count from `count(*) = 1` visits. No
materialized view, no rollup table — it's a **live scan** filtered by
`website_id + created_at between` and backed by the `(website_id, created_at)` composite
index. This works for Umami because each *website*'s event volume is naturally
partitioned by `website_id` and the index makes the date-range scan cheap; it does
**not** by itself solve the "one shared free-tier Postgres running the whole app"
problem Watrloo has, which is exactly why `ANALYTICS.md` §7 chose incremental rollup
*tables* (`analytics_daily`, `campaign_daily`, refreshed by `pg_cron`) over live scans
in the first place — a design decision this research reinforces rather than
challenges.

### 3.5 What to copy into Watrloo's `ad_events` / `ad_visitor_frequency` — and what not to

**Copy:**
- The **distinct fact-vs-dimension split**: keep high-cardinality free-text fields
  (`url_path`, `referrer_domain`, custom `props`) out of the main indexed row shape,
  same as Umami's `event_data` side table — Watrloo's `analytics_events.props jsonb`
  already does this, no change needed, just confirms the existing choice is sound.
- **`on conflict (...) do nothing` / `do update` idempotent upserts** for any table
  keyed by a hash — exactly `ad_visitor_frequency`'s pattern in §2.5, taken straight
  from Umami's `createSession`.
- **The salt-rotation *concept*** (already the core of §2), and the "identify override
  replaces the hashed path" pattern for §2.6's client-seed fallback.
- **Truncate every free-text field at ingest** (`FIELD_LENGTH` constants) rather than
  trusting client-supplied lengths — cheap defense against a runaway `props` blob;
  Watrloo's `ANALYTICS.md` §5.2 already specifies a `props` size cap (2 KB), same
  instinct.

**Do not copy:**
- **Umami's index density.** `website_event` alone carries 12 indexes, `session` 10 —
  reasonable for a dedicated analytics database (self-hosted Umami owns its whole
  Postgres instance), actively wrong for Watrloo's shared 500 MB free-tier database
  running bathrooms/reviews/campaigns/analytics together. `ANALYTICS.md` §3 already
  made the leaner call (BRIN on `occurred_at`, one `(event, occurred_at desc)` btree, a
  partial index on `user_id`) — stick with that discipline for `ad_visitor_frequency`
  too: its primary key `(visitor_hash, campaign_id, placement_id, day)` already covers
  the only lookup pattern that matters (cap check + upsert), no secondary indexes
  needed.
- **Umami's first-element `x-forwarded-for` parsing** — correct for Umami's
  first-party-server deployment model, wrong for Watrloo's public-anon-key model, per
  §2.2/§3.2 above.
- **Raw ClickHouse/Kafka fan-out** — Umami supports a Postgres-or-ClickHouse dual
  backend for scale; entirely out of scope for a Supabase free-tier project and not
  something this research recommends investigating further.

---

## 4. Licensing notes

- **Plausible (`plausible/analytics`) — AGPLv3.** AGPL's distinguishing clause (vs.
  plain GPL) is that it triggers on **network use**, not just distribution — running a
  modified AGPL program as a network service obligates offering the modified source to
  users of that service. Nothing in this research or the §2 design copies any
  Plausible source: every fact above about the daily-salt hash came from
  `plausible.io/data-policy` and `plausible.io/cookieless-web-analytics`, which are
  marketing/docs pages, not the licensed codebase. That was intentional, not
  incidental — the *technique* (hash of salt+domain+ip+ua, rotate salt daily) is a
  publicly documented **idea**, and ideas/algorithms aren't copyrightable; only a
  specific expression (source code) is. Watrloo's plpgsql in §2.4 is an independent
  re-derivation of the idea in a completely different language/runtime (Elixir/Erlang
  vs. Postgres plpgsql) with different storage shape (a locked table + pg_cron vs.
  whatever Plausible's Elixir service does internally) — clean under AGPL. The one rule
  worth stating for future contributors: **if anyone ever does open the
  `plausible/analytics` repo "just to check," don't paste anything from it into this
  codebase** — re-derive from the technique description instead, the same discipline
  already applied here.
- **Umami (`umami-software/umami`) — MIT.** MIT permits verbatim copying, modification,
  and redistribution with only an attribution/license-notice requirement — there is no
  legal reason to avoid lifting code directly. This research still recommends **against
  vendoring** Umami's code wholesale, for a practical (not legal) reason: it's a
  Node/Prisma/TypeScript/ClickHouse-optional stack with its own ORM-shaped naming
  (`event_data_id`, camelCase-then-`@map`'d columns) and ingest architecture (Next.js
  API routes, JWT cache tokens, optional Kafka), none of which matches Watrloo's
  `plpgsql` + `SECURITY DEFINER` + `pg_cron` + Edge Function house style established
  across every existing migration in `supabase/migrations/`. The right move — and
  what §2/§3 above actually do — is to **reimplement the *shape*** (schema columns,
  salt-rotation idea, cache-token pattern, batching endpoint) natively, in the repo's
  own conventions, optionally with a code comment citing Umami as prior art where a
  design choice is directly traceable to it. That's a style/maintainability choice,
  not a license constraint — MIT would be fine with literal copy-paste too, this repo
  just doesn't need to take on a second stack's idioms to benefit from its ideas.
- **Practical rule going forward:** treat "read for reference" very differently by
  license. Umami (MIT) can be opened, quoted, and even copied freely — as this
  research already did via `gh api` to pull `crypto.ts`, `ip.ts`, the Prisma schema,
  and the ingest route verbatim for citation above. Plausible (AGPL) should be
  treated as **read-never, technique-only** for this codebase: everything needed for
  §1/§2 came from pages Plausible itself publishes for marketing purposes, precisely
  because those pages already contain the whole technique and there was no reason to
  go further.

---

### Sources

- Plausible — [Data policy](https://plausible.io/data-policy),
  [Cookieless web analytics](https://plausible.io/cookieless-web-analytics).
  `plausible/analytics` repo (AGPLv3) — **not fetched**, by design (see §4).
- Umami — `umami-software/umami` (MIT), fetched directly via `gh api` on
  2026-07-11: `prisma/schema.prisma`, `src/lib/crypto.ts`, `src/lib/ip.ts`,
  `src/app/api/send/route.ts`, `src/queries/sql/sessions/createSession.ts`,
  `src/queries/sql/events/saveEvent.ts`, `src/queries/sql/getWebsiteStats.ts`,
  `src/lib/constants.ts`. Also: [Umami docs — Sessions](https://docs.umami.is/docs/sessions),
  [Tracker configuration](https://docs.umami.is/docs/tracker-configuration).
- Supabase — [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
  (`current_setting('request.headers', ...)`, the `x-forwarded-for` `split_part`
  example this doc corrects); GitHub discussions
  [`orgs/supabase/discussions/34647`](https://github.com/orgs/supabase/discussions/34647)
  ("Is `x-forwarded-for` safe?" — spoofing behavior) and
  [`orgs/supabase/discussions/7884`](https://github.com/orgs/supabase/discussions/7884)
  (Edge Functions client IP, header sometimes empty).
- This repo — `docs/growth/ANALYTICS.md`, `docs/growth/ARCHITECTURE.md` (Decision D4:
  GitHub Pages, not Cloudflare-fronted), `docs/growth/INAPP_ADS.md` §3.2/§5,
  `docs/growth/CAMPAIGNS.md` §2–3, `docs/growth/ad-ideas/13-serving-arch.md` (#1
  `p_client_seed`, #4 frequency-cap tradeoffs), `docs/growth/ad-ideas/10-privacy.md`
  (#4, Cloudflare-fronting proposal), `supabase/migrations/20260710000000_init.sql`,
  `20260710010000_search_geo_privacy.sql` (pgcrypto/`extensions` schema convention),
  `20260712000000_growth_phase0_featured.sql` (`SECURITY DEFINER` / `pg_cron` house
  style).
