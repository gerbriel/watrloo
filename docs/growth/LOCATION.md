# A3 — Location Capture & Segmentation

> **Summary.** We derive **coarse city/region/country** from the caller's IP using
> a **self-hosted MaxMind GeoLite2 City** database — no third party ever sees a user
> IP, and the IP is **never stored**. Capture runs in a `capture-location` Supabase
> Edge Function that fires **only when `user_consents.location_opt_in = true`**, snaps
> the result to a **city centroid** (never the raw geocoded point), and logs it to
> `user_locations` on a rolling retention window. Segments compose consent + region +
> a PostGIS **radius-at-city-granularity** predicate, materialized via `pg_cron`.
>
> **Dependencies:** `A2 DATA_MODEL.md` (owns `user_consents`, `user_locations`,
> `user_segments`/`segment_members`, RLS); `A1 COMPLIANCE.md` (consent capture rules,
> GPC, MaxMind attribution in the v2 privacy policy); `A6 EMAIL_DELIVERY.md` +
> `A5 CAMPAIGNS.md` (send-time eligibility, frequency cap, suppression); `A10/A11`
> (advertisers see **aggregate** reach only; admins see rows). Builds on the existing
> PostGIS install (`supabase/migrations/20260710010000_search_geo_privacy.sql`).

This is a **design**. No migrations are applied, no functions deployed, nothing runs.
DDL/RPC sketches are for the orchestrator (A14) to implement later.

---

## 0. Locked decisions (do not relitigate)

- **Coarse city/region/country from IP only.** No device GPS, no `navigator.geolocation`,
  no street-level precision. "Radius / near me" operates at **city granularity**.
- **Opt-in required.** Nothing is captured, resolved, or stored unless the user has an
  explicit `location_opt_in = true` in `user_consents` (capture rules owned by A1).
- **The raw IP is never stored.** It is resolved to coarse geo in-process and discarded.
- **Admin-only.** `user_locations` and segment membership are visible to admins via RLS
  (`is_admin()`); advertisers see aggregate reach counts, never individuals or points.

---

## 1. IP → coarse geo: options evaluated

The capture point is a Supabase Edge Function (see §2). Whatever we pick must be
**free / self-hostable** and must **not leak user IPs to a third party** (a third party
that receives IPs is a processor we would have to disclose and contract — an avoidable
cost and privacy surface).

### (a) MaxMind GeoLite2 City — **CHOSEN**

Free (with a MaxMind account + license key), self-hosted binary/CSV database. Returns
country, region (subdivision), city, and an **area-centroid** lat/lng plus an
`accuracy_radius`. The lookup runs **entirely on our own infra** — no user IP ever
leaves our systems. Gives us the lat/lng we need to drive the PostGIS radius segment
(options (b)/(c) below mostly give only country, or leak the IP).

**License (must cite — it governs how we deploy and what we owe):**
- GeoLite2 is free but **requires a MaxMind account and license key**; there are **no
  anonymous downloads**. ([GeoLite2 sign-up / dev portal](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/))
- Use is governed by the **GeoLite End User License Agreement**, which **incorporates
  aspects of CC BY-SA 4.0**. It **permits** building applications used by, or displaying
  data to, people **outside your organization**, provided you **attribute MaxMind**.
  Our use (internal segmentation + showing coarse city to admins) is squarely within
  this. ([GeoLite EULA](https://www.maxmind.com/en/geolite/eula),
  [Who is covered](https://support.maxmind.com/hc/en-us/articles/4408936666523))
- **Attribution is mandatory.** Include, e.g.: *"This product includes GeoLite2 data
  created by MaxMind, available from https://www.maxmind.com."* → **REQUEST TO A1:** add
  this attribution line to `PRIVACY_POLICY_v2.md` (processors/sources section) and to an
  in-app "About / data sources" note.
- **ShareAlike / redistribution:** if you *share the database or its data* with others,
  you must bind them to the same terms **and require deletion of outdated copies**.
  We do **not** redistribute the DB — it stays private in R2 and we only emit derived
  coarse geo — so the redistribution obligations are largely not triggered; the
  attribution obligation still applies. ([Commercial redistribution overview](https://support.maxmind.com/hc/en-us/articles/4408928143643))
- **Freshness obligation + cadence:** the EULA requires deleting outdated databases; keep
  our copy current. MaxMind updates GeoLite2 **twice weekly, Tuesdays and Fridays**.
  We refresh on that cadence (§1.2) and never let the R2 copy go stale. ([update cadence](https://dev.maxmind.com/geoip/release-notes/2023/))

**Accuracy caveats (must cite — they justify the "coarse" framing):**
- GeoLite2 City is **~30% city-level coverage / ~47% city-level accuracy** (the paid
  GeoIP2 City is only ~41% / ~52%). Treat city as a *hint*, not a fact.
  ([RU thesis validation](https://www.cs.ru.nl/bachelors-theses/2021/Mike_Schopman___1007619___Validating_the_accuracy_of_the_MaxMind_GeoLite2_City_database.pdf))
- MaxMind states the lat/lng are **not precise, not a street address or household**, and
  carry an `accuracy_radius` (5 km minimum, up to 1000 km). Small towns are commonly
  **snapped to a nearby metro**. This is a feature for us: the data is *inherently*
  coarse, which is exactly what decision #3 requires. ([Geolocation coverage](https://support.maxmind.com/hc/en-us/articles/4407625325467),
  [DB docs](https://dev.maxmind.com/geoip/docs/databases/city-and-country/))
- Consequence for the product: **country is reliable, region is usually right, city is
  best-effort.** Segments should be **conservative** — prefer region-level targeting and
  a generous radius; never present coarse geo to the user as if it were exact.

### (b) Cloudflare edge geo headers — rejected (not available at our capture point)

`CF-IPCountry` (country only) and `request.cf.city/region` (Cloudflare Workers only) are
populated **only for traffic that passes through Cloudflare**. Our app is served from
**GitHub Pages**, and capture happens in a **Supabase Edge Function** (Deno on Supabase's
own edge, **not** behind Cloudflare) — so these headers **are not present** at the point
where we read the caller's IP. We could front the Edge Function with a Cloudflare Worker
purely to harvest `request.cf`, but that adds a moving part for, at best, country +
coarse city, and still no clean lat/lng for the radius query. **Assessment: reject as the
primary source.** Keep as a *possible* zero-cost **country-only** fallback *iff* a CF
Worker is ever placed in front of the capture endpoint (we already use Cloudflare R2, so
the account exists). Not needed for v1.

### (c) A free third-party IP-geo API — rejected

Any hosted IP→geo API ( ipapi, ipinfo, ip-api, etc.) means **sending the user's IP to a
third party** on every sign-in. That party becomes a **processor we must disclose and
contract** (privacy cost), and the genuinely-free tiers are rate-limited /
non-commercial / "best effort" — not something to build a paid platform on. Fails both
the "no IP leak" and the "genuinely free/unlimited" bars. **Reject.**

### 1.1 How GeoLite2 is deployed — MMDB in the Edge Function (primary)

The free-tier Postgres quota (~500 MB) is the deciding constraint. Two patterns:

**Pattern A — MMDB binary in R2, read inside the Edge Function (RECOMMENDED).**
- Store `GeoLite2-City.mmdb` (~60 MB) in **Cloudflare R2** (already in use for assets).
  This keeps the large binary **out of the 500 MB Postgres quota**.
- The `capture-location` function reads it with a **pure-TS MMDB reader** (e.g.
  `mmdb-lib` via `esm.sh`), loading the buffer **once per worker at module scope** so it
  is reused across warm invocations. Cold start pays one ~60 MB R2 fetch (intra-provider,
  fast); capture is fire-and-forget after sign-in, so this never blocks the UI.
- MMDB handles **IPv4 and IPv6** in one file and returns `city.geoname_id`,
  `subdivisions[0]`, `country.iso_code`, `location.{latitude,longitude,accuracy_radius}`.
- We still keep a **small** `geo_cities` reference table in Postgres (from the GeoLite2
  *Locations* CSV, ~a few MB) to (i) snap to a canonical **city centroid** by
  `geoname_id` and (ii) normalize region/country names. This is the only geo data that
  lives in Postgres.

**Pattern B — GeoLite2 CSV loaded into Postgres (alternative).**
- Load `GeoLite2-City-Blocks-IPv4/IPv6` + `Locations` into a `geo_blocks` table keyed by
  an indexed network range (`int8range` / `inetrange` + **GiST**), lookup via a plain SQL
  RPC. Simplest stack, no reader lib.
- **Cost:** the City blocks are millions of rows (~300–400 MB with indexes) — **too heavy
  for the 500 MB free tier.** Only viable on a paid DB, or by loading **GeoLite2-Country**
  (far smaller, ~country only). Use Pattern B only if we outgrow the free DB or if
  country-level is acceptable.

**Decision: Pattern A** — MMDB in the function + tiny `geo_cities` in Postgres. It fits
the free tier, keeps one source of truth for centroids, and gives us lat/lng for radius
segments.

### 1.2 Refresh (Tue/Fri cadence, satisfies the EULA freshness rule)

A scheduled job pulls the latest GeoLite2-City from MaxMind (permalink download using the
license key held in **Supabase Vault**, never inlined) and writes it to R2, then reloads
`geo_cities` from the Locations CSV. Workers pick up the new binary on their next cold
start (add a cheap `?v=<yyyymmdd>` on the R2 key, or a small in-function TTL that re-fetches
if the cached buffer is older than N hours).

Two equivalent triggers (match the existing pattern in `docs/ops/RATE_LIMITING.md §7`):
- `pg_cron` (available on all Supabase tiers) → `pg_net` HTTP call to a
  `refresh-geodb` Edge Function twice weekly; **or**
- a GitHub Actions cron (Tue/Fri) invoking the same function.

```sql
-- Tue & Fri 07:00 UTC, a few hours after MaxMind publishes. Secrets from Vault.
select cron.schedule(
  'refresh-geolite2', '0 7 * * 2,5',
  $$ select net.http_post(
       url     := (select decrypted_secret from vault.decrypted_secrets where name='refresh_geodb_url'),
       headers := jsonb_build_object('Authorization',
                    'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key'))
     ) $$
);
```

---

## 2. Where capture happens: the `capture-location` Edge Function

**Why an Edge Function and not Postgres directly.** The browser can't reliably learn its
own public IP, and Postgres can't see the end-user IP either — PostgREST/pooled
connections make `inet_client_addr()` return the pooler's address, not the client's. The
Edge Function is the only layer that sees the real caller IP (via `x-forwarded-for`,
which Supabase now populates with the client IP —
[supabase/discussions#7884](https://github.com/orgs/supabase/discussions/7884)). So:
resolve geo in the function, hand **only coarse fields** to a `SECURITY DEFINER` RPC.

**Trigger.** Called client-side **once, non-blocking, right after a successful sign-in**
(and optionally after the user first flips location opt-in on). It carries the user's JWT
so the RPC can identify the caller and re-check consent. It is fire-and-forget: failures
never affect sign-in.

**Flow inside the function:**
1. **Consent gate first.** Read `user_consents.location_opt_in` for the caller (or let the
   RPC be the sole gate — see §2.2). If not opted in → return `204`, do nothing, resolve
   nothing. *No opt-in ⇒ we don't even look at the IP.*
2. **Extract the client IP** from `x-forwarded-for`: split on `,`, trim, take the
   **left-most** entry (the original client; downstream entries are proxies). Strip an
   IPv6 zone id and any `[...]:port` wrapper. Accept the imprecision that a client *can*
   spoof XFF — the payoff (coarse, opt-in, low-stakes geo) doesn't justify hardening, and
   a spoof only mislabels that one user's own segment bucket.
3. **Reject non-routable IPs** — do nothing (return `204`) for: loopback (`127.0.0.0/8`,
   `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local
   (`169.254/16`, `fe80::/10`), and empty/missing XFF. This covers **localhost/dev** and
   proxies that hide the client. **VPN/Tor exit nodes are accepted as-is** — the resolved
   city is the exit node's city; at coarse granularity that's acceptable and disclosed.
   We do **not** attempt VPN/proxy detection (a paid MaxMind add-on; out of scope).
4. **Resolve** via the MMDB reader → `{ geoname_id, city, region, country_iso, lat, lng,
   accuracy_km }`. If the MMDB returns no city (many IPs won't have one), keep whatever it
   does return (region/country) and pass `city = null`.
5. **Discard the IP.** It is never logged, never passed to Postgres, never stored.
6. **Call the RPC** `record_user_location(...)` with only the coarse fields.

### 2.1 IP-parsing edge cases (summary)

| Case | Handling |
|---|---|
| IPv6 (incl. `::1`, `fc00::/7`, zone ids, bracketed `[..]:port`) | MMDB handles v6; strip zone/brackets/port; loopback/private → skip |
| `X-Forwarded-For` proxy chain | left-most = client; trim whitespace; ignore the rest |
| Spoofed XFF | accepted (low-stakes, opt-in); only affects that user's own bucket |
| VPN / Tor exit | accepted as coarse city of the exit node; no detection attempted |
| localhost / private / bogon / empty XFF | **skip** — write nothing |
| MMDB miss (no city) | store region/country, `city = null`, still snap centroid if we have region |

### 2.2 The write RPC (re-checks consent server-side)

Consent is enforced **in the RPC**, not only in the function — a `SECURITY DEFINER`
function is the trust boundary, and it must not depend on the caller having gated
correctly. It writes **only** coarse fields and a **city-centroid** geography.

```sql
-- Owned by A3; references user_consents + user_locations (A2) and geo_cities (§3).
create or replace function public.record_user_location(
  p_geoname_id  bigint,               -- from MMDB; used to snap the canonical centroid
  p_city        text,
  p_region      text,
  p_country     text,                 -- ISO-3166-1 alpha-2
  p_lat         double precision,     -- MMDB area centroid (fallback only)
  p_lng         double precision,
  p_accuracy_km int  default null,
  p_source      text default 'ip_geolite2'
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_lat  double precision;
  v_lng  double precision;
begin
  -- 1. Must be authenticated AND opted in. Silently no-op otherwise (never leak
  --    whether a row was written).
  if v_uid is null then return; end if;
  if not exists (
       select 1 from public.user_consents c
       where c.user_id = v_uid and c.location_opt_in
     ) then
    return;
  end if;

  -- 2. Snap to a canonical CITY CENTROID, never the raw geocoded point. Prefer the
  --    geo_cities centroid (identical for everyone in that city); else fall back to
  --    the MMDB point rounded to ~2 decimals (~1.1 km) so it can't read as precise.
  select extensions.st_y(gc.centroid::extensions.geometry),
         extensions.st_x(gc.centroid::extensions.geometry)
    into v_lat, v_lng
  from public.geo_cities gc
  where gc.geoname_id = p_geoname_id;

  if v_lat is null then
    v_lat := round(p_lat::numeric, 2);
    v_lng := round(p_lng::numeric, 2);
  end if;

  -- 3. Log the coarse row. No IP is stored, ever.
  insert into public.user_locations
    (user_id, ip_city, ip_region, ip_country, geog, source, captured_at)
  values
    (v_uid, p_city, p_region, upper(p_country),
     extensions.st_setsrid(extensions.st_point(v_lng, v_lat), 4326)::extensions.geography,
     p_source, now());
end;
$$;

revoke all on function public.record_user_location(bigint,text,text,text,double precision,double precision,int,text) from public;
grant execute on function public.record_user_location(bigint,text,text,text,double precision,double precision,int,text) to authenticated;
```

**REQUEST TO A2 (small additions to the canonical `user_locations`):**
- `accuracy_km int` — store MaxMind's `accuracy_radius` so the CRM/segment logic can be
  honest about coarseness (e.g. suppress a city label when radius > 50 km).
- `geoname_id bigint` (nullable) — lets a later reload re-derive the centroid without
  re-resolving; also the natural join key to `geo_cities`.
- Confirm **no `ip` / `ip_hash` column exists** — storing the IP (even hashed) would
  reintroduce the identifier we deliberately drop. Keep it out.

---

## 3. Precision & privacy

- **Store coarse fields + a city centroid, never the raw geocoded point.** The row holds
  `ip_city`, `ip_region`, `ip_country`, and a `geog` point that is the **city's centroid**
  (from `geo_cities.geoname_id`), so two users in the same city get an **identical** point.
  Even MaxMind's own lat/lng is an area centroid, not a household — snapping to the city
  centroid makes "coarse" **structurally true**, not just a promise.
- **The IP is never persisted.** Resolved in the function, discarded.
- **Radius floor.** Any "near me" / radius targeting is **clamped to a minimum radius**
  (≥ 5 km, matching MaxMind's minimum accuracy radius) so the feature can never resolve to
  street level. Enforced in the segment query (§4) and the campaign target validation
  (defer campaign-side enforcement to A5).
- **Retention — rolling window (both bounds), by `pg_cron`:**
  - Delete anything older than **90 days**, and
  - keep only the **latest N (default 5)** rows per user.

```sql
-- Nightly retention: 90-day window AND keep only the latest 5 per user.
select cron.schedule(
  'prune-user-locations', '20 3 * * *',
  $$
    delete from public.user_locations where captured_at < now() - interval '90 days';
    delete from public.user_locations ul
    using (
      select id, row_number() over (partition by user_id order by captured_at desc) rn
      from public.user_locations
    ) r
    where ul.id = r.id and r.rn > 5;
  $$
);
```

- **Admin-only, never advertisers.** `user_locations` RLS = `select` to admins only
  (`(select public.is_admin())`); no `authenticated` read of others' rows. Advertisers
  interact only with **aggregate reach counts** (A10/A11). This never becomes an ad-network
  data feed.

**Reference table (from GeoLite2 Locations CSV; ~few MB — fine for the free tier):**

```sql
-- REQUEST TO A2: add as a reference table (owned by the geo infra, admin/loader-writable).
create table public.geo_cities (
  geoname_id bigint primary key,
  city       text,
  region     text,                      -- subdivision_1_name
  country    text,                      -- ISO-3166-1 alpha-2
  centroid   extensions.geography(Point, 4326) not null
);
create index geo_cities_centroid_gist on public.geo_cities using gist (centroid);
-- Public/anon read is fine (it's reference data); writes only via the refresh loader.
```

---

## 4. Segmentation

### 4.1 How predicates compose

`user_segments` stores a named, **AND-composed** `predicate jsonb` (schema owned by A2):

```json
{
  "consent":            { "location_opt_in": true, "marketing_opt_in": true },
  "region_in":          ["California", "Nevada"],
  "country_in":         ["US"],
  "near":               { "lat": 37.7749, "lng": -122.4194, "radius_km": 25 },
  "active_within_days": 90
}
```

- **`consent`** — the non-negotiable base filter. `location_opt_in` for any geo predicate;
  `marketing_opt_in` for anything that will drive a marketing send. Consent semantics
  (incl. **GPC** → treat as sharing opt-out) are owned by **A1**; we only read the flags.
- **`region_in` / `country_in`** — coarse, index-friendly, and the **preferred** targeting
  given GeoLite2's city-accuracy caveats (§1).
- **`near`** — PostGIS radius on the user's **latest** location; `radius_km` is
  **clamped to ≥ 5** (city granularity).
- **`active_within_days`** — recency, from `analytics_events`/last activity (defer the
  activity signal definition to **A4**).

### 4.2 The core PostGIS query — "opted-in users within R km of a target city/point"

Latest coarse location per user, joined to consent, filtered by radius. `st_dwithin` on
`geography` is in **meters** and spheroid-accurate; the GiST index on the point makes it
cheap.

```sql
-- Candidate audience for a "near <target>" marketing segment.
with latest as (                                   -- one (newest) row per user
  select distinct on (ul.user_id)
         ul.user_id, ul.geog, ul.ip_region, ul.ip_country, ul.captured_at
  from public.user_locations ul
  order by ul.user_id, ul.captured_at desc
)
select l.user_id
from latest l
join public.user_consents c on c.user_id = l.user_id
where c.location_opt_in
  and c.marketing_opt_in                            -- drop for non-marketing internal use
  and extensions.st_dwithin(
        l.geog,
        extensions.st_setsrid(extensions.st_point(:target_lng, :target_lat), 4326)::extensions.geography,
        greatest(5, :radius_km) * 1000               -- clamp to >= 5 km (city granularity)
      );

-- Supporting index (REQUEST TO A2 if not already on user_locations):
create index user_locations_geog_gist on public.user_locations using gist (geog);
create index user_locations_user_captured_idx
  on public.user_locations (user_id, captured_at desc);
```

`region_in` targeting is the same query without the spatial clause, filtering
`l.ip_region = any(:regions)` — cheaper and more reliable; prefer it when a city/metro is
named rather than an arbitrary point.

### 4.3 Live vs materialized segments

- **Live** (run the query on demand): admin **preview** and reach-count while composing a
  segment; always current, no staleness. Use for ad-hoc counts.
- **Materialized** (`segment_members`, per the canonical model): snapshot a segment's
  `user_id`s for **repeatable large sends** and stable **aggregate reach** numbers, so a
  campaign targets a fixed audience and counts don't drift mid-run.

```sql
-- Recompute one segment's membership (called on-demand before a send, or by cron).
create or replace function public.refresh_segment(p_segment_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_count int;
begin
  if not (select public.is_admin()) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.segment_members where segment_id = p_segment_id;
  -- Compile predicate -> the §4.2 query (full compiler deferred to A2/A5).
  insert into public.segment_members (segment_id, user_id)
  select p_segment_id, user_id from public.compile_segment(p_segment_id);  -- helper, A2
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
```

Refresh cadence via `pg_cron` (hourly is plenty — coarse geo changes slowly and
retention prunes daily):

```sql
select cron.schedule(
  'refresh-materialized-segments', '5 * * * *',
  $$ select public.refresh_segment(id)
       from public.user_segments where materialized $$   -- 'materialized' flag: REQUEST TO A2
);
```

**Send-time is the real gate.** A segment is a *candidate list*. The actual blast
re-checks `location_opt_in`/`marketing_opt_in`, `email_suppressions`, and the **frequency
cap (3 / 7 days)** at send time — **defer that eligibility depth to A6/A5/A1**; this doc
only produces the geo-filtered candidates.

---

## 5. Interfaces & seams (for A14 to stitch)

| I rely on | Owner | Contract |
|---|---|---|
| `user_consents.{location_opt_in, marketing_opt_in, gpc_detected}` | A1 (rules), A2 (schema) | Absence = no consent. RPC + segments read these; A1 owns how they're captured. |
| `user_locations` | A2 | Coarse row + city-centroid `geog`, **no IP column**. Admin-only RLS. Retention by A3's cron. Adds requested in §2.2. |
| `user_segments` / `segment_members` | A2 | `predicate jsonb` (§4.1), optional `materialized bool`, `compile_segment()` helper. |
| Send-time eligibility, frequency cap, suppression | A5/A6/A1 | Segment = candidates only; final gate is at send. |
| Aggregate reach to advertisers | A10/A11 | Counts only; never rows/points. |
| MaxMind attribution in policy | A1 | Add the required attribution line to `PRIVACY_POLICY_v2.md`. |
| R2 (GeoLite2 MMDB), Edge Functions, `pg_cron`/`pg_net`, Vault | existing infra | Already in use (`docs/ops`, R2 for assets). |

**New things this doc introduces** (all deferred to A2 as canonical, DDL provided here):
`geo_cities` reference table; `record_user_location()` RPC; `refresh_segment()` RPC;
three `pg_cron` jobs (refresh-geolite2, prune-user-locations, refresh-segments); the
`capture-location` + `refresh-geodb` Edge Functions.

---

## 6. Sources

- MaxMind GeoLite2 free data / account + license key: https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/
- GeoLite End User License Agreement (CC BY-SA aspects, attribution, ShareAlike): https://www.maxmind.com/en/geolite/eula
- Who is covered by the GeoLite EULA: https://support.maxmind.com/hc/en-us/articles/4408936666523
- Commercial redistribution overview: https://support.maxmind.com/hc/en-us/articles/4408928143643
- GeoLite2 accuracy (coverage/accuracy %): https://www.cs.ru.nl/bachelors-theses/2021/Mike_Schopman___1007619___Validating_the_accuracy_of_the_MaxMind_GeoLite2_City_database.pdf
- Geolocation coverage & accuracy-radius caveats: https://support.maxmind.com/hc/en-us/articles/4407625325467
- City/Country DB docs (accuracy_radius, area centroid): https://dev.maxmind.com/geoip/docs/databases/city-and-country/
- Update cadence (Tue/Fri): https://dev.maxmind.com/geoip/release-notes/2023/
- Supabase Edge Functions client IP via `x-forwarded-for`: https://github.com/orgs/supabase/discussions/7884
- `pg_cron` + `pg_net` pattern (this repo): `docs/ops/RATE_LIMITING.md §7`, `docs/ops/OBSERVABILITY.md`
- Existing PostGIS install / conventions: `supabase/migrations/20260710010000_search_geo_privacy.sql`
