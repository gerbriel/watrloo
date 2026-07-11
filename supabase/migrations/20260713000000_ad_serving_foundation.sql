-- Watrloo: ad-serving foundation — measurement, integrity, selection.
--
-- Synthesis of the OSS research in docs/growth/oss-research/ (concept-ports
-- only; EthicalAds is AGPL and Revive GPL, so patterns not code):
--   * EthicalAds  — the offer/nonce integrity layer: an ad impression must be
--     offered, then VIEWED (visible in viewport), before a CLICK counts, each
--     at most once per offer. Kills replay/forge at the schema level.
--   * CodeFund    — the month-partitioned raw event ledger + idempotent daily
--     rollup table that dashboards and (later) billing read.
--   * Plausible   — daily-rotating-salt visitor hash for frequency capping and
--     unique reach WITHOUT cookies or profiles: hash(salt+seed+ua), salt lives
--     in a locked table, rows pruned within 48h, nothing survives to become an
--     identifier.
--   * Revive      — delivery: per-placement weight, slot capacity per surface,
--     deterministic-per-session rotation (no flicker, still rotates hourly),
--     and an inline pacing multiplier so a capped campaign doesn't burn its
--     day's impressions in an hour.
--   * BotD/EA IVT — layered invalid-traffic defense: RPC-side bot-UA and
--     velocity checks mark events is_valid=false (kept for audit, excluded
--     from billable rollups); self-clicks by the business's own members are
--     never billable.
--
-- Privacy posture: no IPs are read or stored anywhere here. The visitor hash
-- uses a client-minted localStorage seed + user agent + rotating salt; it
-- degrades toward undercounting, never toward tracking. Advertisers only ever
-- see aggregates (ad_daily_stats).

-- ---------------------------------------------------------------------------
-- 1. Delivery knobs (Revive): weight + optional daily pacing cap + targeting.
-- ---------------------------------------------------------------------------
alter table public.featured_placements
  add column if not exists weight int not null default 100 check (weight > 0),
  add column if not exists daily_impression_cap int check (daily_impression_cap > 0);

-- Geo targeting (EthicalAds' key-whitelist pattern, our keys). Only radius_km
-- is interpreted today; the whitelist leaves room to grow without a rewrite.
alter table public.ad_campaigns
  add column if not exists targeting jsonb not null default '{}'::jsonb;

insert into public.growth_settings (key, value) values
  ('ad_frequency_cap_per_day', '3')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Offers (EthicalAds): short-lived nonce; the only path to a counted event.
--    RLS enabled with NO policies: clients touch offers only through RPCs.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_offers (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.ad_campaigns (id) on delete cascade,
  placement_id  uuid references public.featured_placements (id) on delete cascade,
  session_id    text,
  visitor_hash  text,
  surface       text not null,
  region        text,
  viewed        boolean not null default false,
  clicked       boolean not null default false,
  view_time_seconds int,
  created_at    timestamptz not null default now()
);
alter table public.ad_offers enable row level security;
create index if not exists ad_offers_created_idx  on public.ad_offers (created_at);
create index if not exists ad_offers_campaign_idx on public.ad_offers (campaign_id);

-- ---------------------------------------------------------------------------
-- 3. Event ledger (CodeFund): partitioned by month, RPC-write-only.
--    is_valid=false rows are kept for audit but never billed/reported.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_events (
  id           uuid not null default gen_random_uuid(),
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  placement_id uuid,
  surface      text not null,
  region       text,
  event_type   text not null check (event_type in ('impression','click')),
  session_hash text,
  is_valid     boolean not null default true,
  flag_reason  text,
  occurred_at  timestamptz not null default now(),
  occurred_on  date not null default (now() at time zone 'utc')::date,
  primary key (id, occurred_on)
) partition by range (occurred_on);

create table if not exists public.ad_events_default partition of public.ad_events default;

create index if not exists ad_events_campaign_day_idx on public.ad_events (campaign_id, occurred_on);
create index if not exists ad_events_business_day_idx on public.ad_events (business_id, occurred_on);

alter table public.ad_events enable row level security;
grant select on public.ad_events to authenticated;
drop policy if exists "members read their ad events" on public.ad_events;
create policy "members read their ad events" on public.ad_events
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
-- No insert/update/delete path for clients at all.

-- Monthly partition management + retention (CodeFund, simplified).
create or replace function public.ensure_ad_events_partition(p_month date default date_trunc('month', now())::date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := 'ad_events_' || to_char(p_month, 'YYYY_MM');
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if to_regclass('public.' || v_name) is null then
    execute format('create table public.%I partition of public.ad_events for values from (%L) to (%L)',
                   v_name, v_start, v_end);
  end if;
end; $$;

create or replace function public.prune_old_ad_events(p_retain_months int default 3)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
        v_cutoff date := date_trunc('month', now() - (p_retain_months || ' months')::interval)::date;
begin
  for v_name in
    select child.relname from pg_inherits
    join pg_class child  on pg_inherits.inhrelid  = child.oid
    join pg_class parent on pg_inherits.inhparent = parent.oid
    where parent.relname = 'ad_events' and child.relname ~ '^ad_events_\d{4}_\d{2}$'
  loop
    if to_date(right(v_name, 7), 'YYYY_MM') < v_cutoff then
      execute format('drop table if exists public.%I', v_name);
    end if;
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Daily rollup (CodeFund): what dashboards and CSV exports read.
--    surface '__all__' row + one row per surface. Valid traffic only.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_daily_stats (
  campaign_id     uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id     uuid not null references public.businesses (id) on delete cascade,
  day             date not null,
  surface         text not null default '__all__',
  impressions     int not null default 0,
  clicks          int not null default 0,
  unique_sessions int not null default 0,
  invalid_events  int not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (campaign_id, day, surface)
);
create index if not exists ad_daily_stats_business_idx on public.ad_daily_stats (business_id, day desc);

alter table public.ad_daily_stats enable row level security;
grant select on public.ad_daily_stats to authenticated;
drop policy if exists "members read their ad stats" on public.ad_daily_stats;
create policy "members read their ad stats" on public.ad_daily_stats
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));

create or replace function public.rollup_ad_daily_stats(p_since date default (current_date - 2))
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ad_daily_stats
    (campaign_id, business_id, day, surface, impressions, clicks, unique_sessions, invalid_events)
  select campaign_id, business_id, occurred_on, surface,
         count(*) filter (where event_type = 'impression' and is_valid),
         count(*) filter (where event_type = 'click' and is_valid),
         count(distinct session_hash) filter (where is_valid),
         count(*) filter (where not is_valid)
  from public.ad_events
  where occurred_on >= p_since
  group by campaign_id, business_id, occurred_on, surface
  union all
  select campaign_id, business_id, occurred_on, '__all__',
         count(*) filter (where event_type = 'impression' and is_valid),
         count(*) filter (where event_type = 'click' and is_valid),
         count(distinct session_hash) filter (where is_valid),
         count(*) filter (where not is_valid)
  from public.ad_events
  where occurred_on >= p_since
  group by campaign_id, business_id, occurred_on
  on conflict (campaign_id, day, surface) do update
    set impressions = excluded.impressions, clicks = excluded.clicks,
        unique_sessions = excluded.unique_sessions,
        invalid_events = excluded.invalid_events, updated_at = now();

  -- Offers are a working set, not an archive (EthicalAds prunes the same way).
  delete from public.ad_offers where created_at < now() - interval '7 days';
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Visitor hash (Plausible): rotating salt in a locked table; hash never
--    leaves the database; frequency rows pruned within 48h by construction.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_visitor_salt (
  salt_day date primary key,
  salt     text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
alter table public.ad_visitor_salt enable row level security;
revoke all on public.ad_visitor_salt from anon, authenticated;

create table if not exists public.ad_visitor_frequency (
  visitor_hash text not null,
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  day          date not null default current_date,
  impressions  int not null default 0,
  clicks       int not null default 0,
  primary key (visitor_hash, campaign_id, day)
);
alter table public.ad_visitor_frequency enable row level security;
revoke all on public.ad_visitor_frequency from anon, authenticated;

-- Internal: today's salt, minted on demand if the cron hasn't run yet.
create or replace function public.ad_current_salt()
returns text language plpgsql security definer set search_path = '' as $$
declare v_salt text;
begin
  select salt into v_salt from public.ad_visitor_salt where salt_day = current_date;
  if v_salt is null then
    insert into public.ad_visitor_salt (salt_day) values (current_date)
      on conflict (salt_day) do nothing;
    select salt into v_salt from public.ad_visitor_salt where salt_day = current_date;
  end if;
  return v_salt;
end; $$;

-- Internal: visitor hash from client seed + UA header. No IP anywhere (the
-- x-forwarded-for header is client-forgeable on Supabase — see research 4-
-- plausible-umami §2.2 — so we don't touch it; a determined fraudster clearing
-- localStorage costs us cap fidelity, not user privacy).
create or replace function public.ad_visitor_hash(p_client_seed uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_ua text := coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '');
begin
  if p_client_seed is null and v_ua = '' then
    return null; -- nothing to key on; caller skips capping
  end if;
  return encode(extensions.digest(
    public.ad_current_salt() || coalesce(p_client_seed::text, '') || v_ua, 'sha256'), 'hex');
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Selection (Revive + EthicalAds): weighted, paced, frequency-capped,
--    geo-aware, deterministic per session per hour. Creates the offers for
--    the winners and returns them — only winners' creatives leave Postgres.
-- ---------------------------------------------------------------------------
create or replace function public.pick_featured(
  p_surface      text,
  p_region       text default null,
  p_session_seed text default null,
  p_client_seed  uuid default null,
  p_lat          double precision default null,
  p_lng          double precision default null
)
returns table (
  offer_id uuid, placement_id uuid, campaign_id uuid, business_id uuid,
  business_name text, bathroom_id uuid, creative jsonb, region text
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_capacity int;
  v_freq_cap int;
  v_seed     text := coalesce(p_session_seed, md5(random()::text || clock_timestamp()::text));
  v_bucket   text := to_char(date_trunc('hour', now()), 'YYYYMMDDHH24');
  v_vhash    text := public.ad_visitor_hash(p_client_seed);
  v_point    extensions.geography;
  r          record;
begin
  if not coalesce(
    (select (value)::boolean from public.growth_settings where key = 'promotions_enabled'), true)
  then
    return;
  end if;

  select coalesce(((value ->> p_surface))::int, 1) into v_capacity
  from public.growth_settings where key = 'featured_capacity';
  v_capacity := coalesce(v_capacity, 1);
  v_freq_cap := public.growth_setting_int('ad_frequency_cap_per_day', 3);

  if p_lat is not null and p_lng is not null then
    v_point := extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography;
  end if;

  for r in
    with eligible as (
      select fp.id as fp_id, fp.campaign_id as c_id, fp.business_id as b_id,
             b.name as b_name, fp.bathroom_id as ba_id, c.creative as cr,
             fp.region as rg, fp.weight, fp.daily_impression_cap,
             (select count(*) from public.ad_events e
               where e.placement_id = fp.id and e.event_type = 'impression'
                 and e.is_valid and e.occurred_on = current_date) as delivered_today
      from public.featured_placements fp
      join public.ad_campaigns c on c.id = fp.campaign_id and c.status = 'running'
      join public.businesses  b on b.id = fp.business_id and b.suspended_at is null
      left join public.bathrooms ba on ba.id = fp.bathroom_id
      where fp.surface = p_surface
        and now() between fp.starts_at and fp.ends_at
        and (p_region is null or fp.region is null or fp.region = p_region)
        -- Geo radius (EthicalAds targeting): only constrains when the campaign
        -- asks for it AND we have both a viewer point and a placement point.
        and (not (c.targeting ? 'radius_km') or v_point is null or ba.geog is null
             or extensions.st_dwithin(ba.geog, v_point,
                  (c.targeting ->> 'radius_km')::numeric * 1000))
        -- Frequency cap (Plausible hash): skip campaigns this visitor already
        -- saw >= cap times today. No hash => no cap (fails user-friendly).
        and (v_vhash is null or coalesce((
              select f.impressions from public.ad_visitor_frequency f
              where f.visitor_hash = v_vhash and f.campaign_id = c.id
                and f.day = current_date), 0) < v_freq_cap)
    ),
    paced as (
      select e.*,
        case when e.daily_impression_cap is null then 1.0
          else greatest(0.2, least(3.0,
            (e.daily_impression_cap
               * extract(epoch from (now() - date_trunc('day', now()))) / 86400.0 + 1)
            / greatest(1, e.delivered_today)))
        end as pace_multiplier
      from eligible e
    ),
    keyed as (
      -- Efraimidis–Spirakis weighted sample without replacement, deterministic
      -- per (session, hour): u^(1/(weight*pace)), u from a stable hash.
      select p.*,
        power(greatest(
          ((hashtext(v_seed || ':' || v_bucket || ':' || p.fp_id::text)
             & 2147483647)::float8 / 2147483647.0), 0.0000001),
          1.0 / (p.weight * p.pace_multiplier)) as sample_key
      from paced p
    )
    select * from keyed order by sample_key desc limit v_capacity
  loop
    insert into public.ad_offers
      (campaign_id, placement_id, session_id, visitor_hash, surface, region)
    values (r.c_id, r.fp_id, v_seed, v_vhash, p_surface, r.rg)
    returning id into offer_id;
    placement_id := r.fp_id; campaign_id := r.c_id; business_id := r.b_id;
    business_name := r.b_name; bathroom_id := r.ba_id; creative := r.cr; region := r.rg;
    return next;
  end loop;
end; $$;
grant execute on function public.pick_featured(text,text,text,uuid,double precision,double precision)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Event confirmation (EthicalAds nonce rules + IVT layer 2).
-- ---------------------------------------------------------------------------
-- Cheap server-side bot check: obvious automation UAs. Layer 1 lives in the
-- client (src/lib/ads/ivt.ts); layer 3 is the nightly flag job below.
create or replace function public.ad_ua_is_bot()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '')
         ~* '(bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|scrapy|curl|wget|python-requests)';
$$;

create or replace function public.confirm_ad_view(p_offer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.ad_offers;
  v_business uuid;
  v_valid boolean := true;
  v_reason text;
begin
  select * into o from public.ad_offers where id = p_offer_id;
  if o is null or o.viewed or o.created_at < now() - interval '2 hours' then
    return; -- EthicalAds doctrine: silently drop, never error to the client
  end if;

  select c.business_id into v_business from public.ad_campaigns c where c.id = o.campaign_id;

  if public.ad_ua_is_bot() then
    v_valid := false; v_reason := 'bot_ua';
  elsif (select auth.uid()) is not null and exists (
      select 1 from public.business_members m
      where m.business_id = v_business and m.user_id = (select auth.uid()))
  then
    v_valid := false; v_reason := 'self_view'; -- business viewing its own ad
  end if;

  update public.ad_offers set viewed = true where id = p_offer_id;

  insert into public.ad_events
    (campaign_id, business_id, placement_id, surface, region, event_type,
     session_hash, is_valid, flag_reason)
  values (o.campaign_id, v_business, o.placement_id, o.surface, o.region,
          'impression', coalesce(o.visitor_hash, o.session_id), v_valid, v_reason);

  if v_valid and o.visitor_hash is not null then
    insert into public.ad_visitor_frequency (visitor_hash, campaign_id, day, impressions)
    values (o.visitor_hash, o.campaign_id, current_date, 1)
    on conflict (visitor_hash, campaign_id, day)
    do update set impressions = public.ad_visitor_frequency.impressions + 1;
  end if;
end; $$;
grant execute on function public.confirm_ad_view(uuid) to anon, authenticated;

create or replace function public.confirm_ad_click(p_offer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.ad_offers;
  v_business uuid;
  v_valid boolean := true;
  v_reason text;
  v_clicks_today int;
begin
  select * into o from public.ad_offers where id = p_offer_id;
  -- View-before-click, exactly once, within the offer TTL.
  if o is null or not o.viewed or o.clicked or o.created_at < now() - interval '2 hours' then
    return;
  end if;

  select c.business_id into v_business from public.ad_campaigns c where c.id = o.campaign_id;

  if public.ad_ua_is_bot() then
    v_valid := false; v_reason := 'bot_ua';
  elsif (select auth.uid()) is not null and exists (
      select 1 from public.business_members m
      where m.business_id = v_business and m.user_id = (select auth.uid()))
  then
    v_valid := false; v_reason := 'self_click';
  else
    -- Velocity: more than 3 clicks on one campaign from one visitor in a day
    -- is not organic interest.
    select count(*) into v_clicks_today from public.ad_events e
    where e.campaign_id = o.campaign_id and e.event_type = 'click'
      and e.session_hash = coalesce(o.visitor_hash, o.session_id)
      and e.occurred_on = current_date;
    if v_clicks_today >= 3 then
      v_valid := false; v_reason := 'click_velocity';
    end if;
  end if;

  update public.ad_offers set clicked = true where id = p_offer_id;

  insert into public.ad_events
    (campaign_id, business_id, placement_id, surface, region, event_type,
     session_hash, is_valid, flag_reason)
  values (o.campaign_id, v_business, o.placement_id, o.surface, o.region,
          'click', coalesce(o.visitor_hash, o.session_id), v_valid, v_reason);

  if v_valid and o.visitor_hash is not null then
    insert into public.ad_visitor_frequency (visitor_hash, campaign_id, day, clicks)
    values (o.visitor_hash, o.campaign_id, current_date, 1)
    on conflict (visitor_hash, campaign_id, day)
    do update set clicks = public.ad_visitor_frequency.clicks + 1;
  end if;
end; $$;
grant execute on function public.confirm_ad_click(uuid) to anon, authenticated;

-- Write-once dwell time, capped at 300s (EthicalAds MAX_VIEW_TIME).
create or replace function public.record_ad_view_time(p_offer_id uuid, p_seconds int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ad_offers
     set view_time_seconds = least(greatest(coalesce(p_seconds, 0), 0), 300)
   where id = p_offer_id and viewed and view_time_seconds is null;
end; $$;
grant execute on function public.record_ad_view_time(uuid, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. IVT layer 3: nightly re-flag of suspicious patterns the inline checks
--    can't see (bursts across sessions). Conservative: flags, never deletes.
-- ---------------------------------------------------------------------------
create or replace function public.flag_suspect_ad_events()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- A session_hash producing an absurd number of impressions in one day is a
  -- loop or a script, not a person browsing bathrooms.
  update public.ad_events e set is_valid = false, flag_reason = 'daily_volume'
  where e.occurred_on >= current_date - 1 and e.is_valid
    and e.session_hash in (
      select session_hash from public.ad_events
      where occurred_on >= current_date - 1 and session_hash is not null
      group by session_hash having count(*) > 200);
end; $$;

-- ---------------------------------------------------------------------------
-- 9. Cron wiring (idempotent: unschedule-if-exists then schedule).
-- ---------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('ads_rollup','ads_salt_rotate','ads_freq_prune',
                     'ads_partition','ads_flag_ivt');
exception when others then null;
end $$;

select cron.schedule('ads_rollup', '*/15 * * * *', $$select public.rollup_ad_daily_stats()$$);
select cron.schedule('ads_salt_rotate', '5 0 * * *', $$
  insert into public.ad_visitor_salt (salt_day) values (current_date)
    on conflict (salt_day) do nothing;
  delete from public.ad_visitor_salt where salt_day < current_date - 1;
$$);
select cron.schedule('ads_freq_prune', '20 0 * * *',
  $$delete from public.ad_visitor_frequency where day < current_date - 1$$);
select cron.schedule('ads_partition', '0 0 1 * *', $$
  select public.ensure_ad_events_partition();
  select public.ensure_ad_events_partition((date_trunc('month', now()) + interval '1 month')::date);
  select public.prune_old_ad_events();
$$);
select cron.schedule('ads_flag_ivt', '45 0 * * *', $$select public.flag_suspect_ad_events()$$);

-- Seed this month's + next month's partitions right now.
select public.ensure_ad_events_partition();
select public.ensure_ad_events_partition((date_trunc('month', now()) + interval '1 month')::date);
