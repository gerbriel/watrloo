-- Watrloo: named details and seconds-in-command — the officer's detail grows
-- from an anonymous grouping into a real sub-unit. Officers (or the
-- commander) can NAME the detail, appoint one qualified soldier in it as
-- SECOND-IN-COMMAND (the tree gains a third level), and soldiers can be moved
-- between details: the commander moves anyone; an officer may claim
-- unassigned soldiers into their own detail and release their own back to
-- the commander's pool. Poaching from another officer stays a commander move.

alter table public.battalion_members
  add column if not exists detail_name text
    check (detail_name is null or char_length(detail_name) between 2 and 40),
  add column if not exists is_second boolean not null default false;

alter table public.battalion_members
  drop constraint if exists battalion_members_second_in_detail;
alter table public.battalion_members
  add constraint battalion_members_second_in_detail
  check (not (is_second and reports_to is null));

create unique index if not exists battalion_members_one_second_per_detail
  on public.battalion_members (battalion_id, reports_to) where is_second;

-- ---------------------------------------------------------------------------
-- Naming a detail: the commander, or the officer who leads it.
-- ---------------------------------------------------------------------------
create or replace function public.name_battalion_detail(p_officer_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_caller_role text;
  v_officer_role text;
  v_clean text;
begin
  select battalion_id, role into v_unit, v_caller_role
    from public.battalion_members
   where user_id = uid and role in ('commander', 'officer');
  if v_unit is null then
    raise exception 'only the commander or the detail''s officer can name it'
      using errcode = '42501';
  end if;
  if v_caller_role <> 'commander' and uid <> p_officer_id then
    raise exception 'only the commander or the detail''s officer can name it'
      using errcode = '42501';
  end if;
  select role into v_officer_role from public.battalion_members
   where user_id = p_officer_id and battalion_id = v_unit;
  if v_officer_role is distinct from 'officer' then
    raise exception 'details belong to officers — appoint one first';
  end if;
  v_clean := nullif(btrim(coalesce(p_name, '')), '');
  if v_clean is not null and v_clean !~ '^[[:alnum:]][[:alnum:] ''!-]{1,39}$' then
    raise exception 'detail names are 2–40 characters: letters, numbers, spaces, apostrophes, hyphens and exclamation points';
  end if;
  update public.battalion_members
     set detail_name = v_clean
   where user_id = p_officer_id;
end; $$;
grant execute on function public.name_battalion_detail(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Seconds-in-command: one per detail, appointed by its officer or the
-- commander, and the post must be earned — the bar is the officer bar of the
-- echelon below (a Private can second a Squad detail).
-- ---------------------------------------------------------------------------
create or replace function public.set_detail_second(p_user_id uuid, p_second boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_caller_role text;
  v_target_role text;
  v_target_reports uuid;
  v_level int;
  v_need int;
  v_have int;
begin
  select battalion_id, role into v_unit, v_caller_role
    from public.battalion_members
   where user_id = uid and role in ('commander', 'officer');
  if v_unit is null then
    raise exception 'only the commander or the detail''s officer can appoint a second'
      using errcode = '42501';
  end if;
  select role, reports_to into v_target_role, v_target_reports
    from public.battalion_members
   where user_id = p_user_id and battalion_id = v_unit;
  if v_target_role is null then
    raise exception 'that soldier is not in your unit' using errcode = 'P0002';
  end if;
  if v_target_role <> 'member' or v_target_reports is null then
    raise exception 'seconds are appointed from the soldiers of a detail';
  end if;
  if v_caller_role = 'officer' and v_target_reports <> uid then
    raise exception 'that soldier serves in another officer''s detail'
      using errcode = '42501';
  end if;
  if p_second then
    select echelon into v_level from public.battalions where id = v_unit;
    if v_level <= 1 then
      v_need := 1;
    else
      select officer_min_reviews into v_need
        from public.battalion_echelons where level = v_level - 1;
    end if;
    v_have := public.live_review_count(p_user_id);
    if v_have < v_need then
      raise exception 'not qualified: a second takes % campaigns and that soldier has %',
        v_need, v_have;
    end if;
    if exists (select 1 from public.battalion_members
                where battalion_id = v_unit and reports_to = v_target_reports
                  and is_second and user_id <> p_user_id) then
      raise exception 'that detail already has a second-in-command';
    end if;
  end if;
  update public.battalion_members
     set is_second = p_second
   where user_id = p_user_id;
end; $$;
grant execute on function public.set_detail_second(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Moving soldiers: commander moves anyone; officers claim unassigned soldiers
-- into their own detail or release their own back to the commander's pool.
-- Any move clears the second post. (Full replacement from 20260714050000.)
-- ---------------------------------------------------------------------------
create or replace function public.assign_battalion_report(p_user_id uuid, p_officer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_unit uuid;
  v_caller_role text;
  v_target_role text;
  v_target_reports uuid;
  v_officer_role text;
begin
  select battalion_id, role into v_unit, v_caller_role
    from public.battalion_members
   where user_id = uid and role in ('commander', 'officer');
  if v_unit is null then
    raise exception 'only the commander or an officer can shape the chain of command'
      using errcode = '42501';
  end if;
  select role, reports_to into v_target_role, v_target_reports
    from public.battalion_members
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
  if v_caller_role = 'officer' then
    if not (   (v_target_reports = uid and p_officer_id is null)
            or (v_target_reports is null and p_officer_id = uid)) then
      raise exception 'officers may claim unassigned soldiers or release their own — transfers between details are the commander''s call'
        using errcode = '42501';
    end if;
  end if;
  update public.battalion_members
     set reports_to = p_officer_id,
         is_second = false
   where user_id = p_user_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Role changes and departures tidy the new columns.
-- (Full replacements of the 20260714050000 versions.)
-- ---------------------------------------------------------------------------
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
         reports_to = null,
         is_second = false,
         detail_name = null
   where user_id = p_user_id;
  if not p_officer then
    update public.battalion_members
       set reports_to = null, is_second = false
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
  update public.battalion_members set role = 'officer' where user_id = uid;
  update public.battalion_members
     set role = 'commander', reports_to = null, is_second = false, detail_name = null
   where user_id = p_user_id;
  update public.battalion_members
     set reports_to = null, is_second = false
   where battalion_id = v_unit and reports_to = p_user_id;
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

  update public.battalion_members
     set reports_to = null, is_second = false
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
       set role = 'commander', reports_to = null, is_second = false, detail_name = null
     where user_id = v_next;
  end if;
end; $$;
