# EthicalAds (readthedocs/ethical-ad-server) — research notes for Watrloo's ad platform

Source read: `readthedocs/ethical-ad-server` (Django/Python, server) at
`adserver/models.py`, `adserver/decisionengine/backends.py`,
`adserver/api/views.py` (`AdDecisionView`), `adserver/views.py`
(`BaseProxyView`), `adserver/utils.py`, `adserver/validators.py` — plus
`readthedocs/ethical-ad-client` (`index.js`, the delivery snippet) for the
client-side viewport/view-time logic, since the server never implements that
part itself.

**License: adserver is AGPLv3. ethical-ad-client (the JS snippet) is MIT.**
Everything below is a **concept-port**: table shapes, algorithm structure,
and JSON schemas re-derived and rewritten from scratch for Postgres/RLS/RPC.
No Python or JS was copied. The only close paraphrase is the *shape* of a
jsonb targeting-key whitelist and the *description* of a viewport-polling
algorithm (itself a generic, widely-used pattern, not original to EA) —
both taken from the MIT client, not the AGPL server. A code-comment credit
to EthicalAds is good practice even though not legally required here.

---

## 1. Their data model, distilled

EA has **four layers**: `Advertiser` (seller) → `Campaign` (product line,
mostly a `campaign_type` + publisher-group grouping) → `Flight` (a single
paid "ad buy": budget + targeting + pacing) → `Advertisement` (one creative
variant). Watrloo currently collapses layers 2–4 into one `ad_campaigns` row
per creative/buy — fine at our scale, but the **Flight** fields are the ones
worth stealing wholesale:

| EA field (on `Flight`) | Why it matters |
|---|---|
| `cpc` / `sold_clicks`, `cpm` / `sold_impressions` | Two independent budget units in the same row; a flight can be sold either way. |
| `targeting_parameters` (jsonb) | One denormalized blob, app-validated against a **key whitelist** (see §below), not a pile of join tables. No read-time joins for targeting. |
| `priority_multiplier` (1..1,000,000) | A blunt admin lever independent of price — "make this flight show more/less" without touching the CPC. |
| `pacing_interval` (default 1h) | The unit pacing math buckets time into; shorter = smoother geographic spread. |
| `daily_cap` | Per-flight spend ceiling; publisher also has its own `daily_cap`. Both checked with `cache.incr` counters, not a live SUM query. |
| `traffic_fill` / `traffic_cap` | `traffic_fill` is a **nightly-computed** jsonb snapshot (`{"countries":{"US":0.1},"regions":{...},"publishers":{...}}` — % of *this flight's* delivery each dimension has eaten). `traffic_cap` is the admin-set ceiling in the same shape. Prevents one country/publisher from swallowing an entire flight's budget. |
| `total_views`/`total_clicks` | **Denormalized and refreshed periodically** (a cron job sums `AdImpression`), explicitly *not* updated in the hot request path — avoids row-lock contention on a hot `Flight` row under concurrent ad serves. |

**`targeting_parameters` whitelist** (from `TargetingParametersValidator`,
enforced app-side on every save, not a DB constraint): `include_countries`,
`exclude_countries`, `include_state_provinces`, `include_metro_codes`,
`include_regions`, `exclude_regions` (regions = named country groupings,
e.g. `"us-ca"`, `"western-europe"`), `include_topics` (curated
keyword-clusters), `include_keywords`/`exclude_keywords`,
`include_publishers`/`exclude_publishers`, `include_domains`/`exclude_domains`,
`mobile_traffic` (`"exclude"|"only"`), `days` (weekday whitelist),
`niche_targeting` (0..1 float gating an embedding-similarity score between
ad and page content — an optional ML layer, skip it).

**Event tables — three-state, not one.** `AdBase` is an abstract base with
`Offer`, `View`, `Click` as three separate concrete tables (not one table
with a type column) sharing: `ip` (anonymized, last 2 bytes zeroed),
`user_agent`, `client_id` (hash of IP+UA, see §3), `country`, `url`,
`domain`, `browser_family`/`os_family` (parsed once, stored, never raw UA
after that for most publishers), `is_bot`/`is_mobile`/`is_proxy`,
`paid_eligible`, `rotations`, `keywords`, `div_id`, `ad_type_slug`,
`is_refunded`. Only `Offer` gets a UUIDv7 PK (time-sortable, used as the
tracking nonce) and adds `viewed`/`clicked` booleans (a tiny state machine)
+ `view_time` + `uplifted`. `Offer`'s table name is swappable via an env var
— implies EA partitions/rotates this table because it's their highest-volume
data. All these models are `IndestructibleModel`: `.delete()` raises
`IntegrityError` unless a model opts in with `can_be_deleted()` — nothing in
the billing chain can ever be hard-deleted, which is what makes `refund()`
(decrement counters, keep the row, flip `is_refunded`) the correct pattern
instead of deletion.

**Reporting layer = 11 pre-aggregated daily rollup tables**, all subclassing
`BaseImpression` (`date`, `decisions`, `offers`, `views`, `clicks`, plus
`view_time` on the main one): `AdImpression` (per ad × publisher × day, the
primary one), `AdvertiserImpression`, `PublisherImpression`,
`PublisherPaidImpression`, `PlacementImpression` (+ div_id/ad_type),
`GeoImpression` (+ country), `RegionImpression`, `KeywordImpression`,
`DomainImpression`, `RotationImpression`, `RegionTopicImpression`. Each has
a `unique_together` that doubles as its upsert key. Every dashboard query
hits one of these tiny per-day rows instead of scanning raw `Offer`/`View`/
`Click`. The write path (`Advertisement.incr()`) is a
`get_or_create` + `F("views") + 1` UPDATE — race-safe, no read-modify-write.

**Publisher fields worth noting:** `daily_cap` (after which only unpaid ads
show), `allow_paid_campaigns`/`allow_affiliate_campaigns`/
`allow_community_campaigns`/`allow_house_campaigns` (per-publisher revenue-type
opt-in), `sampled_ctr` (feeds ad selection, see §2), `cache_ads` +
`cache_ads_duration` (a **sticky decision cache** keyed on
`{publisher, ad_type, client_id}` — once a client gets an ad, the same ad
is replayed from cache for N seconds instead of re-running selection and
re-billing on every SPA route change; this is directly relevant to Watrloo,
which is also an SPA).

---

## 2. Ad decision algorithm

Request → eligible campaign types → candidate flights (SQL filter) →
per-flight boolean gate chain → weighted-random flight pick (tiered by
campaign type) → weighted-random ad pick within that flight.

```
function get_ad_and_placement(request, placements, publisher, keywords, ...):
    campaign_types = intersect(publisher.allowed_types, requested_types, ALL)
    if publisher.daily_cap and publisher.daily_earn_today >= daily_cap:
        campaign_types -= {PAID}

    candidates = Flight.where(
        live=true, start_date <= today,
        ad_types overlap requested_ad_types,
        campaign_type in campaign_types,
        publisher in campaign.publisher_groups,
        publisher not in campaign.exclude_publishers,
        exists >=1 live ad matching a requested ad_type)

    for tier in [PAID, AFFILIATE, COMMUNITY, PUBLISHER_HOUSE, HOUSE]:
        eligible = []
        for flight in candidates in tier:
            if not filter_flight(flight): continue          # <- gate chain, below
            need = weighted_clicks_needed_this_interval(flight, publisher)
            if need > 0: eligible.append((flight, need))
        if eligible:
            flight = weighted_random_choice(eligible)         # cumulative-range pick
            break   # first non-empty tier wins; lower tiers never compared

    ad = weighted_random_choice_from_flight(flight)            # priority + CTR bonus
    return ad, matching_placement(ad)

function filter_flight(flight):
    return (flight.show_to_geo(geo)                # include/exclude country|state|metro|region
                                                     # + traffic_cap check vs traffic_fill
        and flight.show_to_keywords(keywords)       # include/exclude + topic-expanded keywords
        and flight.show_to_mobile(is_mobile)
        and flight.show_on_publisher(publisher)     # include/exclude list + traffic_cap
        and flight.show_on_domain(url)
        and weighted_clicks_needed_this_interval(flight) > 0   # PACING GATE
        and flight.show_to_day(weekday)
        and not flight.daily_cap_exceeded())

function weighted_clicks_needed_this_interval(flight, publisher=None):
    # Normalize CPM views into "click-equivalents": 1000 views ~= 1 click
    need = ceil(views_needed_this_interval(flight) / 1000) + clicks_needed_this_interval(flight)
    ctr = publisher.sampled_ctr if publisher else flight.ctr()
    ecpm = clamp(flight.cpc * ctr * 10, 1.0, 10.0) if flight.cpc else flight.cpm
    weighted = need * flight.priority_multiplier * ecpm
    overdue_factor = max(1, days_overdue(flight)) ** 1.5      # superlinear catch-up
    return weighted * overdue_factor

# where views/clicks_needed_this_interval() = "how far behind pace is this
# flight": compare days_remaining/sold_days (fraction of TIME left) against
# views_remaining/sold_impressions (fraction of INVENTORY left) — if
# inventory-remaining-fraction > time-remaining-fraction, it needs to speed up.
```

**Flight pick:** build a cumulative-range list `[(lo, hi, flight), ...]`
sized by each flight's weight, draw one `random(0, total)`, linear-scan to
the bucket it lands in. Classic roulette-wheel weighted selection — no
bidding, no real-time price competition, pure inventory-fairness pacing.

**Ad pick within the winning flight:** every live ad matching a requested
`ad_type` gets `priority` copies pushed into a list (placement priority
1–10, +0..4 bonus if `sampled_ctr` clears thresholds 0.075/0.10/0.125/0.15%,
+0..5 bonus from content-embedding similarity if available), then
`random.choice()` over the exploded list. This is weighted-random, not
greedy-best-CTR — a deliberate explore/exploit compromise so lower
performers still get occasional impressions instead of starving.

**Sticky decisions:** the `AdDecisionView` checks a cache key
`{publisher}-{ad_type}-{client_id}` before running any of the above; if hit,
the previous response replays verbatim (same nonce even) for
`cache_ads_duration` seconds. This means the algorithm only actually *runs*
once per client per cache window, not once per page view.

---

## 3. Impression integrity rules

**Four funnel stages, strictly nested:** `decisions ≥ offers ≥ views ≥
clicks`. A *decision* is every API call, even ones with zero inventory
(`record_null_offer` — kept purely so fill-rate is measurable). An *offer*
is a decision where an ad was actually chosen and handed to the client,
recorded with a UUID nonce, **unbilled**. A *view* is an offer the client's
browser actually rendered on-screen and reported back through a signed pixel
URL. A *click* is a subsequent report through a second signed URL. Views
are gated behind `settings.ADSERVER_RECORD_VIEWS` or a per-publisher
`record_views` flag for the **raw row** — but the daily `AdImpression`
counter always increments regardless, because storing one row per view at
scale is prohibitively expensive; only the rollup is guaranteed.

**Nonce state machine (`Offer.viewed`/`clicked`):** a nonce is valid for
exactly one view (`viewed == False`, offer `< 2h` old) and, after that,
exactly one click (`viewed == True and clicked == False`). This enforces
*view-before-click* as a referential-integrity property, not just a UX
assumption, and the nonce is invalidated (flag flipped) the instant it's
accepted — no replay.

**The full `ignore_tracking_reason()` gate chain** (first match wins, view
or click is silently dropped but still logged with the reason for
debugging):
1. Unknown/missing offer.
2. Stale or already-consumed nonce (`is_valid_offer`).
3. Bot UA (`user_agents.parse(...).is_bot`, or literal `"bot"` substring in
   UA/browser family).
4. Internal IP (`settings.INTERNAL_IPS`, skipped only in `DEBUG`).
5. Unrecognized browser/OS family (`"Other"`) — heuristic for
   headless/prefetch/scraper traffic that doesn't UA-spoof convincingly.
6. **Logged-in user** (`request.user.is_anonymous` must be true) — staff and
   any authenticated dashboard user are excluded outright.
7. Blocklisted UA regex / blocklisted referrer regex (both admin-configured
   lists).
8. Blocklisted or proxy/VPN/Tor IP (IP2Proxy commercial DB + a Tor
   bulk-exit-list file, refreshed periodically).
9. Unknown publisher.
10. Geo re-check at view/click time vs. offer time — catches "served with
    VPN on, clicked with VPN off" and similar mid-session geo drift; not
    fraud per se, just not billable to a geo-targeted flight.
11. Rate limit (sliding-window, keyed on client IP, separate limits for
    views vs. clicks — both empty lists by default, i.e. off until an
    operator sets them).
12. OS/browser family mismatch between the offer-time UA and the
    view/click-time UA — catches a stolen or replayed nonce URL hitting a
    different device.
13. (Non-blocking, logged only) offer's publisher `allowed_domains` doesn't
    contain the click/view URL's domain.
14. (Always runs, non-blocking) offer IP vs. current IP mismatch, logged for
    visibility even when not disqualifying.

**Viewport visibility (client, MIT-licensed `ethical-ad-client`, not the
server):** a `setInterval` polls every 100ms whether the ad element is in
the viewport using a **geometry check with a −3px fudge factor** (tolerates
an ad sitting a few px off-screen behind a sliding sidebar) *and*
`document.visibilityState === "visible"` (tab must be focused, not just the
element scrolled into a background tab's DOM). The instant both hold, a 1×1
view pixel fires **once** — that's "the view." A second, independent
1-second interval accumulates `view_time` only while both conditions hold
(capped client-side at 5 min = `VIEW_TIME_MAX`, re-capped server-side at
`Offer.MAX_VIEW_TIME`), flushed via a separate pixel on `visibilitychange`
(tab hidden) or right before an ad rotates. The server only accepts **one**
`view_time` write per offer (`not offer.view_time and offer.viewed`) — later
pings for the same offer are silently ignored, so it can't be inflated by
repeated calls. An ad won't rotate into a new creative in the same slot
until it's been viewport-visible for ≥45s (`MIN_VIEW_TIME_ROTATION_DURATION`)
and caps at 3 rotations per pageview — stops "flip through 50 ads in 10
seconds" gaming.

**Refunds, not deletes:** `Offer.refund()` is idempotent (`is_refunded`
guard) and decrements the `AdImpression` daily counters without touching the
raw `Offer`/`View`/`Click` row — billing numbers self-correct, evidence
stays intact for audit.

---

## 4. Port plan for Supabase (concept-port — see license note above)

Grounds in what's already shipped: `supabase/migrations/20260712000000_growth_phase0_featured.sql`
(`ad_campaigns`, `featured_placements`, `active_featured()`,
`is_business_manager()`/`is_admin()`, `growth_settings`,
`moderation_actions` audit trail) and the existing survey
(`docs/growth/ad-ideas/04-targeting.md`, `09-fraud-safety.md`,
`13-serving-arch.md`), which already independently proposed an `ad_events`
table and server-side selection in `active_featured`. This plan **adds the
EA-specific pieces those ideas don't cover**: the offer/nonce integrity
layer, the jsonb targeting whitelist, pacing math, and rollup tables —
without duplicating what's already speced.

### A. Budget + targeting columns on `ad_campaigns` (EA's `Flight`, flattened)

```sql
alter table public.ad_campaigns
  add column if not exists cpc_cents          int check (cpc_cents >= 0),
  add column if not exists cpm_cents          int check (cpm_cents >= 0),
  add column if not exists sold_clicks        int not null default 0,
  add column if not exists sold_impressions   int not null default 0,
  add column if not exists priority_multiplier int not null default 1
                           check (priority_multiplier between 1 and 1000000),
  add column if not exists daily_cap_cents    int check (daily_cap_cents >= 0),
  add column if not exists total_clicks       int not null default 0,  -- refreshed by cron, not hot path
  add column if not exists total_views        int not null default 0,
  -- Contextual, hyperlocal targeting -- NOT country/state (EA's audience is
  -- global docs readers; ours is one metro at a time). radius_km replaces
  -- include_countries/regions almost entirely.
  add column if not exists targeting          jsonb not null default '{}'::jsonb;
```

Targeting whitelist for Watrloo (mirrors EA's key-whitelist *pattern*, not
its keys — ours is geo-radius + category/amenity, not country/state):

```json
{
  "radius_km": 5,
  "include_categories": ["cafe", "restaurant"],
  "include_keywords": ["accessible", "family-friendly"],
  "days": ["monday", "friday", "saturday"],
  "surfaces": ["browse", "detail"]
}
```

```sql
create or replace function public.validate_ad_targeting(p jsonb)
returns void language plpgsql immutable as $$
declare k text;
begin
  for k in select jsonb_object_keys(p) loop
    if k not in ('radius_km','include_categories','include_keywords','days','surfaces') then
      raise exception 'unknown targeting key: %', k using errcode = '22023';
    end if;
  end loop;
  if p ? 'radius_km' and not (jsonb_typeof(p->'radius_km') = 'number' and (p->>'radius_km')::numeric > 0) then
    raise exception 'radius_km must be a positive number' using errcode = '22023';
  end if;
end; $$;
-- Called from create_campaign()/submit_campaign(), not a CHECK constraint,
-- so the whitelist can grow without a table rewrite.
```

### B. Offer/nonce integrity layer (the missing piece vs. idea 09's `ad_events`)

Idea 09 #1 already speces a durable `ad_events` log. EA's contribution is
the **short-lived state table in front of it** that makes "view before
click, exactly once" enforceable — add this, don't replace `ad_events`:

```sql
create table if not exists public.ad_offers (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  placement_id uuid references public.featured_placements (id) on delete cascade,
  session_id   text not null,          -- client-minted, no PII (matches idea 13 #1's p_client_seed)
  surface      text not null,
  region       text,
  viewed       boolean not null default false,
  clicked      boolean not null default false,
  view_time_seconds int,
  created_at   timestamptz not null default now()
);
alter table public.ad_offers enable row level security;  -- no public policy: RPC-only access
create index if not exists ad_offers_created_idx on public.ad_offers (created_at); -- TTL sweep
create index if not exists ad_offers_campaign_idx on public.ad_offers (campaign_id);
```

```sql
-- Called from inside the selection RPC (see §F) for the WINNING candidate
-- only -- fixes the "ships all 10 candidates' creative" leak (idea 13 #1)
-- as a side effect, since only the offer's campaign gets a nonce back.
create or replace function public.confirm_ad_view(p_offer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.ad_offers;
begin
  select * into o from public.ad_offers where id = p_offer_id;
  if o is null or o.created_at < now() - interval '2 hours' or o.viewed then
    return; -- silently drop, mirrors EA's "log reason, don't error to client"
  end if;
  update public.ad_offers set viewed = true where id = p_offer_id;
  insert into public.ad_events (event_type, campaign_id, placement_id, surface, session_id, region)
  values ('impression', o.campaign_id, o.placement_id, o.surface, o.session_id, o.region);
end; $$;
grant execute on function public.confirm_ad_view(uuid) to anon, authenticated;

create or replace function public.confirm_ad_click(p_offer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.ad_offers;
begin
  select * into o from public.ad_offers where id = p_offer_id;
  if o is null or not o.viewed or o.clicked or o.created_at < now() - interval '2 hours' then
    return;
  end if;
  update public.ad_offers set clicked = true where id = p_offer_id;
  insert into public.ad_events (event_type, campaign_id, placement_id, surface, session_id, region)
  values ('click', o.campaign_id, o.placement_id, o.surface, o.session_id, o.region);
end; $$;
grant execute on function public.confirm_ad_click(uuid) to anon, authenticated;

create or replace function public.record_ad_view_time(p_offer_id uuid, p_seconds int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ad_offers
     set view_time_seconds = least(greatest(p_seconds, 0), 300)  -- MAX_VIEW_TIME equivalent
   where id = p_offer_id and viewed and view_time_seconds is null;  -- write-once
end; $$;
grant execute on function public.record_ad_view_time(uuid, int) to anon, authenticated;
```

**Deliberate privacy divergence from EA, flagged not hidden:** EA stores
anonymized IP + UA family per offer to power the OS/browser replay-mismatch
check and IP-mismatch logging (gate #12/#14 above). Watrloo's stronger
no-tracking stance argues for **not** storing IP/UA at all here — rely on
`session_id` (client-minted, ephemeral, not tied to an account) plus rate
limiting instead. This trades away one fraud signal (stolen-nonce replay
detection) for a stronger privacy story; revisit only if click fraud is
observed in practice, per idea 09 #6's velocity-cap plan.

### C. Client-side viewport polling (pattern from the MIT client, rewritten)

`SponsorSlot`/`FeaturedCard` should use a plain `IntersectionObserver`
(threshold ~0.5, `rootMargin: "-3px"` — EA's fudge factor) instead of the
100ms-poll-and-geometry-check the old client used (that predates wide
`IntersectionObserver` support); fire `confirm_ad_view(offerId)` once on
first qualifying intersection, start a `setInterval(1000)` that increments a
local counter only while `document.visibilityState === "visible"` and the
observer's `isIntersecting` is true, and flush via `record_ad_view_time` on
`visibilitychange`/unmount, capped at 300s.

### D. Rollup table (closes idea 08 "CSV export off a rollup" / idea 03 reporting granularity)

```sql
create table if not exists public.ad_daily_rollup (
  day               date not null,
  campaign_id       uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id       uuid not null references public.businesses (id) on delete cascade,
  surface           text not null,
  region            text,
  offers            int not null default 0,
  views             int not null default 0,
  clicks            int not null default 0,
  view_time_seconds bigint not null default 0,
  primary key (day, campaign_id, surface, coalesce(region, ''))
);
alter table public.ad_daily_rollup enable row level security;
create index if not exists ad_daily_rollup_business_idx on public.ad_daily_rollup (business_id, day);

drop policy if exists "members read their rollups" on public.ad_daily_rollup;
create policy "members read their rollups" on public.ad_daily_rollup
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));

-- Runs on the same pg_cron cadence as dispatch_inapp_blasts (every 5 min is
-- fine at this volume; EA does it nightly at much larger scale).
create or replace function public.refresh_ad_rollup()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ad_daily_rollup (day, campaign_id, business_id, surface, region, offers, views, clicks, view_time_seconds)
  select date_trunc('day', o.created_at)::date, o.campaign_id, c.business_id, o.surface, o.region,
         count(*), count(*) filter (where o.viewed), count(*) filter (where o.clicked),
         coalesce(sum(o.view_time_seconds), 0)
  from public.ad_offers o join public.ad_campaigns c on c.id = o.campaign_id
  where o.created_at > now() - interval '2 days'   -- re-aggregate a rolling window, idempotent upsert
  group by 1,2,3,4,5
  on conflict (day, campaign_id, surface, coalesce(region,''))
  do update set offers = excluded.offers, views = excluded.views,
                clicks = excluded.clicks, view_time_seconds = excluded.view_time_seconds;

  delete from public.ad_offers where created_at < now() - interval '7 days';  -- EA-style rotation/pruning
end; $$;
select cron.schedule('growth_refresh_ad_rollup', '*/5 * * * *', $$select public.refresh_ad_rollup()$$);
```

### E. Selection RPC: weighted pick, single round trip

```sql
create or replace function public.pick_ad(
  p_surface text, p_bathroom_id uuid default null,
  p_lat double precision default null, p_lng double precision default null,
  p_categories text[] default '{}', p_keywords text[] default '{}',
  p_session_id text default null
)
returns table (offer_id uuid, campaign_id uuid, business_id uuid, creative jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_point extensions.geography;
  v_offer_id uuid;
  v_campaign public.ad_campaigns;
begin
  if p_lat is not null and p_lng is not null then
    v_point := extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography;
  elsif p_bathroom_id is not null then
    select geog into v_point from public.bathrooms where id = p_bathroom_id;
  end if;

  -- Weighted-random-without-replacement in one ORDER BY: the exponential-key
  -- trick (order by -ln(random())/weight) is the SQL-idiomatic equivalent of
  -- EA's Python cumulative-range-and-random-int loop -- same distribution,
  -- no app-side loop needed.
  select c.* into v_campaign
  from public.ad_campaigns c
  join public.featured_placements fp on fp.campaign_id = c.id
  left join public.bathrooms b on b.id = fp.bathroom_id
  where c.status = 'running' and fp.surface = p_surface
    and now() between fp.starts_at and fp.ends_at
    and (not (c.targeting ? 'radius_km') or v_point is null
         or extensions.st_dwithin(b.geog, v_point, (c.targeting->>'radius_km')::numeric * 1000))
    and (not (c.targeting ? 'include_categories')
         or exists (select 1 from jsonb_array_elements_text(c.targeting->'include_categories') k
                     where k.value = any(p_categories)))
  order by -ln(random()) / greatest(
      c.priority_multiplier
      * (case when c.sold_clicks + c.sold_impressions = 0 then 1
              else greatest(1.0, (c.sold_clicks + c.sold_impressions - c.total_clicks - c.total_views)::numeric
                                  / greatest(c.sold_clicks + c.sold_impressions, 1)) end),
      0.0001)
  limit 1;

  if v_campaign.id is null then
    return; -- no eligible ad -- caller renders nothing, no null-offer row needed at our volume
  end if;

  insert into public.ad_offers (campaign_id, placement_id, session_id, surface, region)
  select v_campaign.id, fp.id, p_session_id, p_surface, fp.region
  from public.featured_placements fp where fp.campaign_id = v_campaign.id and fp.surface = p_surface
  limit 1
  returning id into v_offer_id;

  return query select v_offer_id, v_campaign.id, v_campaign.business_id, v_campaign.creative;
end; $$;
grant execute on function public.pick_ad(text,uuid,double precision,double precision,text[],text[],text) to anon, authenticated;
```

This directly implements idea 13 #1 (server-side selection, only the
winner's creative leaves Postgres) using EA's pacing *ratio* (inventory
remaining vs. sold, weighted by `priority_multiplier`) but Postgres-native
weighted sampling instead of a Python loop, and folds in the offer/nonce
creation from §B so the client gets `{offer_id, creative}` in one call.

### F. What NOT to port

Skip: the 4-layer Advertiser/Campaign/Flight/Ad hierarchy (our 1-layer
`ad_campaigns` is fine below ~1000s of concurrent flights); `traffic_fill`/
`traffic_cap` nightly snapshots (premature before we have >1 flight
competing for the same surface/region); embedding-similarity niche
targeting (needs a model + embeddings table, no signal yet); the 11-table
rollup fan-out (one `ad_daily_rollup` table with `surface`/`region`/
`campaign_id` columns covers our reporting needs at current volume — split
it out only if a specific dashboard query gets slow).
