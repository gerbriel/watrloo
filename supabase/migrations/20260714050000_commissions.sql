-- Watrloo: commissions — the personal ladder and the unit ladder become one
-- economy. Officer posts and command of a unit now require the candidate to
-- have EARNED the equivalent personal rank (live reviews). The founder still
-- commands their own squad unconditionally (founding isn't gated), and earned
-- posts are never revoked by later promotions — but every NEW appointment
-- checks the bar for the unit's current echelon.
--
-- The bars sync 1:1 with the PERSONAL rank ladder in src/lib/ranks.ts: reach
-- a punny rank on your own and you're eligible for the matching unit post.
-- Reach Loo-tenant (15) → eligible to command a Platoon (Second Lieutenant).
-- An officer post at echelon L is the command post of echelon L-1, so
-- officer_min_reviews(L) = commander_min_reviews(L-1) all the way down.
-- Beyond Emperor (100) the last three bars are endgame staff posts with no
-- personal-ladder twin.

alter table public.battalion_echelons
  add column if not exists officer_min_reviews int not null default 0,
  add column if not exists commander_min_reviews int not null default 0;

update public.battalion_echelons as e
   set officer_min_reviews = v.o, commander_min_reviews = v.c
  from (values
    (1, 3,   7),   -- Squad:      officer = The Little Corporal(3),   command = Sergeant-at-Latrines(7)
    (2, 7,   15),  -- Platoon:    officer = Sergeant-at-Latrines(7),  command = Loo-tenant(15)
    (3, 15,  30),  -- Company:    officer = Loo-tenant(15),           command = Commode-ant(30)
    (4, 30,  50),  -- Battalion:  officer = Commode-ant(30),          command = Flush Marshal(50)
    (5, 50,  100), -- Brigade:    officer = Flush Marshal(50),        command = Emperor of the Throne(100)
    (6, 100, 150), -- Division:   officer = Emperor(100),             command = 150
    (7, 150, 250), -- Corps:      officer = 150,                      command = 250
    (8, 250, 400)  -- Field Army: officer = 250,                      command = 400
  ) as v(level, o, c)
 where e.level = v.level;

create or replace function public.live_review_count(p_user_id uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select count(*)::int from public.reviews r
   where r.author_id = p_user_id and r.deleted_at is null;
$$;

create or replace function public.set_battalion_officer(p_user_id uuid, p_officer boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_level int;
  v_officers int;
  v_target_role text;
  v_need int;
  v_have int;
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
    select officer_min_reviews into v_need
      from public.battalion_echelons where level = v_level;
    v_have := public.live_review_count(p_user_id);
    if v_have < v_need then
      raise exception 'not qualified: this post takes % campaigns and that soldier has %',
        v_need, v_have;
    end if;
  end if;
  update public.battalion_members
     set role = case when p_officer then 'officer' else 'member' end,
         -- an officer answers to the commander directly; a dismissed officer
         -- loses their detail (their soldiers revert to the commander)
         reports_to = null
   where user_id = p_user_id;
  if not p_officer then
    update public.battalion_members
       set reports_to = null
     where battalion_id = v_unit and reports_to = p_user_id;
  end if;
end; $$;

create or replace function public.transfer_battalion_command(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_level int;
  v_need int;
  v_have int;
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
  select echelon into v_level from public.battalions where id = v_unit for update;
  select commander_min_reviews into v_need
    from public.battalion_echelons where level = v_level;
  v_have := public.live_review_count(p_user_id);
  if v_have < v_need then
    raise exception 'not qualified: command takes % campaigns and that soldier has %',
      v_need, v_have;
  end if;
  update public.battalion_members set role = 'officer'   where user_id = uid;
  update public.battalion_members
     set role = 'commander', reports_to = null
   where user_id = p_user_id;
  -- soldiers who reported to the new commander now report to the top anyway
  update public.battalion_members
     set reports_to = null
   where battalion_id = v_unit and reports_to = p_user_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Chain of command: soldiers can be assigned to an officer's detail, forming
-- the tree (commander → officers → their soldiers → unassigned soldiers
-- report to the commander directly). Everyone can SEE the tree; only the
-- commander shapes it.
-- ---------------------------------------------------------------------------
alter table public.battalion_members
  add column if not exists reports_to uuid references public.profiles (id);

create or replace function public.assign_battalion_report(p_user_id uuid, p_officer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_target_role text;
  v_officer_role text;
begin
  select battalion_id into v_unit from public.battalion_members
   where user_id = uid and role = 'commander';
  if v_unit is null then
    raise exception 'only the commanding officer can shape the chain of command'
      using errcode = '42501';
  end if;
  select role into v_target_role from public.battalion_members
   where user_id = p_user_id and battalion_id = v_unit;
  if v_target_role is null then
    raise exception 'that soldier is not in your unit' using errcode = 'P0002';
  end if;
  if v_target_role <> 'member' then
    raise exception 'only soldiers can be assigned to a detail — officers answer to the commander';
  end if;
  if p_officer_id is not null then
    select role into v_officer_role from public.battalion_members
     where user_id = p_officer_id and battalion_id = v_unit;
    if v_officer_role is null or v_officer_role <> 'officer' then
      raise exception 'details are led by officers — appoint one first';
    end if;
  end if;
  update public.battalion_members
     set reports_to = p_officer_id
   where user_id = p_user_id;
end; $$;
grant execute on function public.assign_battalion_report(uuid, uuid) to authenticated;

-- Departures tidy the tree: anyone reporting to the leaver reverts to the
-- commander. (Full replacement of leave_battalion from 20260714040000.)
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

  update public.battalion_members
     set reports_to = null
   where battalion_id = v_battalion and reports_to = uid;

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
    update public.battalion_members
       set role = 'commander', reports_to = null
     where user_id = v_next;
  end if;
end; $$;
