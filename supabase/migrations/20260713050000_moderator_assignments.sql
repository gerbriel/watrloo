-- Watrloo: moderator bathroom assignments — "these bathrooms are yours."
-- Admins assign bathrooms to a moderator; the moderator's panel shows their
-- assigned bathrooms with the reviews and open reports attached to them.
-- Assignment is a WORKLOAD pointer, not a permission change: moderators
-- already hold sitewide moderation powers; this focuses their attention.

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
    'assign_bathroom', 'unassign_bathroom'    -- new
  ));

create table if not exists public.moderator_assignments (
  moderator_id uuid not null references public.profiles (id) on delete cascade,
  bathroom_id  uuid not null references public.bathrooms (id) on delete cascade,
  assigned_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (moderator_id, bathroom_id)
);
create index if not exists moderator_assignments_bathroom_idx
  on public.moderator_assignments (bathroom_id);

alter table public.moderator_assignments enable row level security;
grant select on public.moderator_assignments to authenticated;
drop policy if exists "moderators read own assignments, admins all" on public.moderator_assignments;
create policy "moderators read own assignments, admins all"
  on public.moderator_assignments for select to authenticated
  using (moderator_id = (select auth.uid()) or (select public.is_admin()));
-- Writes: admin RPC only.

-- Assign or unassign a batch of bathrooms to one moderator (audited each).
create or replace function public.admin_assign_bathrooms(
  p_moderator_id uuid, p_bathroom_ids uuid[], p_add boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_roles ur
                  where ur.user_id = p_moderator_id
                    and ur.role in ('moderator', 'admin')) then
    raise exception 'target is not a moderator' using errcode = '22023';
  end if;

  foreach v_id in array coalesce(p_bathroom_ids, '{}') loop
    if p_add then
      insert into public.moderator_assignments (moderator_id, bathroom_id, assigned_by)
      values (p_moderator_id, v_id, (select auth.uid()))
      on conflict do nothing;
      if not found then continue; end if;
    else
      delete from public.moderator_assignments
       where moderator_id = p_moderator_id and bathroom_id = v_id;
      if not found then continue; end if;
    end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values ((select auth.uid()),
            case when p_add then 'assign_bathroom' else 'unassign_bathroom' end,
            'bathroom', v_id, jsonb_build_object('moderator_id', p_moderator_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_assign_bathrooms(uuid, uuid[], boolean) to authenticated;

-- The moderator's own worklist: assigned bathrooms with live review counts and
-- open reports touching them (reports on the bathroom itself or its reviews).
create or replace function public.my_assigned_bathrooms()
returns table (
  bathroom_id uuid, name text, address text, deleted_at timestamptz,
  assigned_at timestamptz, review_count int, removed_reviews int, open_reports int
)
language sql stable security definer set search_path = '' as $$
  select b.id, b.name, b.address, b.deleted_at, ma.created_at,
    (select count(*)::int from public.reviews r
      where r.bathroom_id = b.id and r.deleted_at is null),
    (select count(*)::int from public.reviews r
      where r.bathroom_id = b.id and r.deleted_at is not null),
    (select count(*)::int from public.reports rp
      where rp.status = 'open'
        and (rp.bathroom_id = b.id
             or rp.review_id in (select r2.id from public.reviews r2
                                  where r2.bathroom_id = b.id)))
  from public.moderator_assignments ma
  join public.bathrooms b on b.id = ma.bathroom_id
  where ma.moderator_id = (select auth.uid())
  order by 8 desc, ma.created_at desc;
$$;
grant execute on function public.my_assigned_bathrooms() to authenticated;
