-- Watrloo: roles, reporting, and reactive moderation.
--
-- Model (see docs/ops/USERS_AND_ROLES.md): reviews and bathrooms publish
-- immediately, with no approval gate. Anyone can *report* content; a moderator
-- then triages the report and can remove (soft-delete), restore, or edit it.
--
-- Nothing here hard-deletes. Removal is reversible (so "approve/restore" works),
-- and it sidesteps a real hazard: destroying a review row would strand its photo
-- objects in storage, which the database can't reach. Permanent purges stay a
-- service_role/dashboard job.
--
-- Authorization is enforced by RLS + SECURITY DEFINER RPCs, never by the client.
-- The role source of truth is `user_roles`; is_moderator()/is_admin() read it
-- directly. (The JWT custom-access-token-hook optimization in the doc is a
-- later upgrade that removes the per-statement table touch.)

-- ---------------------------------------------------------------------------
-- 1. Roles + helpers
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('moderator', 'admin');

create table public.user_roles (
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.app_role not null,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

alter table public.user_roles enable row level security;

-- RLS narrows an existing grant, so authenticated needs table-level SELECT; the
-- policies below confine it to the caller's own rows (admins see all). There is
-- deliberately NO insert/update/delete policy: the only write paths are
-- service_role (bypasses RLS) and admin_grant_role/admin_revoke_role below.
-- That is what keeps role assignment unreachable from an ordinary client.
grant select on table public.user_roles to authenticated;

-- Helpers first (the user_roles read policy references is_admin). SECURITY
-- DEFINER so they read user_roles regardless of the caller's own RLS — which
-- also prevents infinite recursion with the policy that calls is_admin(). Kept
-- `stable` and called as `(select public.is_moderator())` at every call site so
-- Postgres hoists them to a once-per-statement InitPlan instead of per row.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('moderator', 'admin')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role = 'admin'
  );
$$;

grant execute on function public.is_moderator() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

create policy "users read their own roles"
  on public.user_roles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "admins read all roles"
  on public.user_roles for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- 2. Soft-delete columns on the moderatable content
-- ---------------------------------------------------------------------------
alter table public.reviews
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id) on delete set null;

alter table public.bathrooms
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id) on delete set null;

-- Partial indexes for the common "only live rows" scans.
create index reviews_live_idx   on public.reviews   (bathroom_id) where deleted_at is null;
create index bathrooms_live_idx on public.bathrooms (created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 3. Visibility: hide soft-deleted content from everyone but moderators.
--
-- These SELECT policies replace the old `using (true)` ones with the same names.
-- Because bathroom_stats is security_invoker and search_bathrooms /
-- nearby_bathrooms are SECURITY INVOKER sql functions, they all inherit this
-- filter automatically for anon/authenticated callers — no RPC body changes.
-- ---------------------------------------------------------------------------
drop policy "bathrooms are viewable by everyone" on public.bathrooms;
create policy "bathrooms are viewable by everyone"
  on public.bathrooms for select
  using (deleted_at is null or (select public.is_moderator()));

drop policy "reviews are viewable by everyone" on public.reviews;
create policy "reviews are viewable by everyone"
  on public.reviews for select
  using (deleted_at is null or (select public.is_moderator()));

-- A removed review must never move a bathroom's averages, regardless of who is
-- asking (a moderator can see the row but it still shouldn't count). Filter in
-- the view itself, not only through the reader's RLS.
create or replace view public.bathroom_stats
with (security_invoker = on) as
select
  b.id                                    as bathroom_id,
  count(r.id)::int                        as review_count,
  round(avg(r.rating)::numeric, 2)        as avg_rating,
  round(avg(r.cleanliness)::numeric, 2)   as avg_cleanliness,
  round(avg(r.privacy)::numeric, 2)       as avg_privacy,
  round(avg(r.accessibility)::numeric, 2) as avg_accessibility
from public.bathrooms b
left join public.reviews r
  on r.bathroom_id = b.id and r.deleted_at is null
group by b.id;

-- ---------------------------------------------------------------------------
-- 4. Moderator write access to any content. Edits reuse the normal forms via
--    these UPDATE policies; removals/restores go through the audited RPCs (§7).
-- ---------------------------------------------------------------------------
create policy "moderators update any bathroom"
  on public.bathrooms for update to authenticated
  using ((select public.is_moderator()))
  with check ((select public.is_moderator()));

create policy "moderators update any review"
  on public.reviews for update to authenticated
  using ((select public.is_moderator()))
  with check ((select public.is_moderator()));

-- ---------------------------------------------------------------------------
-- 5. Reports — how a user flags content for a moderator.
-- ---------------------------------------------------------------------------
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles (id) on delete set null,
  -- Exactly one target. Real FKs (not a polymorphic string) so integrity holds
  -- and deleting the target cleans up its reports.
  review_id   uuid references public.reviews (id)   on delete cascade,
  bathroom_id uuid references public.bathrooms (id) on delete cascade,
  reason      text not null check (char_length(reason) between 1 and 1000),
  status      text not null default 'open'
              check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  check ((review_id is not null)::int + (bathroom_id is not null)::int = 1)
);
create index reports_open_idx on public.reports (created_at desc) where status = 'open';

alter table public.reports enable row level security;
grant select, insert on table public.reports to authenticated;

create policy "users file their own reports"
  on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id);

-- A reporter can see their own reports; moderators see everything. Not public —
-- a report can contain an accusation.
create policy "read own reports or all as moderator"
  on public.reports for select to authenticated
  using ((select auth.uid()) = reporter_id or (select public.is_moderator()));

-- No update/delete policy: reports are resolved only through the audited RPC.

-- ---------------------------------------------------------------------------
-- 6. Audit log — every moderator state change lands here, written only by the
--    SECURITY DEFINER RPCs below, so an action can't happen without a record.
-- ---------------------------------------------------------------------------
create table public.moderation_actions (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null check (action in (
                'soft_delete_review', 'restore_review',
                'soft_delete_bathroom', 'restore_bathroom',
                'resolve_report', 'dismiss_report',
                'grant_role', 'revoke_role')),
  target_type text not null check (target_type in ('review', 'bathroom', 'report', 'profile')),
  target_id   uuid not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index moderation_actions_created_idx on public.moderation_actions (created_at desc);

alter table public.moderation_actions enable row level security;
grant select on table public.moderation_actions to authenticated;

create policy "moderators read the audit log"
  on public.moderation_actions for select to authenticated
  using ((select public.is_moderator()));
-- No write policy: only the SECURITY DEFINER RPCs insert here.

-- ---------------------------------------------------------------------------
-- 7. Moderation RPCs. Each re-checks the role server-side, performs the action,
--    and writes the audit row in the same transaction, so the log can't be
--    skipped. `42501` maps to an HTTP 403 at PostgREST.
-- ---------------------------------------------------------------------------
create or replace function public.moderate_soft_delete_review(p_review_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.reviews
     set deleted_at = now(), deleted_by = (select auth.uid())
   where id = p_review_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'soft_delete_review', 'review', p_review_id,
          jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.moderate_restore_review(p_review_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.reviews
     set deleted_at = null, deleted_by = null
   where id = p_review_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'restore_review', 'review', p_review_id);
end;
$$;

create or replace function public.moderate_soft_delete_bathroom(p_bathroom_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.bathrooms
     set deleted_at = now(), deleted_by = (select auth.uid())
   where id = p_bathroom_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'soft_delete_bathroom', 'bathroom', p_bathroom_id,
          jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.moderate_restore_bathroom(p_bathroom_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.bathrooms
     set deleted_at = null, deleted_by = null
   where id = p_bathroom_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'restore_bathroom', 'bathroom', p_bathroom_id);
end;
$$;

-- Resolve a report. p_dismiss = true means "no action needed" (content stays);
-- false means "handled" (the moderator removed/edited the target separately).
create or replace function public.moderate_resolve_report(p_report_id uuid, p_dismiss boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
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
end;
$$;

grant execute on function public.moderate_soft_delete_review(uuid, text)   to authenticated;
grant execute on function public.moderate_restore_review(uuid)             to authenticated;
grant execute on function public.moderate_soft_delete_bathroom(uuid, text) to authenticated;
grant execute on function public.moderate_restore_bathroom(uuid)           to authenticated;
grant execute on function public.moderate_resolve_report(uuid, boolean)    to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Admin-only role management. The only sanctioned write path to user_roles
--    outside service_role; gated on is_admin(), logged like everything else.
-- ---------------------------------------------------------------------------
create or replace function public.admin_grant_role(p_user_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into public.user_roles (user_id, role, granted_by)
  values (p_user_id, p_role, (select auth.uid()))
  on conflict (user_id, role) do nothing;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'grant_role', 'profile', p_user_id,
          jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.admin_revoke_role(p_user_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.user_roles
   where user_id = p_user_id and role = p_role;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'revoke_role', 'profile', p_user_id,
          jsonb_build_object('role', p_role));
end;
$$;

grant execute on function public.admin_grant_role(uuid, public.app_role)  to authenticated;
grant execute on function public.admin_revoke_role(uuid, public.app_role) to authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap the FIRST admin once, from the Supabase SQL editor (service_role),
-- since the RPCs above require an existing admin. Find the id in Auth → Users.
--
--   insert into public.user_roles (user_id, role)
--   values ('00000000-0000-0000-0000-000000000000', 'admin');
--
-- Thereafter admins grant roles from the in-app admin portal.
-- ---------------------------------------------------------------------------
