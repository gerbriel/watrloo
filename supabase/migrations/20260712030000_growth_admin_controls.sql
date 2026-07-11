-- Admin kill controls for the ad system.
--
-- Turning promotions on globally is only safe if an admin can also reach in and
-- stop a single ad, or an entire advertiser, at any time. This adds:
--   * a suspension flag on businesses,
--   * admin_set_campaign_status()  — pause / resume / stop one campaign,
--   * admin_suspend_business()     — suspend / unsuspend an advertiser,
-- and teaches active_featured() to hide anything a suspended advertiser owns.
-- Both a paused campaign and a suspended advertiser vanish from the public feed
-- immediately (active_featured only ever shows status='running', unsuspended
-- advertisers). Everything is admin-gated and written to the audit log.

-- 1. Widen the audit log for the new verbs + target types.
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review','restore_review','soft_delete_bathroom','restore_bathroom',
    'resolve_report','dismiss_report','grant_role','revoke_role','update_bathroom',
    'approve_access_request','verify_claim','reject_claim',
    'submit_campaign','approve_campaign','reject_campaign',
    'pause_campaign','resume_campaign','stop_campaign',
    'suspend_business','unsuspend_business',
    'dispatch_blast'));

alter table public.moderation_actions drop constraint if exists moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in ('review','bathroom','report','profile','business','campaign'));

-- 2. Advertiser suspension flag. NULL = in good standing.
alter table public.businesses add column if not exists suspended_at timestamptz;

-- 3. active_featured now also excludes campaigns owned by a suspended advertiser.
create or replace function public.active_featured(p_surface text, p_region text default null)
returns table (
  placement_id uuid, campaign_id uuid, business_id uuid, business_name text,
  bathroom_id uuid, creative jsonb, region text
)
language sql stable security definer set search_path = '' as $$
  select fp.id, fp.campaign_id, fp.business_id, b.name, fp.bathroom_id, c.creative, fp.region
  from public.featured_placements fp
  join public.ad_campaigns c on c.id = fp.campaign_id and c.status = 'running'
  join public.businesses b on b.id = fp.business_id and b.suspended_at is null
  where fp.surface = p_surface
    and now() between fp.starts_at and fp.ends_at
    and (p_region is null or fp.region is null or fp.region = p_region)
    and coalesce((select (value)::boolean from public.growth_settings where key='promotions_enabled'), true)
  order by fp.starts_at
  limit 10;
$$;
grant execute on function public.active_featured(text, text) to anon, authenticated;

-- 4. Admin: pause / resume / stop a single campaign. Only touches the live
--    states (approved/running/paused) — it can't revive a rejected or draft
--    campaign, that goes back through review.
create or replace function public.admin_set_campaign_status(
  p_campaign_id uuid, p_status text, p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.ad_campaigns;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_status not in ('paused','running','done') then
    raise exception 'unsupported status %', p_status using errcode = '22023';
  end if;
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v is null then
    raise exception 'no such campaign' using errcode = 'P0002';
  end if;
  if v.status not in ('approved','running','paused') then
    raise exception 'cannot change status from %', v.status using errcode = '22023';
  end if;
  update public.ad_campaigns set status = p_status where id = p_campaign_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case p_status when 'paused' then 'pause_campaign'
                        when 'running' then 'resume_campaign'
                        else 'stop_campaign' end,
          'campaign', p_campaign_id,
          jsonb_build_object('business', v.business_id, 'reason', p_reason, 'from', v.status));
end; $$;
grant execute on function public.admin_set_campaign_status(uuid,text,text) to authenticated;

-- 5. Admin: suspend / unsuspend an advertiser. Suspending also pauses every one
--    of its live campaigns, so nothing keeps running. Unsuspending deliberately
--    leaves those campaigns paused — the admin resumes them one by one, so
--    lifting a suspension never silently re-runs old ads.
create or replace function public.admin_suspend_business(
  p_business_id uuid, p_suspend boolean, p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.businesses
     set suspended_at = case when p_suspend then now() else null end
   where id = p_business_id;
  if not found then
    raise exception 'no such business' using errcode = 'P0002';
  end if;
  if p_suspend then
    update public.ad_campaigns set status = 'paused'
     where business_id = p_business_id and status in ('approved','running');
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case when p_suspend then 'suspend_business' else 'unsuspend_business' end,
          'business', p_business_id,
          jsonb_build_object('reason', p_reason));
end; $$;
grant execute on function public.admin_suspend_business(uuid,boolean,text) to authenticated;
