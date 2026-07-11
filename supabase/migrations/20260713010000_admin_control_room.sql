-- Watrloo: Admin Control Room v2 — the server side.
-- Plan: docs/growth/ADMIN_CONTROL_ROOM_V2.md. Everything here is an audited,
-- is_admin-gated write path or an admin-only read: the UI only hides buttons.
--
-- ALSO REPAIRS a production bug this migration's own pattern keeps causing:
-- the moderation_actions CHECKs enumerate every known value, and the last two
-- rewrites each clobbered the other's additions ('delete_review_photo' and
-- 'photo' are missing on live right now, so moderator photo deletion is
-- broken). Rule, restated: ANY rewrite must carry the FULL list.

-- ---------------------------------------------------------------------------
-- 1. Audit vocabulary: full list restored + control-room actions added.
-- ---------------------------------------------------------------------------
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'delete_review_photo',                      -- restored (photo_moderation)
    'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'stop_campaign',
    'suspend_business', 'unsuspend_business', 'dispatch_blast',
    'set_growth_setting', 'update_placement'    -- new (control room)
  ));

alter table public.moderation_actions drop constraint if exists moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in (
    'review', 'bathroom', 'report', 'profile',
    'photo',                                    -- restored (photo_moderation)
    'business', 'campaign',
    'setting', 'placement'                      -- new (control room)
  ));

-- ---------------------------------------------------------------------------
-- 2. "Report this ad": a third report target. Exactly-one still holds.
-- ---------------------------------------------------------------------------
alter table public.reports
  add column if not exists ad_campaign_id uuid references public.ad_campaigns (id) on delete cascade;

alter table public.reports drop constraint if exists reports_check;
alter table public.reports add constraint reports_check check (
  ((review_id is not null)::int + (bathroom_id is not null)::int
    + (ad_campaign_id is not null)::int) = 1
);

-- ---------------------------------------------------------------------------
-- 3. Settings writes, finally off the SQL editor. Whitelisted + validated +
--    audited. The whitelist mirrors the keys that exist today.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_growth_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_key not in ('promotions_enabled','featured_capacity','ad_frequency_cap_per_day',
                   'k_anonymity_floor','promo_global_cap_per_week','promo_advertiser_cap_per_week') then
    raise exception 'unknown setting: %', p_key using errcode = '22023';
  end if;

  -- Shape checks: booleans stay booleans, counts stay positive ints, and
  -- featured_capacity stays an object of small positive ints per surface.
  if p_key = 'promotions_enabled' and jsonb_typeof(p_value) <> 'boolean' then
    raise exception 'promotions_enabled must be boolean' using errcode = '22023';
  end if;
  if p_key in ('ad_frequency_cap_per_day','k_anonymity_floor',
               'promo_global_cap_per_week','promo_advertiser_cap_per_week') then
    if jsonb_typeof(p_value) <> 'number' or (p_value)::numeric < 1 or (p_value)::numeric > 1000 then
      raise exception '% must be a number between 1 and 1000', p_key using errcode = '22023';
    end if;
  end if;
  if p_key = 'featured_capacity' then
    if jsonb_typeof(p_value) <> 'object' then
      raise exception 'featured_capacity must be an object' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_each(p_value) kv
      where kv.key not in ('browse','map','detail','newsletter')
         or jsonb_typeof(kv.value) <> 'number'
         or (kv.value)::int < 0 or (kv.value)::int > 10
    ) then
      raise exception 'featured_capacity values must be 0-10 per known surface' using errcode = '22023';
    end if;
  end if;

  insert into public.growth_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'set_growth_setting', 'setting', gen_random_uuid(),
          jsonb_build_object('key', p_key, 'value', p_value));
end; $$;
grant execute on function public.admin_set_growth_setting(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Placement delivery knobs (weight / daily pacing cap), audited.
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_placement_delivery(
  p_placement_id uuid, p_weight int, p_daily_cap int default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_weight is null or p_weight < 1 or p_weight > 10000 then
    raise exception 'weight must be 1-10000' using errcode = '22023';
  end if;
  if p_daily_cap is not null and (p_daily_cap < 1 or p_daily_cap > 1000000) then
    raise exception 'daily cap must be 1-1000000 or null' using errcode = '22023';
  end if;

  update public.featured_placements
     set weight = p_weight, daily_impression_cap = p_daily_cap
   where id = p_placement_id;
  if not found then
    raise exception 'no such placement' using errcode = 'P0002';
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'update_placement', 'placement', p_placement_id,
          jsonb_build_object('weight', p_weight, 'daily_impression_cap', p_daily_cap));
end; $$;
grant execute on function public.admin_update_placement_delivery(uuid, int, int) to authenticated;

-- Admin list of placements with campaign/business context + today's delivery.
create or replace function public.admin_list_placements()
returns table (
  placement_id uuid, campaign_id uuid, business_id uuid, business_name text,
  campaign_title text, surface text, region text, starts_at timestamptz,
  ends_at timestamptz, weight int, daily_impression_cap int,
  delivered_today bigint, campaign_status text
)
language sql stable security definer set search_path = '' as $$
  select fp.id, fp.campaign_id, fp.business_id, b.name,
         coalesce(c.creative ->> 'title', '(untitled)'),
         fp.surface, fp.region, fp.starts_at, fp.ends_at,
         fp.weight, fp.daily_impression_cap,
         (select count(*) from public.ad_events e
           where e.placement_id = fp.id and e.event_type = 'impression'
             and e.is_valid and e.occurred_on = current_date),
         c.status
  from public.featured_placements fp
  join public.ad_campaigns c on c.id = fp.campaign_id
  join public.businesses b on b.id = fp.business_id
  where public.is_admin()
  order by fp.ends_at desc;
$$;
grant execute on function public.admin_list_placements() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Ads overview: labeled daily stats for the whole platform, one call.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ad_overview(p_since date default (current_date - 27))
returns table (
  campaign_id uuid, campaign_title text, campaign_status text,
  business_id uuid, business_name text, day date, surface text,
  impressions int, clicks int, unique_sessions int, invalid_events int
)
language sql stable security definer set search_path = '' as $$
  select s.campaign_id, coalesce(c.creative ->> 'title', '(untitled)'), c.status,
         s.business_id, b.name, s.day, s.surface,
         s.impressions, s.clicks, s.unique_sessions, s.invalid_events
  from public.ad_daily_stats s
  join public.ad_campaigns c on c.id = s.campaign_id
  join public.businesses b on b.id = s.business_id
  where public.is_admin() and s.day >= p_since
  order by s.day desc;
$$;
grant execute on function public.admin_ad_overview(date) to authenticated;

-- IVT drill-down: flagged-event counts by reason/campaign/day (aggregates only).
create or replace function public.admin_ivt_breakdown(p_since date default (current_date - 13))
returns table (
  day date, campaign_id uuid, campaign_title text, business_name text,
  flag_reason text, events bigint
)
language sql stable security definer set search_path = '' as $$
  select e.occurred_on, e.campaign_id, coalesce(c.creative ->> 'title', '(untitled)'),
         b.name, e.flag_reason, count(*)
  from public.ad_events e
  join public.ad_campaigns c on c.id = e.campaign_id
  join public.businesses b on b.id = e.business_id
  where public.is_admin() and not e.is_valid and e.occurred_on >= p_since
  group by 1, 2, 3, 4, 5
  order by 1 desc, 6 desc;
$$;
grant execute on function public.admin_ivt_breakdown(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Ops snapshot: is the machine on? Cron health, rollup freshness, volume.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ops_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'crons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'last_status', r.status, 'last_start', r.start_time, 'last_end', r.end_time)
        order by j.jobname)
      from cron.job j
      left join lateral (
        select status, start_time, end_time from cron.job_run_details d
        where d.jobid = j.jobid order by d.start_time desc limit 1
      ) r on true), '[]'::jsonb),
    'rollup_fresh_at', (select max(updated_at) from public.ad_daily_stats),
    'events_today', (select count(*) from public.ad_events where occurred_on = current_date),
    'invalid_today', (select count(*) from public.ad_events
                       where occurred_on = current_date and not is_valid),
    'offers_open', (select count(*) from public.ad_offers
                     where created_at > now() - interval '2 hours' and not viewed),
    'offers_total', (select count(*) from public.ad_offers),
    'salt_today', exists(select 1 from public.ad_visitor_salt where salt_day = current_date),
    'partitions', coalesce((
      select jsonb_agg(child.relname order by child.relname)
      from pg_inherits
      join pg_class child on pg_inherits.inhrelid = child.oid
      join pg_class parent on pg_inherits.inhparent = parent.oid
      where parent.relname = 'ad_events'), '[]'::jsonb),
    'running_campaigns', (select count(*) from public.ad_campaigns where status = 'running'),
    'promotions_enabled', coalesce((select (value)::boolean from public.growth_settings
                                     where key = 'promotions_enabled'), true)
  ) into v;
  return v;
end; $$;
grant execute on function public.admin_ops_snapshot() to authenticated;
