-- Watrloo growth platform — Phase 0 (consent backbone) + featured-first launch
-- with IN-APP promotional messaging (owner decision 2026-07-10: blasts are
-- in-app messages, not email; CAN-SPAM postal address therefore not required).
--
-- Design: docs/growth/ (DATA_MODEL.md is canonical; INTEGRATION_NOTES.md holds
-- the channel-pivot decision record). Everything additive; no existing table's
-- behavior changes except widening the moderation_actions verb list and the
-- subscriptions.plan backfill 'standard' -> 'solo'.

-- ---------------------------------------------------------------------------
-- 0. Tunables. One row per setting; jsonb so caps can change without DDL.
-- ---------------------------------------------------------------------------
create table if not exists public.growth_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.growth_settings enable row level security;
-- Readable by everyone (the k-floor and caps are not secrets); writes admin-RPC only.
drop policy if exists "settings are readable" on public.growth_settings;
create policy "settings are readable" on public.growth_settings
  for select using (true);

insert into public.growth_settings (key, value) values
  ('k_anonymity_floor',          '30'),
  -- Launch OFF (owner decision): the dispatcher stays inert until the consent
  -- UI ships. Flip via: update growth_settings set value='true' where key='promotions_enabled';
  ('promotions_enabled',         'false'),
  ('promo_global_cap_per_week',  '3'),
  ('promo_advertiser_cap_per_week', '1'),
  ('featured_capacity',          '{"browse": 3, "map": 1, "detail": 1}')
on conflict (key) do nothing;

create or replace function public.growth_setting_int(p_key text, p_default int)
returns int language sql stable set search_path = '' as $$
  select coalesce((select (value)::int from public.growth_settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- 1. Consent. Absence of a row = no consent to anything. Opt-in only.
-- ---------------------------------------------------------------------------
create table if not exists public.user_consents (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  marketing_opt_in   boolean not null default false,
  location_opt_in    boolean not null default false,
  analytics_opt_in   boolean not null default false,
  newsletter_opt_out boolean not null default false,
  gpc_detected       boolean not null default false,
  consent_updated_at timestamptz not null default now(),
  source             text
);
alter table public.user_consents enable row level security;

drop policy if exists "users read their own consent" on public.user_consents;
create policy "users read their own consent" on public.user_consents
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "admins read all consent" on public.user_consents;
create policy "admins read all consent" on public.user_consents
  for select to authenticated using ((select public.is_admin()));

-- Writes only through set_consent(), so every change is stamped and sourced.
create or replace function public.set_consent(
  p_marketing boolean default null,
  p_location  boolean default null,
  p_analytics boolean default null,
  p_newsletter_opt_out boolean default null,
  p_gpc boolean default null,
  p_source text default 'settings'
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into public.user_consents as c
    (user_id, marketing_opt_in, location_opt_in, analytics_opt_in,
     newsletter_opt_out, gpc_detected, source)
  values
    (uid, coalesce(p_marketing,false), coalesce(p_location,false),
     coalesce(p_analytics,false), coalesce(p_newsletter_opt_out,false),
     coalesce(p_gpc,false), p_source)
  on conflict (user_id) do update set
    marketing_opt_in   = coalesce(p_marketing,  c.marketing_opt_in),
    location_opt_in    = coalesce(p_location,   c.location_opt_in),
    analytics_opt_in   = coalesce(p_analytics,  c.analytics_opt_in),
    newsletter_opt_out = coalesce(p_newsletter_opt_out, c.newsletter_opt_out),
    gpc_detected       = coalesce(p_gpc,        c.gpc_detected),
    consent_updated_at = now(),
    source             = p_source;
end; $$;
grant execute on function public.set_consent(boolean,boolean,boolean,boolean,boolean,text) to authenticated;

-- Kept for the future email newsletter and as a global kill for an address.
create table if not exists public.email_suppressions (
  email      text primary key,
  reason     text not null check (reason in ('unsubscribed','bounced','complained','manual')),
  source     text,
  created_at timestamptz not null default now()
);
alter table public.email_suppressions enable row level security;
drop policy if exists "admins read suppressions" on public.email_suppressions;
create policy "admins read suppressions" on public.email_suppressions
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- 2. Plans & entitlements. NO api_access on any tier (owner decision).
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  key                 text primary key,
  name                text not null,
  monthly_price_cents int not null,
  active              boolean not null default true
);
create table if not exists public.plan_features (
  plan_key text not null references public.plans (key) on delete cascade,
  feature  text not null,
  value    jsonb not null,
  primary key (plan_key, feature)
);
alter table public.plans          enable row level security;
alter table public.plan_features  enable row level security;
drop policy if exists "plans are public" on public.plans;
create policy "plans are public" on public.plans for select using (true);
drop policy if exists "plan features are public" on public.plan_features;
create policy "plan features are public" on public.plan_features for select using (true);

-- Display names are themed (see docs/growth/PRICING.md §1); the stable
-- identifiers are the keys, which the app and RPCs reference exclusively.
insert into public.plans (key, name, monthly_price_cents) values
  ('solo',       'Lone Throne',      1000),
  ('growth',     'Royal Flush',      3900),
  ('chain',      'Porcelain Empire', 14900),
  ('enterprise', 'Grande Armée',     50000)
on conflict (key) do nothing;

insert into public.plan_features (plan_key, feature, value) values
  ('solo','max_locations','1'),        ('solo','promo_blasts_per_month','2'),
  ('solo','max_recipients_per_blast','5000'), ('solo','featured_per_week','1'),
  ('solo','newsletter_slots_per_month','0'), ('solo','seats','3'),
  ('solo','analytics_tier','"basic"'), ('solo','csv_import','false'),
  ('solo','priority_support','false'),

  ('growth','max_locations','5'),      ('growth','promo_blasts_per_month','4'),
  ('growth','max_recipients_per_blast','20000'), ('growth','featured_per_week','2'),
  ('growth','newsletter_slots_per_month','1'), ('growth','seats','5'),
  ('growth','analytics_tier','"standard"'), ('growth','csv_import','true'),
  ('growth','priority_support','false'),

  ('chain','max_locations','25'),      ('chain','promo_blasts_per_month','8'),
  ('chain','max_recipients_per_blast','100000'), ('chain','featured_per_week','4'),
  ('chain','newsletter_slots_per_month','2'), ('chain','seats','15'),
  ('chain','analytics_tier','"advanced"'), ('chain','csv_import','true'),
  ('chain','priority_support','true'),

  ('enterprise','max_locations','10000'), ('enterprise','promo_blasts_per_month','20'),
  ('enterprise','max_recipients_per_blast','250000'), ('enterprise','featured_per_week','8'),
  ('enterprise','newsletter_slots_per_month','4'), ('enterprise','seats','50'),
  ('enterprise','analytics_tier','"advanced"'), ('enterprise','csv_import','true'),
  ('enterprise','priority_support','true')
on conflict (plan_key, feature) do nothing;

-- Wire the existing subscriptions table to plans.
update public.subscriptions set plan = 'solo' where plan = 'standard';
alter table public.subscriptions
  drop constraint if exists subscriptions_plan_fkey;
alter table public.subscriptions
  add constraint subscriptions_plan_fkey
  foreign key (plan) references public.plans (key);

create or replace function public.entitlement_int(p_business_id uuid, p_feature text)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (pf.value)::int
    from public.subscriptions s
    join public.plan_features pf on pf.plan_key = s.plan and pf.feature = p_feature
    where s.business_id = p_business_id and s.status in ('active','trialing')
  ), 0);
$$;
grant execute on function public.entitlement_int(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Campaigns (in-app blasts + featured), sends (= the in-app inbox), slots.
-- ---------------------------------------------------------------------------
create table if not exists public.ad_campaigns (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  type          text not null check (type in ('in_app_blast','featured')),
  status        text not null default 'draft'
                check (status in ('draft','pending_review','approved','running','paused','done','rejected')),
  -- Creative is frozen at approval (enforced in the RPCs).
  creative      jsonb not null default '{}',
  bathroom_id   uuid references public.bathrooms (id) on delete cascade,
  target_region text,
  surface       text check (surface in ('browse','map','detail','newsletter')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  reject_reason text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  reviewed_by   uuid references public.profiles (id) on delete set null,
  reviewed_at   timestamptz
);
alter table public.ad_campaigns enable row level security;
create index if not exists ad_campaigns_business_idx on public.ad_campaigns (business_id, created_at desc);
create index if not exists ad_campaigns_status_idx   on public.ad_campaigns (status);

drop policy if exists "members read their campaigns" on public.ad_campaigns;
create policy "members read their campaigns" on public.ad_campaigns
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));

-- The in-app inbox: a send row IS the delivered message.
create table if not exists public.campaign_sends (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.ad_campaigns (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  channel        text not null default 'in_app' check (channel in ('in_app')),
  occurrence_key text not null default 'initial',
  status         text not null default 'delivered'
                 check (status in ('queued','delivered','read','failed')),
  created_at     timestamptz not null default now(),
  read_at        timestamptz,
  unique (campaign_id, user_id, occurrence_key)
);
alter table public.campaign_sends enable row level security;
create index if not exists campaign_sends_user_idx on public.campaign_sends (user_id, created_at desc);
-- Frequency-cap window scans:
create index if not exists campaign_sends_window_idx on public.campaign_sends (user_id, channel, created_at);

drop policy if exists "users read their own messages" on public.campaign_sends;
create policy "users read their own messages" on public.campaign_sends
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "admins read all sends" on public.campaign_sends;
create policy "admins read all sends" on public.campaign_sends
  for select to authenticated using ((select public.is_admin()));

create or replace function public.mark_message_read(p_send_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_sends
     set status = 'read', read_at = now()
   where id = p_send_id and user_id = (select auth.uid()) and read_at is null;
end; $$;
grant execute on function public.mark_message_read(uuid) to authenticated;

create table if not exists public.featured_placements (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  bathroom_id uuid references public.bathrooms (id) on delete cascade,
  surface     text not null check (surface in ('browse','map','detail','newsletter')),
  region      text,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
alter table public.featured_placements enable row level security;
create index if not exists featured_active_idx
  on public.featured_placements (surface, starts_at, ends_at);

drop policy if exists "members read their placements" on public.featured_placements;
create policy "members read their placements" on public.featured_placements
  for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));

-- Public, contextual, zero-PII read of what's live right now.
create or replace function public.active_featured(p_surface text, p_region text default null)
returns table (
  placement_id uuid, campaign_id uuid, business_id uuid, business_name text,
  bathroom_id uuid, creative jsonb, region text
)
language sql stable security definer set search_path = '' as $$
  select fp.id, fp.campaign_id, fp.business_id, b.name, fp.bathroom_id, c.creative, fp.region
  from public.featured_placements fp
  join public.ad_campaigns c on c.id = fp.campaign_id and c.status = 'running'
  join public.businesses b on b.id = fp.business_id
  where fp.surface = p_surface
    and now() between fp.starts_at and fp.ends_at
    and (p_region is null or fp.region is null or fp.region = p_region)
    and coalesce((select (value)::boolean from public.growth_settings where key='promotions_enabled'), true)
  order by fp.starts_at
  limit 10;
$$;
grant execute on function public.active_featured(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Campaign lifecycle RPCs (manager creates/submits; admin reviews).
-- ---------------------------------------------------------------------------
create or replace function public.create_campaign(
  p_business_id uuid, p_type text, p_creative jsonb,
  p_bathroom_id uuid default null, p_surface text default null,
  p_region text default null,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_business_manager(p_business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.ad_campaigns
    (business_id, type, creative, bathroom_id, surface, target_region, starts_at, ends_at, created_by)
  values
    (p_business_id, p_type, p_creative, p_bathroom_id, p_surface, p_region, p_starts_at, p_ends_at, (select auth.uid()))
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.submit_campaign(p_campaign_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.ad_campaigns;
begin
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v is null or not public.is_business_manager(v.business_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v.status not in ('draft','rejected') then
    raise exception 'not submittable from %', v.status using errcode = '22023';
  end if;
  -- Entitlement gates.
  if v.type = 'featured' and public.entitlement_int(v.business_id, 'featured_per_week') < 1 then
    raise exception 'plan has no featured allowance' using errcode = 'P0001';
  end if;
  if v.type = 'in_app_blast' then
    if public.entitlement_int(v.business_id, 'promo_blasts_per_month') <=
       (select count(*) from public.ad_campaigns
         where business_id = v.business_id and type = 'in_app_blast'
           and status in ('pending_review','approved','running','done')
           and created_at > date_trunc('month', now())) then
      raise exception 'monthly blast allowance exhausted' using errcode = 'P0001';
    end if;
  end if;
  update public.ad_campaigns
     set status = 'pending_review', submitted_at = now()
   where id = p_campaign_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'submit_campaign', 'bathroom', v.bathroom_id,
          jsonb_build_object('campaign', p_campaign_id, 'business', v.business_id));
end; $$;

create or replace function public.admin_review_campaign(
  p_campaign_id uuid, p_approve boolean, p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.ad_campaigns;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v is null or v.status <> 'pending_review' then
    raise exception 'not pending review' using errcode = 'P0002';
  end if;

  if not p_approve then
    update public.ad_campaigns
       set status = 'rejected', reject_reason = p_reason,
           reviewed_by = (select auth.uid()), reviewed_at = now()
     where id = p_campaign_id;
  else
    update public.ad_campaigns
       set status = case when now() >= coalesce(v.starts_at, now()) then 'running' else 'approved' end,
           reviewed_by = (select auth.uid()), reviewed_at = now()
     where id = p_campaign_id;
    if v.type = 'featured' then
      insert into public.featured_placements
        (campaign_id, business_id, bathroom_id, surface, region, starts_at, ends_at)
      values
        (v.id, v.business_id, v.bathroom_id, coalesce(v.surface,'browse'), v.target_region,
         coalesce(v.starts_at, now()), coalesce(v.ends_at, now() + interval '7 days'));
    end if;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case when p_approve then 'approve_campaign' else 'reject_campaign' end,
          'bathroom', v.bathroom_id,
          jsonb_build_object('campaign', p_campaign_id, 'reason', p_reason));
end; $$;

grant execute on function public.create_campaign(uuid,text,jsonb,uuid,text,text,timestamptz,timestamptz) to authenticated;
grant execute on function public.submit_campaign(uuid) to authenticated;
grant execute on function public.admin_review_campaign(uuid,boolean,text) to authenticated;

-- Widen the audit verb list for the new actions.
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review','restore_review','soft_delete_bathroom','restore_bathroom',
    'resolve_report','dismiss_report','grant_role','revoke_role','update_bathroom',
    'approve_access_request','verify_claim','reject_claim',
    'submit_campaign','approve_campaign','reject_campaign','pause_campaign',
    'dispatch_blast'));

-- ---------------------------------------------------------------------------
-- 5. In-app blast dispatch. One-shot per campaign at launch (occurrence
--    'initial'); consent + both frequency caps enforced IN the insert query.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_inapp_blasts()
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_campaign public.ad_campaigns;
  v_total int := 0;
  v_batch int;
  v_cap int := public.growth_setting_int('promo_global_cap_per_week', 3);
  v_adv_cap int := public.growth_setting_int('promo_advertiser_cap_per_week', 1);
begin
  if not coalesce((select (value)::boolean from public.growth_settings where key='promotions_enabled'), true) then
    return 0; -- kill switch
  end if;
  -- One dispatcher at a time.
  if not pg_try_advisory_lock(hashtext('dispatch_inapp_blasts')) then
    return 0;
  end if;

  for v_campaign in
    select * from public.ad_campaigns
    where type = 'in_app_blast'
      and (status = 'running'
           or (status = 'approved' and now() >= coalesce(starts_at, now())))
      and (ends_at is null or now() <= ends_at)
  loop
    update public.ad_campaigns set status = 'running'
     where id = v_campaign.id and status = 'approved';

    insert into public.campaign_sends (campaign_id, user_id, channel, occurrence_key, status)
    select v_campaign.id, u.user_id, 'in_app', 'initial', 'delivered'
    from public.user_consents u
    where u.marketing_opt_in
      -- global cap: < N promo messages in the trailing 7 days
      and (select count(*) from public.campaign_sends s
            where s.user_id = u.user_id and s.channel = 'in_app'
              and s.status <> 'failed'
              and s.created_at > now() - interval '7 days') < v_cap
      -- per-advertiser sub-cap
      and (select count(*) from public.campaign_sends s
            join public.ad_campaigns c2 on c2.id = s.campaign_id
            where s.user_id = u.user_id
              and c2.business_id = v_campaign.business_id
              and s.created_at > now() - interval '7 days') < v_adv_cap
    limit greatest(public.entitlement_int(v_campaign.business_id, 'max_recipients_per_blast'), 0)
    on conflict (campaign_id, user_id, occurrence_key) do nothing;

    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch;

    -- One-shot: once dispatched, the blast is done.
    update public.ad_campaigns set status = 'done' where id = v_campaign.id;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values (null, 'dispatch_blast', 'bathroom', v_campaign.bathroom_id,
            jsonb_build_object('campaign', v_campaign.id, 'recipients', v_batch));
  end loop;

  perform pg_advisory_unlock(hashtext('dispatch_inapp_blasts'));
  return v_total;
end; $$;

-- Schedule the dispatcher (idempotent: unschedule an old copy first).
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'growth_dispatch_inapp';
exception when others then null;
end $$;
select cron.schedule('growth_dispatch_inapp', '*/5 * * * *',
                     $$select public.dispatch_inapp_blasts()$$);
