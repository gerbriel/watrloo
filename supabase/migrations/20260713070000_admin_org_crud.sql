-- Watrloo: full admin org CRUD + member assignment, and a fix for approving
-- anonymous business requests.
--
-- The flow this enables end-to-end:
--   1. Anyone (account or not) files the business request form.
--   2. Admin approves. If the requester was signed in they become the org's
--      owner immediately (as before). If the request was anonymous, the org is
--      created OWNERLESS — previously this path crashed on a null owner insert.
--   3. The person signs up themselves (accounts are always self-created — the
--      client can never mint auth users), then the admin assigns them to the
--      org by username from Manage Orgs.
-- Admins can also create orgs from scratch, delete them, and manage members.

-- Audit vocabulary (FULL list — the standing rule).
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'delete_review_photo',
    'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'stop_campaign',
    'suspend_business', 'unsuspend_business', 'dispatch_blast',
    'set_growth_setting', 'update_placement',
    'grant_appeal', 'deny_appeal', 'hard_delete_bathroom',
    'upsert_attribute',
    'assign_bathroom', 'unassign_bathroom',
    'create_business', 'delete_business', 'set_org_member'   -- new
  ));

-- 1. Approving an anonymous request no longer breaks: null requester =>
--    ownerless org, assign the person later.
create or replace function public.admin_approve_access_request(p_request_id uuid, p_plan text default 'solo')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_req public.business_access_requests;
  v_business uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_req from public.business_access_requests where id = p_request_id;
  if v_req is null or v_req.status <> 'open' then
    raise exception 'request not open' using errcode = 'P0002';
  end if;

  insert into public.businesses (name, website, owner_id)
  values (v_req.business_name, v_req.website, v_req.requester_id)
  returning id into v_business;

  if v_req.requester_id is not null then
    insert into public.business_members (business_id, user_id, role)
    values (v_business, v_req.requester_id, 'owner');
  end if;

  insert into public.subscriptions (business_id, plan, status)
  values (v_business, p_plan, 'active');

  update public.business_access_requests
     set status = 'approved', reviewed_by = (select auth.uid()), reviewed_at = now()
   where id = p_request_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'approve_access_request', 'business', v_business,
          jsonb_build_object('request', p_request_id,
                             'owner_attached', v_req.requester_id is not null));

  return v_business;
end; $$;

-- 2. Create an org from scratch (owner optional; assign later if unknown).
create or replace function public.admin_create_business(
  p_name text, p_website text default null,
  p_owner_id uuid default null, p_plan text default 'solo')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) < 1 then
    raise exception 'name is required' using errcode = '22023';
  end if;

  insert into public.businesses (name, website, owner_id)
  values (left(btrim(p_name), 160), nullif(btrim(coalesce(p_website, '')), ''), p_owner_id)
  returning id into v_business;

  if p_owner_id is not null then
    insert into public.business_members (business_id, user_id, role)
    values (v_business, p_owner_id, 'owner');
  end if;

  insert into public.subscriptions (business_id, plan, status)
  values (v_business, p_plan, 'active');

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'create_business', 'business', v_business,
          jsonb_build_object('name', p_name, 'owner_attached', p_owner_id is not null));
  return v_business;
end; $$;
grant execute on function public.admin_create_business(text, text, uuid, text) to authenticated;

-- 3. Delete an org (cascades members, subscription, claims, campaigns,
--    placements). Audited before the row disappears.
create or replace function public.admin_delete_business(p_business_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select name into v_name from public.businesses where id = p_business_id;
  if v_name is null then
    return;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'delete_business', 'business', p_business_id,
          jsonb_build_object('name', v_name, 'reason', p_reason));
  delete from public.businesses where id = p_business_id;
end; $$;
grant execute on function public.admin_delete_business(uuid, text) to authenticated;

-- 4. Assign / change / remove an org member (admin path; owners keep their
--    own business_add_member for self-serve). p_role null = remove.
create or replace function public.admin_set_org_member(
  p_business_id uuid, p_user_id uuid, p_role text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('owner', 'manager', 'staff') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  if p_role is null then
    delete from public.business_members
     where business_id = p_business_id and user_id = p_user_id;
  else
    insert into public.business_members (business_id, user_id, role)
    values (p_business_id, p_user_id, p_role)
    on conflict (business_id, user_id) do update set role = excluded.role;
    -- First owner assigned to an ownerless org also becomes businesses.owner_id.
    if p_role = 'owner' then
      update public.businesses set owner_id = p_user_id
       where id = p_business_id and owner_id is null;
    end if;
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'set_org_member', 'business', p_business_id,
          jsonb_build_object('user_id', p_user_id, 'role', p_role));
end; $$;
grant execute on function public.admin_set_org_member(uuid, uuid, text) to authenticated;
