-- Watrloo: SCOPED moderation — assignment becomes the permission boundary.
--
-- Until now `is_moderator()` granted sitewide reach, and assignments were only
-- a worklist ("this focuses their attention"). Owner decision 2026-07-12: a
-- moderator's power now extends exactly as far as what an admin assigned them —
-- individual bathrooms, or an org (business), which covers every bathroom that
-- org has VERIFIED claims on. A moderator with no assignments can moderate
-- nothing. Admins remain global.
--
-- Enforced in the database, not the UI:
--   * every moderation RPC re-checks scope on the specific target;
--   * RLS: removed (soft-deleted) content is visible only inside scope;
--   * RLS: reports readable only when the reported target is in scope;
--   * storage: photo objects deletable only inside scope.
--
-- Role granting is unchanged (admins mint moderators), but the role alone is
-- now inert — see docs/ops/USERS_AND_ROLES.md.

-- ---------------------------------------------------------------------------
-- 1. Audit vocabulary (FULL list — the standing rule) + org assignments.
-- ---------------------------------------------------------------------------
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
    'create_business', 'delete_business', 'set_org_member',
    'approve_edit_request', 'reject_edit_request',
    'assign_org', 'unassign_org'                             -- new
  ));

create table if not exists public.moderator_org_assignments (
  moderator_id uuid not null references public.profiles (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  assigned_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (moderator_id, business_id)
);
create index if not exists moderator_org_assignments_business_idx
  on public.moderator_org_assignments (business_id);

alter table public.moderator_org_assignments enable row level security;
grant select on public.moderator_org_assignments to authenticated;
drop policy if exists "moderators read own org assignments, admins all"
  on public.moderator_org_assignments;
create policy "moderators read own org assignments, admins all"
  on public.moderator_org_assignments for select to authenticated
  using (moderator_id = (select auth.uid()) or (select public.is_admin()));
-- Writes: admin RPC only.

create or replace function public.admin_assign_orgs(
  p_moderator_id uuid, p_business_ids uuid[], p_add boolean)
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

  foreach v_id in array coalesce(p_business_ids, '{}') loop
    if p_add then
      insert into public.moderator_org_assignments (moderator_id, business_id, assigned_by)
      values (p_moderator_id, v_id, (select auth.uid()))
      on conflict do nothing;
      if not found then continue; end if;
    else
      delete from public.moderator_org_assignments
       where moderator_id = p_moderator_id and business_id = v_id;
      if not found then continue; end if;
    end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values ((select auth.uid()),
            case when p_add then 'assign_org' else 'unassign_org' end,
            'business', v_id, jsonb_build_object('moderator_id', p_moderator_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_assign_orgs(uuid, uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE scope predicate. True for admins everywhere; for moderators only on
--    bathrooms assigned directly or reachable through an org assignment via a
--    VERIFIED claim. security definer so RLS on the assignment tables can't
--    interfere; called with a row-dependent argument, so it runs per row where
--    used in a policy — both probes are primary-key/index hits.
-- ---------------------------------------------------------------------------
create or replace function public.moderates_bathroom(p_bathroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.is_admin())
      or ((select public.is_moderator()) and (
            exists (select 1 from public.moderator_assignments ma
                     where ma.moderator_id = (select auth.uid())
                       and ma.bathroom_id = p_bathroom_id)
         or exists (select 1 from public.moderator_org_assignments mo
                     join public.bathroom_claims c
                       on c.business_id = mo.business_id
                      and c.bathroom_id = p_bathroom_id
                      and c.status = 'verified'
                    where mo.moderator_id = (select auth.uid()))));
$$;
-- anon needs execute because public SELECT policies now reference it (the
-- deleted_at branch decides for anon, but the planner may still ask).
grant execute on function public.moderates_bathroom(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Visibility + write RLS, rescoped. Same policy names, tighter bodies.
-- ---------------------------------------------------------------------------
drop policy "reviews are viewable by everyone" on public.reviews;
create policy "reviews are viewable by everyone"
  on public.reviews for select
  using (deleted_at is null or public.moderates_bathroom(bathroom_id));

drop policy "bathrooms are viewable by everyone" on public.bathrooms;
create policy "bathrooms are viewable by everyone"
  on public.bathrooms for select
  using (deleted_at is null or public.moderates_bathroom(id));

drop policy "moderators update any review" on public.reviews;
create policy "moderators update any review"
  on public.reviews for update to authenticated
  using (public.moderates_bathroom(bathroom_id))
  with check (public.moderates_bathroom(bathroom_id));

drop policy "moderators update any bathroom" on public.bathrooms;
create policy "moderators update any bathroom"
  on public.bathrooms for update to authenticated
  using (public.moderates_bathroom(id))
  with check (public.moderates_bathroom(id));

-- Reports: reporter sees their own; otherwise only when the reported target's
-- bathroom is in scope (moderates_bathroom already includes admins). The
-- review subquery runs under the reviews RLS above, which resolves for any
-- report a moderator is entitled to see.
drop policy "read own reports or all as moderator" on public.reports;
create policy "read own reports or in scope as moderator"
  on public.reports for select to authenticated
  using (
    (select auth.uid()) = reporter_id
    or public.moderates_bathroom(coalesce(
         bathroom_id,
         (select r.bathroom_id from public.reviews r where r.id = review_id)))
  );

-- Storage: a moderator deletes photo bytes only for reviews in scope. The
-- lookup runs while the review_photos row still exists (the client deletes
-- bytes first, then the RPC drops the row).
create index if not exists review_photos_storage_path_idx
  on public.review_photos (storage_path);

drop policy "moderators delete any review photo object" on storage.objects;
create policy "moderators delete review photo objects in scope"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'review-photos'
    and exists (
      select 1
      from public.review_photos rp
      join public.reviews r on r.id = rp.review_id
      where rp.storage_path = name
        and public.moderates_bathroom(r.bathroom_id)
    )
  );

-- The community tag edit trail (20260714000000) follows the same rule.
drop policy if exists "moderators read the tag edit trail" on public.attribute_edits;
create policy "moderators read the tag edit trail in scope"
  on public.attribute_edits for select to authenticated
  using (public.moderates_bathroom(bathroom_id));

-- ---------------------------------------------------------------------------
-- 4. Moderation RPCs re-check scope on the specific target. Bodies otherwise
--    identical to 20260710020000 / 20260712010000.
-- ---------------------------------------------------------------------------
create or replace function public.moderate_soft_delete_review(p_review_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bathroom uuid;
begin
  select bathroom_id into v_bathroom from public.reviews where id = p_review_id;
  if v_bathroom is null then return; end if;
  if not public.moderates_bathroom(v_bathroom) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.reviews
     set deleted_at = now(), deleted_by = (select auth.uid())
   where id = p_review_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'soft_delete_review', 'review', p_review_id,
          jsonb_build_object('reason', p_reason));
end; $$;

create or replace function public.moderate_restore_review(p_review_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bathroom uuid;
begin
  select bathroom_id into v_bathroom from public.reviews where id = p_review_id;
  if v_bathroom is null then return; end if;
  if not public.moderates_bathroom(v_bathroom) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.reviews
     set deleted_at = null, deleted_by = null
   where id = p_review_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'restore_review', 'review', p_review_id);
end; $$;

create or replace function public.moderate_soft_delete_bathroom(p_bathroom_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.moderates_bathroom(p_bathroom_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.bathrooms
     set deleted_at = now(), deleted_by = (select auth.uid())
   where id = p_bathroom_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'soft_delete_bathroom', 'bathroom', p_bathroom_id,
          jsonb_build_object('reason', p_reason));
end; $$;

create or replace function public.moderate_restore_bathroom(p_bathroom_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.moderates_bathroom(p_bathroom_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.bathrooms
     set deleted_at = null, deleted_by = null
   where id = p_bathroom_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'restore_bathroom', 'bathroom', p_bathroom_id);
end; $$;

create or replace function public.moderate_resolve_report(p_report_id uuid, p_dismiss boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bathroom uuid;
begin
  select coalesce(rp.bathroom_id, r.bathroom_id) into v_bathroom
    from public.reports rp
    left join public.reviews r on r.id = rp.review_id
   where rp.id = p_report_id;
  if v_bathroom is null then return; end if;
  if not public.moderates_bathroom(v_bathroom) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.reports
     set status = case when p_dismiss then 'dismissed' else 'resolved' end,
         resolved_by = (select auth.uid()),
         resolved_at = now()
   where id = p_report_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()),
          case when p_dismiss then 'dismiss_report' else 'resolve_report' end,
          'report', p_report_id);
end; $$;

create or replace function public.moderate_delete_review_photo(p_photo_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_review_id    uuid;
  v_storage_path text;
  v_bathroom     uuid;
begin
  select rp.review_id, rp.storage_path, r.bathroom_id
    into v_review_id, v_storage_path, v_bathroom
    from public.review_photos rp
    join public.reviews r on r.id = rp.review_id
   where rp.id = p_photo_id;
  -- Already gone (a retry, or two moderators racing): nothing to audit twice.
  if not found then return; end if;
  if not public.moderates_bathroom(v_bathroom) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.review_photos where id = p_photo_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'delete_review_photo', 'photo', p_photo_id,
          jsonb_build_object(
            'reason', p_reason,
            'review_id', v_review_id,
            'storage_path', v_storage_path));
end; $$;

-- ---------------------------------------------------------------------------
-- 5. The worklist now IS the jurisdiction: direct assignments plus bathrooms
--    reachable through org assignments (verified claims), deduplicated.
--    Signature unchanged, so the frontend keeps its type.
-- ---------------------------------------------------------------------------
create or replace function public.my_assigned_bathrooms()
returns table (
  bathroom_id uuid, name text, address text, deleted_at timestamptz,
  assigned_at timestamptz, review_count int, removed_reviews int, open_reports int
)
language sql stable security definer set search_path = '' as $$
  with scope as (
    select s.bathroom_id, min(s.assigned_at) as assigned_at
    from (
      select ma.bathroom_id, ma.created_at as assigned_at
        from public.moderator_assignments ma
       where ma.moderator_id = (select auth.uid())
      union all
      select c.bathroom_id, mo.created_at
        from public.moderator_org_assignments mo
        join public.bathroom_claims c
          on c.business_id = mo.business_id and c.status = 'verified'
       where mo.moderator_id = (select auth.uid())
    ) s
    group by s.bathroom_id
  )
  select b.id, b.name, b.address, b.deleted_at, sc.assigned_at,
    (select count(*)::int from public.reviews r
      where r.bathroom_id = b.id and r.deleted_at is null),
    (select count(*)::int from public.reviews r
      where r.bathroom_id = b.id and r.deleted_at is not null),
    (select count(*)::int from public.reports rp
      where rp.status = 'open'
        and (rp.bathroom_id = b.id
             or rp.review_id in (select r2.id from public.reviews r2
                                  where r2.bathroom_id = b.id)))
  from scope sc
  join public.bathrooms b on b.id = sc.bathroom_id
  order by 8 desc, sc.assigned_at desc;
$$;
grant execute on function public.my_assigned_bathrooms() to authenticated;
