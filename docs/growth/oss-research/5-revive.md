# Revive Adserver delivery model → Watrloo port plan

Source: Revive Adserver (GPL, revive-adserver/revive-adserver) delivery/pacing
concepts only — no code read or copied, only docs, forum threads, and file/function
*names* (via search results) used to confirm architecture. See Sources at bottom.

---

## 1. The delivery model, distilled

Revive splits ad selection into two phases that run on different clocks:

- **A slow, periodic pacing job** ("maintenance", default hourly) that looks at
  each *contract* (goal-based) campaign's target-vs-actual delivery and
  recomputes a **probability weight** for the next interval.
- **A fast, per-request selection** that, given the zone being filled, filters
  to eligible banners and picks one using priority + (possibly pacing-adjusted)
  weight — cheap enough to run on every page view with no lag.

Only contract campaigns need the slow job; remnant/override campaigns are
"relational" and can be weighted on the fly at request time because they have
no delivery goal to hit, just a weight to compare against siblings.

### 1a. Priority tiers

Three campaign types, evaluated as strict tiers — a lower tier is only
considered when the tier above has nothing eligible to serve:

| Tier | Type | Behavior |
|---|---|---|
| 1 (highest) | **Override / Sponsorship** | "Always" wins over contract and remnant. Used for a paid takeover of a zone. Weight only resolves ties *among* overrides. |
| 2 | **Contract** | Priority field 1–10 (default 5) sets pecking order among contract campaigns; each has a daily/total impression (or click/conversion) **goal** it tries to hit evenly over its flight. Weight is a fallback tiebreaker when two contracts of equal priority compete for scarce inventory. |
| 3 (lowest) | **Remnant** | Fills whatever impressions nothing above claimed. No goal — just proportional share by weight among remnant campaigns. This is the "house ad" / unsold-inventory tier. |

A **zone** is a placement slot on a page (e.g. "leaderboard-top",
"sidebar-A"). Campaigns are explicitly *linked* to one or more zones; a
selection request is always "give me a banner for zone Z," never "give me a
banner" in the abstract. Zone capacity — how many banners a zone can show at
once — plus "companion" linking (multiple zones on one page forced to show
banners from the *same* campaign, e.g. a leaderboard + skyscraper roadblock)
and "exclusive" zones (only one advertiser/campaign at a time, no rotation)
are the two zone-level knobs layered on top of campaign selection.

### 1b. Eligibility → weighted pick → pacing, composed

```
function select_banner(zone):
    now = current_time()
    candidates = campaigns
        .linked_to(zone)
        .where(status == 'active')
        .where(now between flight_start and flight_end)
        .where(delivery_rules_pass(client, geo, site, time))   # targeting
        .where(not capped(visitor, campaign))                  # frequency cap
        .where(not capped(visitor, banner))                    # banner-level cap

    for tier in [OVERRIDE, CONTRACT, REMNANT]:
        pool = candidates.where(type == tier)
        if pool.not_empty():
            return weighted_pick(pool)   # only this tier is considered
    return house_ad_or_nothing()

function weighted_pick(pool):
    # weight is the RAW weight for remnant/override;
    # for contract campaigns it is the PACING-ADJUSTED probability
    # computed by the last maintenance run (target-vs-actual so far today)
    total = sum(p.effective_weight for p in pool)
    r = random(0, total)
    cum = 0
    for p in pool:
        cum += p.effective_weight
        if r <= cum: return p
```

### 1c. Pacing (the part that makes contract campaigns "even")

Once an hour (configurable), a batch job recomputes each contract campaign's
`effective_weight`:

```
expected_by_now   = daily_goal * fraction_of_day_elapsed
actual_delivered   = impressions_so_far_today
pace_ratio         = expected_by_now / max(actual_delivered, 1)
effective_weight    = base_priority_weight * clamp(pace_ratio, min, max)
```

Under-delivering → `pace_ratio > 1` → weight boosted next interval.
Over-delivering → `pace_ratio < 1` → weight suppressed. Revive's own docs
list the causes of persistent under-delivery: overly-restrictive targeting,
caps that exclude a banner more than the last calculation anticipated, or
simply not enough linked-zone inventory to hit the goal at all (in which case
no amount of weight fixes it — the goal is just mathematically unreachable).

### 1d. Frequency capping semantics

Core Revive ships two cap dimensions: **total** (N impressions to a visitor,
ever) and **session** (N impressions within one browsing session, reset
window configurable). Finer windows — per hour/day/week — are common asks
but are add-on/plugin territory, not core; a dedicated "Frequency Capping"
plugin exists precisely because total/session wasn't granular enough for
"max 3 views per user per day." Mechanism either way: a per-(visitor,
campaign-or-banner) counter+timestamp, checked as a hard *eligibility
filter* before weighting runs — caps exclude outright, they don't get
weighted down. Revive is explicit caps are a ceiling, not a guarantee:
"Delivery caps do not guarantee delivery of the desired cap — they simply
limit the maximum delivery that is possible."

### 1e. What a "zone" contract looks like

A zone is `(zone_id, capacity, allowed_ad_types, companion_group?)`.
Campaigns declare which zones they're linked to (many-to-many); capacity > 1
rotates multiple campaigns across requests, capacity == 1 is naturally
"exclusive" with no extra flag needed. Companion zones share one selection
decision — pick the campaign once, place its creative into every zone in the
group on that render — used to stop competing advertisers on one page, or to
guarantee a matched leaderboard+skyscraper pair from one sponsor.

---

## 2. What applies to us vs. what's overkill

Watrloo today: `ad_campaigns` + `featured_placements`, a handful of
campaigns per region at any time, flat-rate manual billing (no CPM/CPC/CPA
pricing models, no delivery *goals* denominated in dollars), admin approval
gate already in front of everything. That context changes the calculus a
lot from a 20-year-old enterprise ad server built for programmatic-scale
inventory brokering.

**Skip entirely** (not worth the complexity at our volume):
- CPM/CPC/CPA pricing and goal-based contract pacing tied to a *revenue*
  target — we sell flat-rate slots, not delivery volume; there's no "hit
  50,000 impressions by Friday" goal to pace toward.
- The three-tier campaign-*type* taxonomy (override/contract/remnant) as a
  literal feature — no unsold-inventory remnant fill or paid takeovers
  today; inventing that taxonomy now solves a problem we don't have.
- Hourly batch "maintenance" job recomputing probabilities — sized for
  thousands of concurrently-pacing campaigns. A pacing multiplier computed
  *inline at selection time* (§3) does the same job with zero moving parts.
- Companion/roadblock zone linking — our surfaces (browse/map/detail) are
  independent; no page layout needs two slots to agree on one advertiser.
- Client/device/geo delivery *rules* engine — our targeting is one column
  (`target_region`), not a rules DSL.
- Plugin-grade per-hour/per-week frequency capping against known visitors —
  `active_featured()` is deliberately anonymous/zero-PII; real per-visitor
  capping means introducing an identity to cap against, a privacy/scope call
  above this ticket, not a delivery-engine gap.

**Worth keeping — the 20%:**
1. **Priority, collapsed to two tiers not three.** Paid/approved campaigns
   outrank a filler ("house ad"/nothing) tier — a binary gate, not
   override/contract/remnant.
2. **Per-campaign weight**, a plain integer column, admin-adjustable,
   neutral default. Highest-value single idea to steal: turns "first row
   wins" into "advertisers can be made more or less prominent," for one column.
3. **Weighted random pick among eligible campaigns** — replaces
   `order by starts_at limit 1`. This is the actual bug we're fixing.
4. **Slot capacity per surface**, already modeled in
   `growth_settings.featured_capacity` (`browse: 3, map: 1, detail: 1`) — this
   *is* Revive's zone-capacity concept; just need `pick_featured` to return
   up to N rows instead of `active_featured`'s hard-coded `limit 10`.
5. **Deterministic-but-rotating selection.** Not full frequency capping —
   just: a visitor's session shouldn't flicker between campaigns on re-render,
   but the pool should still rotate over time so no advertiser camps a slot.
   A session-seeded hash bucketed by time window gets this for free, no
   impressions table required.
6. **A lightweight pacing multiplier**, optional per-campaign
   (`daily_impression_cap`, nullable) — not goal-*revenue* pacing, just
   "don't let the weighted-random spend a day's budget in hour one." Needs
   *some* impression counting, which we don't have — smallest viable version
   is one fire-and-forget log table.

Everything else in Revive is machinery for a marketplace with dozens of
buyers competing algorithmically for shared inventory. We have an approval
queue and a handful of advertisers; a human (the admin) is already the
arbitration mechanism Revive tries to automate away. Lean on that.

---

## 3. Port plan: `pick_featured(p_surface, p_region, p_session_seed)`

### 3a. Schema deltas (additive, mirrors existing migration style)

```sql
-- Manual prominence dial, admin-settable. Neutral default so existing
-- placements behave exactly like today until someone changes it.
alter table public.featured_placements
  add column if not exists weight int not null default 100 check (weight > 0);

-- Optional soft pacing target; null = no pacing (today's behavior).
alter table public.featured_placements
  add column if not exists daily_impression_cap int check (daily_impression_cap > 0);

-- Minimal impression log — only what pacing needs. Fire-and-forget insert
-- from the client after a render; no visitor identity, so it stays inside
-- the existing zero-PII posture of active_featured().
create table if not exists public.featured_impressions (
  id           bigint generated always as identity primary key,
  placement_id uuid not null references public.featured_placements (id) on delete cascade,
  occurred_at  timestamptz not null default now()
);
create index if not exists featured_impressions_pace_idx
  on public.featured_impressions (placement_id, occurred_at);

create or replace function public.log_featured_impression(p_placement_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.featured_impressions (placement_id) values (p_placement_id);
$$;
grant execute on function public.log_featured_impression(uuid) to anon, authenticated;
```

### 3b. Weighted sampling: the SQL trick

Two standard options; the sketch below uses the second:

- **Cumulative-weight trick**: running `sum(weight) over (order by id)`,
  draw one `random() * total_weight`, take the first row whose cumulative
  sum clears it. Classic, but only picks one row per query — filling N slots
  needs N sequential draws (excluding prior picks each time).
- **Efraimidis–Spirakis exponential-key trick** (used below): give every row
  a key `u^(1/weight)` where `u` is uniform(0,1]; `order by key desc limit N`
  is a correct weighted sample of N rows *without replacement* in one pass —
  no window functions, no running totals, degrades cleanly to "top row" at N=1.

### 3c. Deterministic-per-session rotation

Swap `random()` for a hash of `(session_seed, hour_bucket, placement_id)`.
Same visitor + same hour → same pick (no flicker on re-render); the bucket
advances every hour so the whole pool rotates over the day even for
visitors who never come back. `p_session_seed` is client-generated
(`crypto.randomUUID()` stashed in `sessionStorage`) — still zero PII, it's
scoped to a tab session, not a person.

### 3d. The function

```sql
create or replace function public.pick_featured(
  p_surface       text,
  p_region        text default null,
  p_session_seed  text default null
)
returns table (
  placement_id uuid, campaign_id uuid, business_id uuid, business_name text,
  bathroom_id uuid, creative jsonb, region text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_capacity int;
  v_seed     text := coalesce(p_session_seed, md5(random()::text || clock_timestamp()::text));
  v_bucket   text := to_char(date_trunc('hour', now()), 'YYYYMMDDHH24');
begin
  if not coalesce(
    (select (value)::boolean from public.growth_settings where key = 'promotions_enabled'), true
  ) then
    return; -- kill switch, same as active_featured()
  end if;

  select coalesce((value ->> p_surface)::int, 1) into v_capacity
  from public.growth_settings where key = 'featured_capacity';
  v_capacity := coalesce(v_capacity, 1);

  return query
  with eligible as (
    select
      fp.id as placement_id, fp.campaign_id, fp.business_id, b.name as business_name,
      fp.bathroom_id, c.creative, fp.region, fp.weight, fp.daily_impression_cap,
      (
        select count(*) from public.featured_impressions fi
        where fi.placement_id = fp.id and fi.occurred_at >= date_trunc('day', now())
      ) as delivered_today
    from public.featured_placements fp
    join public.ad_campaigns c on c.id = fp.campaign_id and c.status = 'running'
    join public.businesses  b on b.id = fp.business_id and b.suspended_at is null
    where fp.surface = p_surface
      and now() between fp.starts_at and fp.ends_at
      and (p_region is null or fp.region is null or fp.region = p_region)
  ),
  paced as (
    select e.*,
      -- expected-by-now vs delivered-so-far; boost laggards, damp leaders;
      -- clamp so one campaign can never be zeroed out or run away entirely
      case when e.daily_impression_cap is null then 1.0
        else greatest(0.2, least(3.0,
          (e.daily_impression_cap
             * extract(epoch from (now() - date_trunc('day', now()))) / 86400.0 + 1)
          / greatest(1, e.delivered_today)
        ))
      end as pace_multiplier
    from eligible e
  ),
  keyed as (
    select p.*,
      power(
        greatest(
          ((hashtext(v_seed || ':' || v_bucket || ':' || p.placement_id::text)
             & 2147483647)::float8 / 2147483647.0),
          0.0000001  -- avoid u = 0
        ),
        1.0 / (p.weight * p.pace_multiplier)
      ) as sample_key
    from paced p
  )
  select placement_id, campaign_id, business_id, business_name, bathroom_id, creative, region
  from keyed
  order by sample_key desc
  limit v_capacity;
end;
$$;
grant execute on function public.pick_featured(text, text, text) to anon, authenticated;
```

### 3e. Rollout notes

- `active_featured()` stays as-is; `pick_featured()` is additive, ships
  behind a flag, swaps in per-surface without breaking
  `src/lib/api/growth.ts`'s `activeFeatured()` caller.
- `weight` defaults to 100 on every existing row → first migration is a
  behavioral no-op beyond capacity-N vs capacity-1.
- Pacing is opt-in per placement (`daily_impression_cap` null by default) —
  ships inert, an admin turns it on only if an advertiser is racing through
  its budget early.
- `log_featured_impression` is fire-and-forget; if never called,
  `delivered_today` stays 0 and `pace_multiplier` clamps to its max (3.0)
  rather than dividing by zero — pacing degrades to a no-op-ish boost, not a
  crash.

---

### Sources
- [Delivery Options](https://revive-adserver.atlassian.net/wiki/display/DOCS/Delivery+Options)
- [Creating a Campaign](https://revive-adserver.atlassian.net/wiki/display/DOCS/Creating+a+Campaign)
- [Contract Campaigns Under-Delivering](https://revive-adserver.atlassian.net/wiki/display/DOCS/Contract+Campaigns+Under-Delivering)
- [How to use Campaign Types](https://www.revive-adserver.com/how-to/use-campaign-types/)
- [Frequency Capping plugin](https://reviveadservermod.com/frequency-capping)
- Search-result summaries of `lib/OA/Maintenance/Priority.php` and
  Maintenance Settings docs (probability recalculation cadence — names only,
  no source read).
