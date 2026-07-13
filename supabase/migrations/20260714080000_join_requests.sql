-- Watrloo: recruitment policy + join requests. A unit either takes recruits
-- on the spot ('open', the default and prior behavior) or by application
-- ('approval'): hopefuls file a request with an optional note, and the
-- commander or an officer approves or denies it. One pending request per
-- soldier keeps the queue honest.

alter table public.battalions
  add column if not exists recruitment text not null default 'open'
    check (recruitment in ('open', 'approval'));

create table if not exists public.battalion_join_requests (
  id           uuid primary key default gen_random_uuid(),
  battalion_id uuid not null references public.battalions (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  message      text check (message is null or char_length(message) <= 280),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'denied', 'cancelled')),
  decided_by   uuid references public.profiles (id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists battalion_join_requests_one_pending
  on public.battalion_join_requests (user_id) where status = 'pending';
create index if not exists battalion_join_requests_unit_idx
  on public.battalion_join_requests (battalion_id, status);
alter table public.battalion_join_requests enable row level security;
-- No policies on purpose: reads and writes go through SECURITY DEFINER RPCs.

-- The commander sets the door policy.
create or replace function public.set_battalion_recruitment(p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
begin
  if p_mode not in ('open', 'approval') then
    raise exception 'recruitment is open or by approval';
  end if;
  select battalion_id into v_unit from public.battalion_members
   where user_id = uid and role = 'commander';
  if v_unit is null then
    raise exception 'only the commanding officer sets recruitment policy'
      using errcode = '42501';
  end if;
  update public.battalions set recruitment = p_mode where id = v_unit;
end; $$;
grant execute on function public.set_battalion_recruitment(text) to authenticated;

-- Open units enlist on the spot; approval units point you at the request
-- queue. (Full replacement of join_battalion from 20260714040000.)
create or replace function public.join_battalion(p_battalion_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_level int;
  v_mode text;
  v_cap int;
  v_count int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if exists (select 1 from public.battalion_members m where m.user_id = uid) then
    raise exception 'you are already enlisted in a battalion' using errcode = '23505';
  end if;
  -- Lock the unit row so concurrent joins serialize against the cap check.
  select echelon, recruitment into v_level, v_mode from public.battalions
   where id = p_battalion_id for update;
  if not found then
    raise exception 'no such battalion' using errcode = 'P0002';
  end if;
  if v_mode = 'approval' then
    raise exception 'this unit takes recruits by application — send a request to join';
  end if;
  select member_cap into v_cap from public.battalion_echelons where level = v_level;
  select count(*) into v_count from public.battalion_members
   where battalion_id = p_battalion_id;
  if v_count >= v_cap then
    raise exception 'unit is at full strength — it must earn its next promotion to take on more soldiers';
  end if;
  insert into public.battalion_members (user_id, battalion_id, role)
  values (uid, p_battalion_id, 'member');
end; $$;

create or replace function public.request_join_battalion(
  p_battalion_id uuid, p_message text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if exists (select 1 from public.battalion_members m where m.user_id = uid) then
    raise exception 'you are already enlisted in a battalion' using errcode = '23505';
  end if;
  if not exists (select 1 from public.battalions b where b.id = p_battalion_id) then
    raise exception 'no such battalion' using errcode = 'P0002';
  end if;
  insert into public.battalion_join_requests (battalion_id, user_id, message)
  values (p_battalion_id, uid, nullif(left(btrim(coalesce(p_message, '')), 280), ''))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'you already have a pending request — cancel it first';
end; $$;
grant execute on function public.request_join_battalion(uuid, text) to authenticated;

create or replace function public.cancel_join_request()
returns void language sql security definer set search_path = '' as $$
  update public.battalion_join_requests
     set status = 'cancelled', decided_at = now()
   where user_id = (select auth.uid()) and status = 'pending';
$$;
grant execute on function public.cancel_join_request() to authenticated;

create or replace function public.my_join_request()
returns table (id uuid, battalion_id uuid, battalion_name text, message text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.battalion_id, b.name, r.message, r.created_at
  from public.battalion_join_requests r
  join public.battalions b on b.id = r.battalion_id
  where r.user_id = (select auth.uid()) and r.status = 'pending';
$$;
grant execute on function public.my_join_request() to authenticated;

-- The recruiting desk: pending applications, visible to the unit's brass.
create or replace function public.list_unit_join_requests()
returns table (
  id uuid, user_id uuid, username text, campaigns int,
  message text, created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select r.id, r.user_id, p.username, public.live_review_count(r.user_id),
         r.message, r.created_at
  from public.battalion_join_requests r
  join public.profiles p on p.id = r.user_id
  where r.status = 'pending'
    and r.battalion_id in (
      select m.battalion_id from public.battalion_members m
       where m.user_id = (select auth.uid()) and m.role in ('commander', 'officer'))
  order by r.created_at;
$$;
grant execute on function public.list_unit_join_requests() to authenticated;

create or replace function public.decide_join_request(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_user uuid;
  v_level int;
  v_cap int;
  v_count int;
begin
  select battalion_id, user_id into v_unit, v_user
    from public.battalion_join_requests
   where id = p_id and status = 'pending';
  if v_unit is null then
    raise exception 'no such pending request' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.battalion_members m
                  where m.user_id = uid and m.battalion_id = v_unit
                    and m.role in ('commander', 'officer')) then
    raise exception 'only the unit''s commander or officers decide applications'
      using errcode = '42501';
  end if;
  if p_approve then
    if exists (select 1 from public.battalion_members m where m.user_id = v_user) then
      update public.battalion_join_requests
         set status = 'cancelled', decided_by = uid, decided_at = now()
       where id = p_id;
      raise exception 'that soldier has since enlisted elsewhere';
    end if;
    select echelon into v_level from public.battalions where id = v_unit for update;
    select member_cap into v_cap from public.battalion_echelons where level = v_level;
    select count(*) into v_count from public.battalion_members
     where battalion_id = v_unit;
    if v_count >= v_cap then
      raise exception 'unit is at full strength — earn a promotion before taking recruits';
    end if;
    insert into public.battalion_members (user_id, battalion_id, role)
    values (v_user, v_unit, 'member');
  end if;
  update public.battalion_join_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_by = uid, decided_at = now()
   where id = p_id;
end; $$;
grant execute on function public.decide_join_request(uuid, boolean) to authenticated;

-- Standings now show the door policy.
drop view if exists public.battalion_leaderboard;
create view public.battalion_leaderboard
with (security_invoker = on) as
select
  b.id, b.name, b.motto, b.created_at, b.echelon, b.recruitment,
  e.name as echelon_name, e.member_cap,
  count(distinct m.user_id)::int as member_count,
  count(r.id)::int               as review_count
from public.battalions b
join public.battalion_echelons e on e.level = b.echelon
join public.battalion_members m on m.battalion_id = b.id
left join public.reviews r on r.author_id = m.user_id and r.deleted_at is null
group by b.id, b.name, b.motto, b.created_at, b.echelon, b.recruitment,
         e.name, e.member_cap;
