-- Watrloo: discipline flows down the chain of command, and the admin console
-- speaks with one official voice.
--
-- 1) Unit moderation: a soldier's SUPERIORS (their detail's officer, and the
--    unit commander) can see open reports on that soldier's reviews and
--    remove the offending review themselves. If a superior doesn't act, the
--    next level up sees the same queue (the commander outranks every officer)
--    and can DISCIPLINE: file a flag on the soldier's unit record, or — the
--    commander only — request an admin ban with a reason. Admins triage ban
--    requests in the control room.
-- 2) The @watrloo system account: the official voice the admin console acts
--    as. Audit rows keep the real admin's id; the public face is @watrloo.
--    Multiple admins all share it.

-- ---------------------------------------------------------------------------
-- Who outranks whom. Officers outrank the soldiers of their own detail;
-- the commander outranks everyone in the unit. Nobody outranks themself.
-- ---------------------------------------------------------------------------
create or replace function public.unit_superior_of(p_subject uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.battalion_members s
    join public.battalion_members c
      on c.battalion_id = s.battalion_id
     and c.user_id = (select auth.uid())
    where s.user_id = p_subject
      and s.user_id <> c.user_id
      and (   c.role = 'commander'
           or (c.role = 'officer' and s.role = 'member' and s.reports_to = c.user_id))
  );
$$;
grant execute on function public.unit_superior_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The superior's queue: open reports on subordinates' live reviews.
-- ---------------------------------------------------------------------------
create or replace function public.unit_flagged_reviews()
returns table (
  report_id uuid,
  reason text,
  reported_at timestamptz,
  review_id uuid,
  review_body text,
  review_rating numeric,
  author_id uuid,
  author_username text,
  bathroom_id uuid,
  bathroom_name text
)
language sql stable security definer set search_path = ''
as $$
  select rp.id, rp.reason, rp.created_at,
         r.id, r.body, r.rating,
         r.author_id, p.username,
         b.id, b.name
  from public.reports rp
  join public.reviews r on r.id = rp.review_id
  join public.profiles p on p.id = r.author_id
  join public.bathrooms b on b.id = r.bathroom_id
  where rp.status = 'open'
    and r.deleted_at is null
    and public.unit_superior_of(r.author_id)
  order by rp.created_at;
$$;
grant execute on function public.unit_flagged_reviews() to authenticated;

-- ---------------------------------------------------------------------------
-- A superior removes a subordinate's review. Same soft-delete + audit shape
-- as moderate_soft_delete_review, but the authority is the chain of command.
-- Open reports on the review resolve with it.
-- ---------------------------------------------------------------------------
create or replace function public.unit_remove_review(p_review_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_author uuid;
begin
  select author_id into v_author from public.reviews
   where id = p_review_id and deleted_at is null;
  if v_author is null then
    raise exception 'no such live review' using errcode = 'P0002';
  end if;
  if not public.unit_superior_of(v_author) then
    raise exception 'only that soldier''s superiors can act on their reviews'
      using errcode = '42501';
  end if;

  update public.reviews
     set deleted_at = now(), deleted_by = uid
   where id = p_review_id;

  update public.reports
     set status = 'resolved', resolved_by = uid, resolved_at = now()
   where review_id = p_review_id and status = 'open';

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values (uid, 'soft_delete_review', 'review', p_review_id,
          jsonb_build_object('reason', p_reason, 'via', 'chain_of_command'));
end; $$;
grant execute on function public.unit_remove_review(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The unit's discipline record. Writes only through the RPCs below.
-- ---------------------------------------------------------------------------
create table if not exists public.unit_discipline (
  id           uuid primary key default gen_random_uuid(),
  battalion_id uuid not null references public.battalions (id) on delete cascade,
  subject_id   uuid not null references public.profiles (id) on delete cascade,
  raised_by    uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('flag', 'ban_request')),
  reason       text not null check (char_length(reason) between 3 and 500),
  review_id    uuid references public.reviews (id) on delete set null,
  status       text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution   text,
  resolved_by  uuid references public.profiles (id),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists unit_discipline_battalion_idx
  on public.unit_discipline (battalion_id, status);
-- One open item per soldier per kind keeps escalation tidy.
create unique index if not exists unit_discipline_one_open
  on public.unit_discipline (subject_id, kind) where status = 'open';
alter table public.unit_discipline enable row level security;
-- No policies on purpose: every read and write goes through SECURITY DEFINER RPCs.

create or replace function public.file_unit_discipline(
  p_subject uuid, p_kind text, p_reason text, p_review_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_clean text;
  v_id uuid;
begin
  if p_kind not in ('flag', 'ban_request') then
    raise exception 'unknown discipline kind';
  end if;
  select battalion_id into v_unit from public.battalion_members
   where user_id = p_subject;
  if v_unit is null then
    raise exception 'that soldier is not enlisted' using errcode = 'P0002';
  end if;
  if p_kind = 'flag' then
    if not public.unit_superior_of(p_subject) then
      raise exception 'only a superior can flag a soldier' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from public.battalion_members c
                    where c.user_id = uid and c.battalion_id = v_unit
                      and c.role = 'commander') then
      raise exception 'ban requests come from the unit commander' using errcode = '42501';
    end if;
  end if;
  v_clean := btrim(coalesce(p_reason, ''));
  if char_length(v_clean) < 3 then
    raise exception 'give a reason — discipline without cause is tyranny';
  end if;
  insert into public.unit_discipline (battalion_id, subject_id, raised_by, kind, reason, review_id)
  values (v_unit, p_subject, uid, p_kind, left(v_clean, 500), p_review_id)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'there is already an open % on that soldier', p_kind;
end; $$;
grant execute on function public.file_unit_discipline(uuid, text, text, uuid) to authenticated;

-- Everyone sees what concerns them: items they raised, items about their
-- subordinates, and items on their own record. Admins see everything.
create or replace function public.list_unit_discipline()
returns table (
  id uuid, kind text, reason text, status text, resolution text,
  created_at timestamptz, review_id uuid,
  subject_id uuid, subject_username text,
  raised_by uuid, raised_by_username text
)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.kind, d.reason, d.status, d.resolution, d.created_at, d.review_id,
         d.subject_id, sp.username, d.raised_by, rp.username
  from public.unit_discipline d
  join public.profiles sp on sp.id = d.subject_id
  join public.profiles rp on rp.id = d.raised_by
  where d.subject_id = (select auth.uid())
     or d.raised_by = (select auth.uid())
     or public.unit_superior_of(d.subject_id)
     or public.is_admin()
  order by (d.status = 'open') desc, d.created_at desc
  limit 100;
$$;
grant execute on function public.list_unit_discipline() to authenticated;

create or replace function public.resolve_unit_discipline(
  p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_kind text;
  v_unit uuid;
  v_raised_by uuid;
begin
  if p_status not in ('resolved', 'dismissed') then
    raise exception 'discipline resolves or is dismissed';
  end if;
  select kind, battalion_id, raised_by into v_kind, v_unit, v_raised_by
    from public.unit_discipline where id = p_id and status = 'open';
  if v_kind is null then
    raise exception 'no such open discipline item' using errcode = 'P0002';
  end if;
  if v_kind = 'ban_request' then
    if not public.is_admin() then
      raise exception 'ban requests are decided by admins' using errcode = '42501';
    end if;
  else
    if not (public.is_admin()
            or (v_raised_by = uid and p_status = 'dismissed') -- withdraw your own
            or exists (select 1 from public.battalion_members c
                        where c.user_id = uid and c.battalion_id = v_unit
                          and c.role = 'commander')) then
      raise exception 'flags are decided by the commander (or withdrawn by whoever raised them)'
        using errcode = '42501';
    end if;
  end if;
  update public.unit_discipline
     set status = p_status,
         resolution = nullif(left(btrim(coalesce(p_note, '')), 500), ''),
         resolved_by = uid,
         resolved_at = now()
   where id = p_id;
end; $$;
grant execute on function public.resolve_unit_discipline(uuid, text, text) to authenticated;

-- Admin triage queue for ban requests, with enough context to decide.
create or replace function public.admin_list_ban_requests()
returns table (
  id uuid, reason text, created_at timestamptz, review_id uuid,
  subject_id uuid, subject_username text,
  raised_by uuid, raised_by_username text,
  battalion_id uuid, battalion_name text
)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.reason, d.created_at, d.review_id,
         d.subject_id, sp.username, d.raised_by, rp.username,
         d.battalion_id, b.name
  from public.unit_discipline d
  join public.profiles sp on sp.id = d.subject_id
  join public.profiles rp on rp.id = d.raised_by
  join public.battalions b on b.id = d.battalion_id
  where d.kind = 'ban_request' and d.status = 'open'
    and public.is_admin()
  order by d.created_at;
$$;
grant execute on function public.admin_list_ban_requests() to authenticated;

-- ---------------------------------------------------------------------------
-- The official voice: the @watrloo system account. No password, no login —
-- it exists so admin actions can wear one public face (today: the admin
-- console banner and any future official posts; audits keep real admin ids).
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values ('a0a0a0a0-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'system@watrloo.com', now(), now(), now())
on conflict (id) do nothing;
-- The signup trigger (handle_new_user) races us and creates the profile with
-- a generated fallback username, so claim the name with an upsert.
insert into public.profiles (id, username)
values ('a0a0a0a0-0000-4000-8000-000000000001', 'watrloo')
on conflict (id) do update set username = 'watrloo';
