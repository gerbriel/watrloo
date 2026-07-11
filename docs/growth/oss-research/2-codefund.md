# CodeFund (gitcoinco/code_fund_ads) — schema & rollup research for Watrloo's ad platform

**LICENSE WARNING: AGPL-3.0.** CodeFund's code and schema DDL are copyleft. Nothing
below is a copy-paste source — every SQL block under "PORT PLAN" is written from
scratch against Watrloo's own `ad_campaigns`/`businesses` tables, using CodeFund only
as a design reference (concepts: partitioning strategy, rollup shape, budget-pacing
math). Do not vendor CodeFund's `db/schema.rb`, `db/structure.sql`, or any `.rb` file
into this repo.

Source inspected: shallow clone of `gitcoinco/code_fund_ads` @ default branch,
`db/structure.sql` (993-line `schema.rb` doesn't capture the partition DDL — the raw
SQL dump does), plus `app/models/{daily_summary,impression,campaign}.rb`,
`app/models/concerns/{impressionable,campaigns/budgetable,impressions/partitionable}.rb`,
`app/jobs/{create_daily_summar*,ensure_daily_summaries,create_debits_for_campaigns}*.rb`,
`lib/tasks/{schedule,data_retention}.rake`.

---

## 1. Schema distilled

### campaigns
Advertiser's IO. Fields that matter for a port:
- Budget: `total_budget_cents`, `daily_budget_cents`, `hourly_budget_cents` (auto-derived,
  see §3), all with a paired `*_currency` column (they support multi-currency via the
  `money-rails` gem — Watrloo can skip this and hardcode USD).
- Pricing: `ecpm_cents` + `fixed_ecpm` (bool — false means price comes from a
  region/audience table instead) + `ecpm_multiplier` (numeric, default 1.0, applied on
  top of the region rate).
- Targeting: `country_codes[]`, `province_codes[]`, `keywords[]`, `negative_keywords[]`,
  `assigned_property_ids[]` / `prohibited_property_ids[]` (allow/deny list of inventory),
  `audience_ids[]`, `region_ids[]`.
- Scheduling: `start_date`, `end_date`, `core_hours_only`, `weekdays_only`.
- `fallback` (bool — house/PSA ad shown when no paid campaign wins) and
  `paid_fallback`. `creative_ids[]` (a campaign can rotate multiple creatives).

### creatives
Deliberately thin: `name`, `headline`, `body`, `cta`, `status` (pending/approved/...),
`creative_type` (standard vs sponsor). Images live in a separate `creative_images` →
`active_storage_attachments` join (Rails' file-upload abstraction — irrelevant to us,
we'd use a Supabase Storage bucket + `creative jsonb` like `ad_campaigns.creative`
already does).

### properties (= the publisher's ad slot — CodeFund is a **multi-tenant** network)
`user_id` (publisher), `revenue_percentage` (numeric, default **0.6** — the publisher's
cut of gross revenue; CodeFund/"the house" keeps the rest), `ad_template`/`ad_theme`
(rendering variant), `keywords[]` (contextual targeting signal), `audience_id`,
`assigned_fallback_campaign_ids[]`, `prohibit_fallback_campaigns`,
`restrict_to_assigner_campaigns`, `prohibited_organization_ids[]` (per-property
advertiser blocklist), soft-delete via `deleted_at`.
`property_advertisers` is a plain join table (property_id, advertiser_id) used to track
which advertisers have ever served on a property — no unique business logic.
**This entire concept doesn't map to Watrloo**: we have no third-party publisher
inventory — Watrloo *is* the single publisher, and "property" collapses to our existing
`ad_campaigns.surface` enum (`browse`/`map`/`detail`/`newsletter`) plus `bathroom_id`.
See §4 for the resulting simplification.

### impressions (raw event log — the interesting one)
UUID PK (`gen_random_uuid()`), FKs to `advertiser_id`/`publisher_id`/`campaign_id`/
`creative_id`/`property_id`/`organization_id`, `ip_address` (MD5-hashed with a salt
before storage — see `Impression.obfuscate_ip_address`, never stored raw),
`country_code`/`province_code`/`postal_code`/lat/long (coarse geo, no precise
location), `displayed_at` + `displayed_at_date` (denormalized date column — this is
what every rollup groups and partitions on), `clicked_at` + `clicked_at_date`
(nullable — click is an update to the same row, not a second row), `fallback_campaign`
(bool), `uplift` (bool — a house/PSA impression that got upgraded), and three
**per-event revenue columns as `float` "fractional cents"** (not integer cents —
this matters, see §3): `estimated_gross_revenue_fractional_cents`,
`estimated_property_revenue_fractional_cents`, `estimated_house_revenue_fractional_cents`.

**Partitioning strategy** (from `db/structure.sql`, not visible in `schema.rb`):
```sql
CREATE TABLE public.impressions ( ... )
PARTITION BY RANGE (advertiser_id, displayed_at_date);

CREATE TABLE public.impressions_default ( ... );  -- catch-all
ALTER TABLE ONLY public.impressions ATTACH PARTITION public.impressions_default DEFAULT;
```
Partitions are **created lazily, per (advertiser, month)**, in a `before_create` hook
(`Impressions::Partitionable#assure_partition_table!`), named
`impressions_YYYY_MM_advertiser_<id>`:
```ruby
CREATE TABLE public.impressions_2024_03_advertiser_512 PARTITION OF public.impressions
FOR VALUES FROM (512, '2024-03-01') TO (512, '2024-04-01');
```
Every index (`campaign_id`, `property_id`, `country_code`, `clicked_at_date`,
`date_trunc('hour', displayed_at)`, etc.) is declared `ON ONLY public.impressions`, so
Postgres auto-propagates it to every partition attached later — no manual per-partition
index maintenance. Retention is a 3-step pipeline, all cron'd via Heroku Scheduler
(`lib/tasks/schedule.rake` + `data_retention.rake`):
1. `Impression.detach_old_tables` (daily) — `ALTER TABLE impressions DETACH PARTITION ...`
   once a partition's month is more than `MIN_MONTHS_RETAINED` (1) months old. Detaching
   is instant (no data movement) and immediately removes the table from query planning
   and from the retained/queryable dataset.
2. `rake data:archive_impressions` — `pg_dump --table=<partition>` each detached table,
   upload to S3, then `DROP TABLE` only after a successful upload (checks
   `object.content_length > 0` before dropping — don't drop on a failed upload).
3. Detached-but-not-yet-dropped tables are still just regular tables (`impressions_...`
   name pattern, no longer partitions) — a `detached_table_names` class method finds them
   by name via `information_schema.tables`.

The advertiser dimension in the partition key is the load-bearing design choice: it lets
CodeFund delete *one advertiser's* raw data independently (contract-driven retention —
an advertiser who stops paying can have their raw impressions purged on their own
schedule) without touching anyone else's partitions, and it keeps `WHERE advertiser_id =
? AND displayed_at_date BETWEEN ? AND ?` (their most common advertiser-dashboard query)
a single-partition scan.

### daily_summaries (the rollup table)
```sql
CREATE TABLE public.daily_summaries (
    id bigint NOT NULL,
    impressionable_type character varying NOT NULL,   -- 'Campaign' | 'Property'
    impressionable_id bigint NOT NULL,
    scoped_by_type character varying,                  -- NULL | 'Campaign' | 'Property' | 'Creative' | 'country_code'
    scoped_by_id character varying,                     -- NULL | fk id (as string) | ISO country code
    impressions_count integer DEFAULT 0 NOT NULL,
    fallbacks_count integer DEFAULT 0 NOT NULL,
    fallback_percentage numeric DEFAULT 0.0 NOT NULL,
    clicks_count integer DEFAULT 0 NOT NULL,
    click_rate numeric DEFAULT 0.0 NOT NULL,
    ecpm_cents integer DEFAULT 0 NOT NULL,
    cost_per_click_cents integer DEFAULT 0 NOT NULL,
    gross_revenue_cents integer DEFAULT 0 NOT NULL,
    property_revenue_cents integer DEFAULT 0 NOT NULL,
    house_revenue_cents integer DEFAULT 0 NOT NULL,
    displayed_at_date date NOT NULL,
    unique_ip_addresses_count integer DEFAULT 0 NOT NULL,
    fallback_clicks_count bigint DEFAULT 0 NOT NULL,
    created_at / updated_at
);
```
`impressionable` (polymorphic: Campaign-scoped row or Property-scoped row) is the
**primary** rollup dimension; `scoped_by` (also polymorphic, optional) is a **secondary**
dimension so the same day's data can be sliced by campaign×property, campaign×creative,
campaign×country, property×campaign, etc. — one row per (entity, secondary-dimension,
day) combination that actually has traffic (no zero rows are pre-materialized). `ecpm`,
`cost_per_click`, `fallback_percentage`, `click_rate` are **derived on save** (Rails
`before_save` callbacks doing plain division — see §2), not computed at query time.

---

## 2. Rollup design

**One row is written per (impressionable, scoped_by, day) via a single grouped SQL
query**, `app/jobs/create_daily_summary_job.rb`:
```ruby
rollup = Impression.connection.exec_query(
  impressionable.impressions.on(date).scoped_by(scoped_by, scoped_by_type)
    .select(Arel.star.count.as("impressions_count"))
    .select("count(*) FILTER (WHERE fallback_campaign = true) AS fallbacks_count")
    .select("count(*) FILTER (WHERE clicked_at_date IS NOT NULL) AS clicks_count")
    .select("count(*) FILTER (WHERE fallback_campaign = true AND clicked_at_date IS NOT NULL) AS fallback_clicks_count")
    .select("count(DISTINCT ip_address) AS unique_ip_addresses_count")
    .select("round(sum(estimated_gross_revenue_fractional_cents)) AS gross_revenue_cents")
    .select("round(sum(estimated_property_revenue_fractional_cents)) AS property_revenue_cents")
    .select("round(sum(estimated_house_revenue_fractional_cents)) AS house_revenue_cents")
    .to_sql
).first
impressionable.daily_summaries.on(date).scoped_by(scoped_by, scoped_by_type).first_or_create!(rollup)
```
Notice: `FILTER (WHERE ...)` for conditional counts in one pass, `round(sum(...))` only
at the very end (rounding fractional cents to integer cents happens once, at rollup
time, never per-row — see §3 for why). Idempotent (`first_or_create!`, rescues
`RecordNotUnique` from a race) and **skips days/entities with zero impressions
entirely** — no wasted rows, no zero-padding at write time (zero-padding for a
continuous chart happens client-side, in `Impressionable#daily_impressions_counts`,
which fills gaps in a `(start_date..end_date)` range with `0` after pulling summaries).

**Scheduling** (`lib/tasks/schedule.rake`, run daily by Heroku Scheduler — the
functional equivalent of `pg_cron`):
- `EnsureDailySummariesJob` — for the last 7 days, for every campaign/property that
  `available_on?(date)` **and has at least one impression that day**, enqueue
  `CreateDailySummariesJob` (unscoped, `scoped_by = nil`). The 7-day lookback (not just
  "yesterday") is the backfill/straggler safety net — a job that failed 3 days ago gets
  silently retried by the next day's run rather than needing a manual replay.
- `EnsureScopedDailySummariesJob` — same 7-day loop, but additionally fans out one job
  per **distinct country_code**, per **distinct property** (for a campaign) / per
  **distinct campaign** (for a property), and per **distinct creative** actually seen
  that day (`impressions.distinct.pluck(:country_code)` etc.) — so the fan-out is
  bounded by *actual* cardinality, not the full catalog.
- A separate, unrelated task fixes up `fallback_clicks_count` retroactively in
  10k-row batches — evidence this table gets backfilled/patched in place after schema
  additions, not treated as strictly append-only.

**Indexes that make dashboards cheap:**
```sql
CREATE INDEX index_daily_summaries_on_displayed_at_date ON daily_summaries (displayed_at_date);
CREATE INDEX index_daily_summaries_on_impressionable_columns ON daily_summaries (impressionable_type, impressionable_id);
CREATE INDEX index_daily_summaries_on_scoped_by_columns ON daily_summaries (scoped_by_type, scoped_by_id);
CREATE UNIQUE INDEX index_daily_summaries_uniqueness
  ON daily_summaries (impressionable_type, impressionable_id, scoped_by_type, scoped_by_id, displayed_at_date);
CREATE UNIQUE INDEX index_daily_summaries_unscoped_uniqueness
  ON daily_summaries (impressionable_type, impressionable_id, displayed_at_date)
  WHERE (scoped_by_type IS NULL AND scoped_by_id IS NULL);
```
The **partial unique index** for the unscoped case is the key trick: Postgres unique
indexes treat `NULL <> NULL`, so a plain unique index on all 5 columns would let
duplicate unscoped rows through. The `WHERE scoped_by_type IS NULL` partial index closes
that hole cheaply instead of coalescing `scoped_by_id` to a sentinel string.
A campaign's 90-day dashboard is then `WHERE impressionable_type='Campaign' AND
impressionable_id=? AND scoped_by_type IS NULL AND displayed_at_date BETWEEN ? AND ?`
— an index-only scan on the uniqueness index, touching at most 90 rows, regardless of
how many millions of raw impressions back it.

---

## 3. Budget & spend accounting

**Per-event revenue split** (`app/models/impression.rb`), computed once at
`before_create` and frozen on the row (not recomputed later even if the campaign's ecpm
changes):
```ruby
def applicable_ecpm
  return campaign.adjusted_ecpm(country_code) if campaign.campaign_pricing_strategy?
  region.ecpm(audience) * campaign.ecpm_multiplier   # region/audience pricing strategy
end

def calculate_estimated_gross_revenue_fractional_cents
  applicable_ecpm.cents / 1_000.to_f                  # eCPM / 1000 = price of ONE impression
end

def calculate_estimated_property_revenue_fractional_cents
  calculate_estimated_gross_revenue_fractional_cents * property.revenue_percentage   # publisher's cut (default 60%)
end

def calculate_estimated_house_revenue_fractional_cents
  calculate_estimated_gross_revenue_fractional_cents - calculate_estimated_property_revenue_fractional_cents  # CodeFund's cut
end
```
**Why `float` "fractional cents" and not integer cents per row:** at typical eCPMs
($1–$5), one impression is worth $0.001–$0.005 — sub-cent. Storing integer cents per
row would round every single impression to `$0.00` and silently zero out all revenue.
CodeFund stores the *unrounded* fractional value per impression and only calls
`round(sum(...))` once, at daily-summary rollup time (§2) — rounding error is bounded to
±$0.005 per (entity, day) instead of compounding across millions of rows.

**Budget hierarchy** (`total_budget_cents` → `daily_budget_cents` →
`hourly_budget_cents`), `app/models/concerns/campaigns/budgetable.rb`:
- `hourly_budget` auto-derives from `daily_budget` if unset, clamped:
  `hourly = daily / 8`, floored at `daily / 18` — i.e. never less than ~1.3 hours' worth
  even if the derived 1/8th would starve pacing during low-traffic hours.
- `total_budget` auto-derives as `total_operative_days * daily_budget` when only a daily
  cap was set (campaign-pricing strategy) — so advertisers can set either dial.
- **Consumed budget is `gross_revenue(start_date, end_date)`**, which reads
  `daily_summaries` first (cheap, cached in `Rails.cache` for 1 hour) and only falls back
  to a live `SUM()` over the partitioned `impressions` table for dates that don't have a
  summary row yet (i.e., today, before the nightly rollup has run) — daily_summaries is
  explicitly a **cache with a live-query fallback**, not the sole source of truth.
- **Hourly pacing is real-time and DB-free**: `hourly_consumed_budget_fractional_cents`
  is an in-process `Rails.cache` counter, *incremented* by
  `increment_hourly_consumed_budget_fractional_cents(amount)` at the moment an
  impression is served — so the "can I still serve this campaign this hour?" check
  (`hourly_budget_available?`) never touches Postgres at all on the hot path.
- Availability gates compose: `budget_available?` (org balance > 0 AND remaining total
  budget > 0) → `daily_budget_available?` → `hourly_budget_available?`. All three are
  checked before serving an impression.
- Pacing diagnostics: `average_daily_spend` (actual, from summaries) vs
  `estimated_daily_spend` (`total_remaining_budget / remaining_operative_days`) drive
  `pacing_too_slow?` / `pacing_too_fast?` / `should_increase_caps?` — used to
  auto-suggest eCPM or inventory changes, not applied automatically.

**Organization-level ledger** (dollars *actually* owed/paid, separate from campaign
budget dials): `organizations.balance_cents` is a cached balance;
`organization_transactions` (`amount_cents`, `transaction_type`, `posted_at`,
`description`, `reference`, `gift`/`temporary` flags) is the append-only ledger.
`CreateDebitsForCampaignsJob` runs daily, looks back **10 days** (straggler safety net,
same pattern as the summary jobs), and enqueues one `CreateDebitForCampaignAndDateJob`
per campaign per day to post a debit transaction sized to that day's `gross_revenue`.
`RecalculateOrganizataionBalancesJob` runs daily to reconcile the cached
`balance_cents` against the transaction sum — the cached column is a performance
optimization, the ledger is the source of truth, and drift gets corrected nightly.

---

## 4. PORT PLAN for Supabase (concept-port only — no CodeFund code/DDL reused)

**What we're NOT porting, and why:** `properties`, `property_advertisers`,
`property_traffic_estimates` — CodeFund is a multi-tenant ad network serving many
third-party publisher sites; Watrloo *is* the one publisher. Our "property" collapses to
`ad_campaigns.surface` (already an enum: browse/map/detail/newsletter) and
`bathroom_id`. No publisher revenue-share split (`property_revenue`/`house_revenue`) is
needed — Watrloo keeps 100% of ad spend (v1; a future third-party-embed program could
reintroduce the split). The polymorphic `impressionable`/`scoped_by` pattern is
overkill for one entity type (campaigns) — a plain FK is simpler and just as fast for
our scale. Per-advertiser monthly partitions solve a contract-driven per-advertiser
deletion problem CodeFund has and we don't (yet) — start with plain monthly partitions.

### 4a. Raw event log — `ad_events`
```sql
create table public.ad_events (
  id           uuid not null default gen_random_uuid(),
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  bathroom_id  uuid references public.bathrooms (id) on delete set null,
  surface      text not null check (surface in ('browse','map','detail','newsletter')),
  region       text,
  event_type   text not null check (event_type in ('impression','click')),
  session_hash text,              -- salted hash of a rotating client id; never a raw IP (privacy-first, per AD_PLATFORM_IDEAS.md #10)
  occurred_at  timestamptz not null default now(),
  occurred_on  date not null default (now() at time zone 'utc')::date,
  spend_fractional_cents double precision not null default 0,  -- see CodeFund note: don't round per-row at sub-cent eCPMs
  primary key (id, occurred_on)
) partition by range (occurred_on);

create table public.ad_events_default partition of public.ad_events default;

create index ad_events_campaign_day_idx on public.ad_events (campaign_id, occurred_on);
create index ad_events_business_day_idx on public.ad_events (business_id, occurred_on);

alter table public.ad_events enable row level security;
create policy "business members read their own events" on public.ad_events
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
-- No insert/update/delete grants to anon/authenticated at all — writes go only
-- through record_ad_event() (SECURITY DEFINER), matching the existing
-- record-through-RPC pattern already used for dispatch_inapp_blasts().
```

Insert-path RPC (mirrors CodeFund's `before_create` revenue calc, done in the RPC
instead of a model callback since there's no ORM layer):
```sql
create or replace function public.record_ad_event(
  p_campaign_id uuid, p_event_type text, p_surface text,
  p_bathroom_id uuid default null, p_region text default null,
  p_session_hash text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_ecpm_cents int;
begin
  select business_id, ecpm_cents into v_business, v_ecpm_cents
  from public.ad_campaigns where id = p_campaign_id and status = 'running';
  if v_business is null then return; end if;  -- drop events for non-running/unknown campaigns silently

  insert into public.ad_events
    (campaign_id, business_id, bathroom_id, surface, region, event_type, session_hash, spend_fractional_cents)
  values
    (p_campaign_id, v_business, p_bathroom_id, p_surface, p_region, p_event_type, p_session_hash,
     case when p_event_type = 'impression' then v_ecpm_cents / 1000.0 else 0 end);
end; $$;
grant execute on function public.record_ad_event(uuid,text,text,uuid,text,text) to anon, authenticated;
```

### 4b. Rollup table — `ad_daily_stats`
One row per campaign × day (`surface = '__all__'`) plus one row per campaign × day ×
surface — the CodeFund "primary + optional secondary scope" idea, flattened to a single
non-polymorphic table since we only ever scope by surface:
```sql
create table public.ad_daily_stats (
  campaign_id     uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id     uuid not null references public.businesses (id) on delete cascade,
  day             date not null,
  surface         text not null default '__all__',
  impressions     integer not null default 0,
  clicks          integer not null default 0,
  unique_sessions integer not null default 0,
  spend_cents     integer not null default 0,   -- rounded once, here, not per-event
  updated_at      timestamptz not null default now(),
  primary key (campaign_id, day, surface)
);
create index ad_daily_stats_business_day_idx on public.ad_daily_stats (business_id, day desc);

alter table public.ad_daily_stats enable row level security;
create policy "business members read their own stats" on public.ad_daily_stats
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
```

Rollup function, idempotent upsert (replaces CodeFund's `first_or_create!` + Ruby loop
with a single set-based statement), scheduled via `pg_cron` on the same 15-minute
cadence already used for `growth_dispatch_inapp` in this repo:
```sql
create or replace function public.rollup_ad_daily_stats(p_since date default (current_date - 2))
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ad_daily_stats (campaign_id, business_id, day, surface, impressions, clicks, unique_sessions, spend_cents)
  select campaign_id, business_id, occurred_on, surface,
         count(*) filter (where event_type = 'impression'),
         count(*) filter (where event_type = 'click'),
         count(distinct session_hash),
         round(sum(spend_fractional_cents))::int
  from public.ad_events
  where occurred_on >= p_since and occurred_on <= current_date
  group by campaign_id, business_id, occurred_on, surface
  union all
  select campaign_id, business_id, occurred_on, '__all__',
         count(*) filter (where event_type = 'impression'),
         count(*) filter (where event_type = 'click'),
         count(distinct session_hash),
         round(sum(spend_fractional_cents))::int
  from public.ad_events
  where occurred_on >= p_since and occurred_on <= current_date
  group by campaign_id, business_id, occurred_on
  on conflict (campaign_id, day, surface) do update
    set impressions = excluded.impressions, clicks = excluded.clicks,
        unique_sessions = excluded.unique_sessions, spend_cents = excluded.spend_cents,
        updated_at = now();
end; $$;

select cron.schedule('growth_rollup_ad_stats', '*/15 * * * *', $$select public.rollup_ad_daily_stats()$$);
```
Note `p_since = current_date - 2` (not just "today") is CodeFund's straggler-safety-net
idea (their 7-day lookback), scaled down since our cron runs every 15 minutes instead of
once daily. Today's row is intentionally re-upserted every run for live pacing.

### 4c. Budget fields on `ad_campaigns` + spend gate
```sql
alter table public.ad_campaigns
  add column total_budget_cents integer not null default 0,
  add column daily_budget_cents integer not null default 0,
  add column ecpm_cents         integer not null default 0,  -- price per 1000 impressions, USD cents

  add constraint ad_campaigns_budget_nonneg
    check (total_budget_cents >= 0 and daily_budget_cents >= 0 and ecpm_cents >= 0);

create or replace function public.campaign_spend(p_campaign_id uuid, p_since date default null)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(sum(spend_cents), 0)::int
  from public.ad_daily_stats
  where campaign_id = p_campaign_id and surface = '__all__'
    and (p_since is null or day >= p_since);
$$;

-- Gate check to add inside record_ad_event() (§4a) before inserting an impression:
--   if public.campaign_spend(p_campaign_id) >= (select total_budget_cents from ad_campaigns where id = p_campaign_id)
--     then return; end if;  -- budget exhausted, decline to serve/bill
-- Daily cap follows the same shape with p_since := current_date.
```
Skip CodeFund's separate `organization_transactions` ledger for v1 — Watrloo's own
`AD_PLATFORM_IDEAS.md` §05 already proposes an "ad wallet" credit ledger; wire
`campaign_spend()` as its debit source when that lands, rather than duplicating a ledger
here.

### 4d. Partitioning & retention (simplified from per-advertiser to per-month)
```sql
create or replace function public.ensure_ad_events_partition(p_month date default date_trunc('month', now())::date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_name text := 'ad_events_' || to_char(p_month, 'YYYY_MM');
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if to_regclass('public.' || v_name) is null then
    execute format('create table public.%I partition of public.ad_events for values from (%L) to (%L)',
                    v_name, v_start, v_end);
  end if;
end; $$;

-- Create this month's and next month's partition on the 1st of every month.
select cron.schedule('growth_ensure_ad_events_partition', '0 0 1 * *', $$
  select public.ensure_ad_events_partition();
  select public.ensure_ad_events_partition((date_trunc('month', now()) + interval '1 month')::date);
$$);

-- Raw events: keep 3 months, then drop (aggregates in ad_daily_stats are kept forever —
-- they're tiny and carry no PII). No S3-archive step for v1; add one only if raw-event
-- replay is ever a real requirement.
create or replace function public.prune_old_ad_events(p_retain_months int default 3)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text; v_cutoff date := date_trunc('month', now() - (p_retain_months || ' months')::interval)::date;
begin
  for v_name in
    select child.relname from pg_inherits
    join pg_class child on pg_inherits.inhrelid = child.oid
    join pg_class parent on pg_inherits.inhparent = parent.oid
    where parent.relname = 'ad_events' and child.relname ~ '^ad_events_\d{4}_\d{2}$'
  loop
    if to_date(right(v_name, 7), 'YYYY_MM') < v_cutoff then
      execute format('drop table if exists public.%I', v_name);
    end if;
  end loop;
end; $$;

select cron.schedule('growth_prune_ad_events', '30 0 1 * *', $$select public.prune_old_ad_events()$$);
```
Escalate to CodeFund's per-(advertiser, month) partitioning only if/when a business
needs its raw ad data deleted on its own schedule independent of everyone else's (a
contract/DPA requirement, not a performance one at Watrloo's likely scale).
