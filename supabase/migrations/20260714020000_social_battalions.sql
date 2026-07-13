-- Watrloo: the social layer — org-voiced moderator responses, emoji reactions,
-- follows, and battalions (team leaderboards for the Grande Armée du Trône).

-- ---------------------------------------------------------------------------
-- 1. Org-assigned moderators may respond to reviews AS the org.
--    The org voice comes from: business managers (as before), moderators
--    ASSIGNED to that org (scoped moderation, 20260714010000), or admins.
--    Direct bathroom assignment alone does NOT confer the org's voice.
-- ---------------------------------------------------------------------------
create or replace function public.business_respond_to_review(p_review_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bathroom uuid;
  v_business uuid;
begin
  select bathroom_id into v_bathroom from public.reviews where id = p_review_id;
  if v_bathroom is null then
    raise exception 'no such review' using errcode = 'P0002';
  end if;

  select c.business_id into v_business
  from public.bathroom_claims c
  where c.bathroom_id = v_bathroom and c.status = 'verified'
  limit 1;
  if v_business is null then
    raise exception 'no verified claim on this bathroom' using errcode = 'P0002';
  end if;

  if not (
    public.manages_bathroom(v_bathroom)
    or public.is_admin()
    or ((select public.is_moderator()) and exists (
          select 1 from public.moderator_org_assignments mo
          where mo.moderator_id = (select auth.uid())
            and mo.business_id = v_business))
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into public.review_responses (review_id, business_id, author_id, body)
  values (p_review_id, v_business, (select auth.uid()), p_body)
  on conflict (review_id)
  do update set body = excluded.body, author_id = excluded.author_id, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Emoji reactions on reviews. Fixed, themed vocabulary (a CHECK, so no
--    sanitization surface). One row per (review, user, emoji).
-- ---------------------------------------------------------------------------
create table if not exists public.review_reactions (
  review_id  uuid not null references public.reviews (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('👍','❤️','😂','😮','💩','🧻')),
  created_at timestamptz not null default now(),
  primary key (review_id, user_id, emoji)
);
create index if not exists review_reactions_review_idx on public.review_reactions (review_id);

alter table public.review_reactions enable row level security;
grant select, insert, delete on public.review_reactions to authenticated;
grant select on public.review_reactions to anon;

drop policy if exists "reactions are public" on public.review_reactions;
create policy "reactions are public" on public.review_reactions
  for select using (true);
drop policy if exists "users react as themselves" on public.review_reactions;
create policy "users react as themselves" on public.review_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.reviews r
                           where r.id = review_id and r.deleted_at is null));
drop policy if exists "users unreact their own" on public.review_reactions;
create policy "users unreact their own" on public.review_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Follows. Public social graph, self-managed rows only.
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

alter table public.follows enable row level security;
grant select, insert, delete on public.follows to authenticated;
grant select on public.follows to anon;

drop policy if exists "follows are public" on public.follows;
create policy "follows are public" on public.follows
  for select using (true);
drop policy if exists "users follow as themselves" on public.follows;
create policy "users follow as themselves" on public.follows
  for insert to authenticated with check (follower_id = (select auth.uid()));
drop policy if exists "users unfollow their own" on public.follows;
create policy "users unfollow their own" on public.follows
  for delete to authenticated using (follower_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Battalions: one squad per soldier, team totals on the leaderboard.
--    Membership writes go through RPCs so the invariants (one battalion per
--    user, leadership succession, empty battalions dissolve) hold.
-- ---------------------------------------------------------------------------
create table if not exists public.battalions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique
             check (name ~ '^[A-Za-z0-9][A-Za-z0-9 ''!-]{2,39}$'),
  motto      text check (char_length(motto) <= 120),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.battalion_members (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  battalion_id uuid not null references public.battalions (id) on delete cascade,
  role         text not null default 'member' check (role in ('leader','member')),
  joined_at    timestamptz not null default now()
);
create index if not exists battalion_members_battalion_idx
  on public.battalion_members (battalion_id);

alter table public.battalions enable row level security;
alter table public.battalion_members enable row level security;
grant select on public.battalions, public.battalion_members to anon, authenticated;

drop policy if exists "battalions are public" on public.battalions;
create policy "battalions are public" on public.battalions for select using (true);
drop policy if exists "battalion rosters are public" on public.battalion_members;
create policy "battalion rosters are public" on public.battalion_members
  for select using (true);
-- Writes: RPC only.

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
  values (uid, v_id, 'leader');
  return v_id;
end; $$;
grant execute on function public.create_battalion(text, text) to authenticated;

create or replace function public.join_battalion(p_battalion_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
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
  insert into public.battalion_members (user_id, battalion_id, role)
  values (uid, p_battalion_id, 'member');
end; $$;
grant execute on function public.join_battalion(uuid) to authenticated;

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
  if v_battalion is null then
    return;
  end if;

  delete from public.battalion_members where user_id = uid;

  if not exists (select 1 from public.battalion_members m
                  where m.battalion_id = v_battalion) then
    -- Last soldier out dissolves the battalion.
    delete from public.battalions where id = v_battalion;
  elsif v_role = 'leader' then
    -- Leadership passes to the longest-serving member.
    select user_id into v_next from public.battalion_members
     where battalion_id = v_battalion order by joined_at limit 1;
    update public.battalion_members set role = 'leader' where user_id = v_next;
  end if;
end; $$;
grant execute on function public.leave_battalion() to authenticated;

-- Team standings: total live reviews across the roster, biggest army first.
create view public.battalion_leaderboard
with (security_invoker = on) as
select
  b.id, b.name, b.motto, b.created_at,
  count(distinct m.user_id)::int as member_count,
  count(r.id)::int               as review_count
from public.battalions b
join public.battalion_members m on m.battalion_id = b.id
left join public.reviews r on r.author_id = m.user_id and r.deleted_at is null
group by b.id, b.name, b.motto, b.created_at;
