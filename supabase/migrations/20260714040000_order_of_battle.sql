-- Watrloo: the Order of Battle. Units start life as a Squad and earn their
-- way up the U.S.-Army-style ladder (Squad → Platoon → Company → Battalion →
-- Brigade → Division → Corps → Field Army). Each echelon raises the member
-- cap and opens officer posts; promotion is earned (strength + campaigns) and
-- never revoked. Commanders appoint officers and can hand off command.

-- ---------------------------------------------------------------------------
-- 1. The ladder: reference data, public to read, admin-tunable in SQL.
--    member_cap  = most soldiers the unit can hold AT this echelon
--    min_members/min_campaigns = requirements to BE PROMOTED TO this echelon
-- ---------------------------------------------------------------------------
create table if not exists public.battalion_echelons (
  level         int primary key check (level between 1 and 8),
  name          text not null unique,
  member_cap    int not null,
  min_members   int not null,
  min_campaigns int not null
);
alter table public.battalion_echelons enable row level security;
grant select on public.battalion_echelons to anon, authenticated;
drop policy if exists "echelons are public" on public.battalion_echelons;
create policy "echelons are public" on public.battalion_echelons
  for select using (true);

insert into public.battalion_echelons (level, name, member_cap, min_members, min_campaigns) values
  (1, 'Squad',      6,    1,   0),
  (2, 'Platoon',    12,   4,   15),
  (3, 'Company',    24,   8,   40),
  (4, 'Battalion',  50,   16,  100),
  (5, 'Brigade',    100,  32,  250),
  (6, 'Division',   200,  64,  600),
  (7, 'Corps',      400,  120, 1500),
  (8, 'Field Army', 1000, 250, 4000)
on conflict (level) do update
  set name = excluded.name, member_cap = excluded.member_cap,
      min_members = excluded.min_members, min_campaigns = excluded.min_campaigns;

-- ---------------------------------------------------------------------------
-- 2. Units carry their earned echelon; members hold army roles.
-- ---------------------------------------------------------------------------
alter table public.battalions
  add column if not exists echelon int not null default 1
    references public.battalion_echelons (level);

alter table public.battalion_members drop constraint if exists battalion_members_role_check;
update public.battalion_members set role = 'commander' where role = 'leader';
alter table public.battalion_members add constraint battalion_members_role_check
  check (role in ('commander', 'officer', 'member'));

-- ---------------------------------------------------------------------------
-- 3. The unit's service record: founding and promotions. Public, and written
--    only from SECURITY DEFINER paths.
-- ---------------------------------------------------------------------------
create table if not exists public.battalion_achievements (
  id           uuid primary key default gen_random_uuid(),
  battalion_id uuid not null references public.battalions (id) on delete cascade,
  kind         text not null check (kind in ('founded', 'promotion')),
  level        int not null references public.battalion_echelons (level),
  note         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists battalion_achievements_battalion_idx
  on public.battalion_achievements (battalion_id);
alter table public.battalion_achievements enable row level security;
grant select on public.battalion_achievements to anon, authenticated;
drop policy if exists "unit achievements are public" on public.battalion_achievements;
create policy "unit achievements are public" on public.battalion_achievements
  for select using (true);

-- ---------------------------------------------------------------------------
-- 4. Promotion engine. High-water: a unit is promoted the moment it meets the
--    next echelon's strength and campaign requirements, and is never demoted
--    (members leaving costs future growth, not earned honors).
-- ---------------------------------------------------------------------------
create or replace function public.try_promote_battalion(p_battalion_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_level int;
  v_members int;
  v_campaigns int;
  v_next record;
begin
  select echelon into v_level from public.battalions
   where id = p_battalion_id for update;
  if not found then return; end if;

  select count(*) into v_members
    from public.battalion_members where battalion_id = p_battalion_id;
  select count(r.id) into v_campaigns
    from public.battalion_members m
    join public.reviews r on r.author_id = m.user_id and r.deleted_at is null
   where m.battalion_id = p_battalion_id;

  loop
    select * into v_next from public.battalion_echelons where level = v_level + 1;
    exit when not found
      or v_members < v_next.min_members
      or v_campaigns < v_next.min_campaigns;
    v_level := v_level + 1;
    update public.battalions set echelon = v_level where id = p_battalion_id;
    insert into public.battalion_achievements (battalion_id, kind, level, note)
    values (p_battalion_id, 'promotion', v_level, format('Promoted to %s', v_next.name));
  end loop;
end; $$;

create or replace function public.battalion_member_promotion_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.try_promote_battalion(new.battalion_id);
  return new;
end; $$;
drop trigger if exists battalion_members_promotion on public.battalion_members;
create trigger battalion_members_promotion
  after insert on public.battalion_members
  for each row execute function public.battalion_member_promotion_trg();

create or replace function public.review_unit_promotion_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_unit uuid;
begin
  if new.deleted_at is null then
    select battalion_id into v_unit
      from public.battalion_members where user_id = new.author_id;
    if v_unit is not null then
      perform public.try_promote_battalion(v_unit);
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists reviews_unit_promotion on public.reviews;
create trigger reviews_unit_promotion
  after insert or update of deleted_at on public.reviews
  for each row execute function public.review_unit_promotion_trg();

-- ---------------------------------------------------------------------------
-- 5. RPC updates: founding musters a Squad; joining respects the echelon's
--    member cap; succession prefers the senior officer.
-- ---------------------------------------------------------------------------
create or replace function public.create_battalion(p_name text, p_motto text default null)
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

  insert into public.battalions (name, motto, created_by)
  values (btrim(p_name), nullif(left(btrim(coalesce(p_motto, '')), 120), ''), uid)
  returning id into v_id;

  insert into public.battalion_members (user_id, battalion_id, role)
  values (uid, v_id, 'commander');

  insert into public.battalion_achievements (battalion_id, kind, level, note)
  values (v_id, 'founded', 1, format('%s musters as a Squad', btrim(p_name)));
  return v_id;
end; $$;

create or replace function public.join_battalion(p_battalion_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_level int;
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
  select echelon into v_level from public.battalions
   where id = p_battalion_id for update;
  if not found then
    raise exception 'no such battalion' using errcode = 'P0002';
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

create or replace function public.leave_battalion()
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_battalion uuid;
  v_role text;
  v_next uuid;
begin
  select battalion_id, role into v_battalion, v_role
  from public.battalion_members where user_id = uid;
  if v_battalion is null then return; end if;

  delete from public.battalion_members where user_id = uid;

  if not exists (select 1 from public.battalion_members m
                  where m.battalion_id = v_battalion) then
    -- Last soldier out dissolves the unit.
    delete from public.battalions where id = v_battalion;
  elsif v_role = 'commander' then
    -- Command passes to the senior officer, else the longest-serving member.
    select user_id into v_next from public.battalion_members
     where battalion_id = v_battalion
     order by (role = 'officer') desc, joined_at
     limit 1;
    update public.battalion_members set role = 'commander' where user_id = v_next;
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. Command controls: officer posts grow with echelon (one per level); the
--    commander can appoint, dismiss, and hand off command.
-- ---------------------------------------------------------------------------
create or replace function public.set_battalion_officer(p_user_id uuid, p_officer boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_level int;
  v_officers int;
  v_target_role text;
begin
  select battalion_id into v_unit from public.battalion_members
   where user_id = uid and role = 'commander';
  if v_unit is null then
    raise exception 'only the commanding officer can assign roles' using errcode = '42501';
  end if;
  select role into v_target_role from public.battalion_members
   where user_id = p_user_id and battalion_id = v_unit;
  if v_target_role is null then
    raise exception 'that soldier is not in your unit' using errcode = 'P0002';
  end if;
  if v_target_role = 'commander' then
    raise exception 'the commander cannot be demoted — transfer command instead';
  end if;
  if p_officer then
    select echelon into v_level from public.battalions where id = v_unit for update;
    select count(*) into v_officers from public.battalion_members
     where battalion_id = v_unit and role = 'officer';
    if v_officers >= v_level then
      raise exception 'no open officer posts — the unit needs a promotion first';
    end if;
  end if;
  update public.battalion_members
     set role = case when p_officer then 'officer' else 'member' end
   where user_id = p_user_id;
end; $$;
grant execute on function public.set_battalion_officer(uuid, boolean) to authenticated;

create or replace function public.transfer_battalion_command(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
begin
  if p_user_id = uid then return; end if;
  select battalion_id into v_unit from public.battalion_members
   where user_id = uid and role = 'commander';
  if v_unit is null then
    raise exception 'only the commanding officer can transfer command' using errcode = '42501';
  end if;
  if not exists (select 1 from public.battalion_members
                  where user_id = p_user_id and battalion_id = v_unit) then
    raise exception 'that soldier is not in your unit' using errcode = 'P0002';
  end if;
  update public.battalion_members set role = 'officer'   where user_id = uid;
  update public.battalion_members set role = 'commander' where user_id = p_user_id;
end; $$;
grant execute on function public.transfer_battalion_command(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Standings now carry the echelon.
-- ---------------------------------------------------------------------------
drop view if exists public.battalion_leaderboard;
create view public.battalion_leaderboard
with (security_invoker = on) as
select
  b.id, b.name, b.motto, b.created_at, b.echelon,
  e.name as echelon_name, e.member_cap,
  count(distinct m.user_id)::int as member_count,
  count(r.id)::int               as review_count
from public.battalions b
join public.battalion_echelons e on e.level = b.echelon
join public.battalion_members m on m.battalion_id = b.id
left join public.reviews r on r.author_id = m.user_id and r.deleted_at is null
group by b.id, b.name, b.motto, b.created_at, b.echelon, e.name, e.member_cap;

-- ---------------------------------------------------------------------------
-- 8. Fast-forward any units founded before the ladder existed.
-- ---------------------------------------------------------------------------
select public.try_promote_battalion(id) from public.battalions;
