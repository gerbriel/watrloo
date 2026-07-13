-- Watrloo: richer taxonomy, community-maintained tags, and the public
-- leaderboard ("Hall of Marshals").
--
-- 1. More options when adding a bathroom: a bathroom.app-inspired amenity set
--    and more venue categories (library, gym, grocery…). Pure seed data on the
--    existing attribute_defs taxonomy — admins can keep growing it from the
--    control room.
-- 2. Community tag upkeep: ANY signed-in user may toggle a single attribute
--    on a live bathroom, so listings stay current without waiting for the
--    creator. Same trust model as reviews (publish immediately, moderate
--    reactively) — every toggle is logged with who/what/when, and moderators
--    can read the trail. The replace-set RPC (set_bathroom_attributes) keeps
--    its stricter creator/manager/moderator gate: wholesale rewrites stay
--    privileged; single toggles are communal.
-- 3. leaderboard view: public reviewer standings for the rank ladder in
--    src/lib/ranks.ts. Usernames are already world-readable on every review;
--    this exposes nothing new. PII stays in profile_private, untouched.

-- ---------------------------------------------------------------------------
-- 1a. Amenities (existing sorts run 10–60; these continue from 70).
-- ---------------------------------------------------------------------------
insert into public.attribute_defs (slug, label, kind, description, sort) values
  ('toilet_seat_covers', 'Toilet seat covers',  'amenity', null, 70),
  ('full_length_mirror', 'Full-length mirror',  'amenity', null, 80),
  ('hand_sanitizer',     'Hand sanitizer',      'amenity', null, 90),
  ('water_fountain',     'Water fountain',      'amenity', null, 100),
  ('touchless',          'Touchless fixtures',  'amenity', 'Sensor taps, soap, or flush — minimal touching.', 110),
  ('coat_hook',          'Coat hook',           'amenity', null, 120),
  ('lotion',             'Lotion',              'amenity', null, 130),
  ('mouthwash',          'Mouthwash',           'amenity', null, 140),
  ('condoms',            'Condoms',             'amenity', null, 150),
  ('bidet',              'Bidet',               'amenity', null, 160),
  ('sharps_disposal',    'Sharps disposal',     'amenity', null, 170),
  ('facial_tissue',      'Facial tissue',       'amenity', null, 180)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 1b. Venue categories (existing sorts run 10–70; these continue from 80).
-- ---------------------------------------------------------------------------
insert into public.attribute_defs (slug, label, kind, description, sort) values
  ('library',         'Library',                'category', null, 80),
  ('gym_fitness',     'Gym / fitness',          'category', null, 90),
  ('grocery',         'Grocery store',          'category', null, 100),
  ('school_campus',   'School / campus',        'category', null, 110),
  ('hospital_clinic', 'Hospital / clinic',      'category', null, 120),
  ('bar_nightlife',   'Bar / nightlife',        'category', null, 130),
  ('office_building', 'Office building',        'category', null, 140),
  ('event_venue',     'Stadium / event venue',  'category', null, 150)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Community toggles, logged.
-- ---------------------------------------------------------------------------
create table if not exists public.attribute_edits (
  id             uuid primary key default gen_random_uuid(),
  bathroom_id    uuid not null references public.bathrooms (id) on delete cascade,
  user_id        uuid references public.profiles (id) on delete set null,
  attribute_slug text not null,
  added          boolean not null,
  created_at     timestamptz not null default now()
);
create index if not exists attribute_edits_bathroom_idx
  on public.attribute_edits (bathroom_id, created_at desc);

alter table public.attribute_edits enable row level security;
grant select on public.attribute_edits to authenticated;
drop policy if exists "moderators read the tag edit trail" on public.attribute_edits;
create policy "moderators read the tag edit trail"
  on public.attribute_edits for select to authenticated
  using ((select public.is_moderator()));
-- Writes: only through the RPC below.

-- One tag on, or one tag off, by any signed-in user. Logs only when state
-- actually changed, so a double-click doesn't fake an edit trail.
create or replace function public.toggle_bathroom_attribute(
  p_bathroom_id uuid, p_slug text, p_add boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.bathrooms b
                  where b.id = p_bathroom_id and b.deleted_at is null) then
    raise exception 'bathroom not found' using errcode = '22023';
  end if;
  if not exists (select 1 from public.attribute_defs d
                  where d.slug = p_slug and d.active) then
    raise exception 'unknown or inactive attribute' using errcode = '22023';
  end if;

  if p_add then
    insert into public.bathroom_attributes (bathroom_id, attribute_slug)
    values (p_bathroom_id, p_slug)
    on conflict do nothing;
  else
    delete from public.bathroom_attributes
     where bathroom_id = p_bathroom_id and attribute_slug = p_slug;
  end if;

  if found then
    insert into public.attribute_edits (bathroom_id, user_id, attribute_slug, added)
    values (p_bathroom_id, uid, p_slug, p_add);
  end if;
end;
$$;
grant execute on function public.toggle_bathroom_attribute(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Leaderboard. Inner join: only people with at least one live campaign
--    appear. security_invoker like every other view here.
-- ---------------------------------------------------------------------------
create view public.leaderboard
with (security_invoker = on) as
select
  p.id             as profile_id,
  p.username,
  p.avatar_url,
  count(r.id)::int as review_count
from public.profiles p
join public.reviews r
  on r.author_id = p.id and r.deleted_at is null
group by p.id, p.username, p.avatar_url;
