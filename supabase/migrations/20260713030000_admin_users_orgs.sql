-- Watrloo: Manage Users + Manage Orgs consoles, and bathroom categories.
--
-- * admin_list_users(): one server-side search powering a live-as-you-type
--   directory — username substring match (trigram-indexed), filterable by
--   platform role and by business/org membership. Needed as an RPC because
--   RLS deliberately hides other people's user_roles and business rosters
--   from everyone but the parties involved; the admin view escalates through
--   an is_admin-gated SECURITY DEFINER instead of loosening those policies.
-- * admin_list_businesses(): the org directory with membership/claims/
--   campaign/subscription rollups, plus an admin path to edit org profiles.
-- * attribute_defs gains kind='category' — "group up bathrooms and categorize
--   them" reuses the existing taxonomy + bathroom_attributes join instead of
--   a parallel system.

-- ---------------------------------------------------------------------------
-- 1. Categories: third taxonomy kind + starter set + live-search index.
-- ---------------------------------------------------------------------------
alter table public.attribute_defs drop constraint if exists attribute_defs_kind_check;
alter table public.attribute_defs add constraint attribute_defs_kind_check
  check (kind in ('amenity', 'caution', 'category'));

insert into public.attribute_defs (slug, label, kind, description, sort) values
  ('park',            'Park',              'category', null, 10),
  ('gas_station',     'Gas station',       'category', null, 20),
  ('cafe_restaurant', 'Cafe / restaurant', 'category', null, 30),
  ('retail',          'Retail / mall',     'category', null, 40),
  ('transit',         'Transit / station', 'category', null, 50),
  ('public_building', 'Public building',   'category', null, 60),
  ('hotel_lobby',     'Hotel lobby',       'category', null, 70)
on conflict (slug) do nothing;

-- Live username search needs substring matching; pg_trgm is already installed.
create index if not exists profiles_username_trgm_idx
  on public.profiles using gin (username extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. The user directory RPC.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users(
  p_search      text default null,
  p_role        text default null,   -- 'admin' | 'moderator' | 'business' | 'none' | null
  p_business_id uuid default null,
  p_limit       int default 50,
  p_offset      int default 0
)
returns table (
  user_id uuid, username text, avatar_url text, created_at timestamptz,
  roles text[], businesses jsonb, review_count int, removed_reviews int
)
language sql stable security definer set search_path = '' as $$
  select
    p.id, p.username, p.avatar_url, p.created_at,
    coalesce((select array_agg(ur.role::text order by ur.role)
              from public.user_roles ur where ur.user_id = p.id), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object(
                'id', b.id, 'name', b.name, 'role', bm.role) order by b.name)
              from public.business_members bm
              join public.businesses b on b.id = bm.business_id
              where bm.user_id = p.id), '[]'::jsonb),
    (select count(*)::int from public.reviews r
      where r.author_id = p.id and r.deleted_at is null),
    (select count(*)::int from public.reviews r
      where r.author_id = p.id and r.deleted_at is not null)
  from public.profiles p
  where public.is_admin()
    and (p_search is null or btrim(p_search) = ''
         or p.username ilike '%' || replace(replace(btrim(p_search), '%', '\%'), '_', '\_') || '%' escape '\')
    and (p_business_id is null or exists (
          select 1 from public.business_members bm
          where bm.user_id = p.id and bm.business_id = p_business_id))
    and (p_role is null
         or (p_role = 'admin' and exists (
              select 1 from public.user_roles ur
              where ur.user_id = p.id and ur.role = 'admin'))
         or (p_role = 'moderator' and exists (
              select 1 from public.user_roles ur
              where ur.user_id = p.id and ur.role = 'moderator'))
         or (p_role = 'business' and exists (
              select 1 from public.business_members bm where bm.user_id = p.id))
         or (p_role = 'none' and not exists (
              select 1 from public.user_roles ur where ur.user_id = p.id)
             and not exists (
              select 1 from public.business_members bm where bm.user_id = p.id)))
  order by p.created_at desc
  limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset);
$$;
grant execute on function public.admin_list_users(text, text, uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The org directory RPC + admin edit path for org profiles.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_businesses(p_search text default null)
returns table (
  id uuid, name text, slug text, website text, logo_url text,
  created_at timestamptz, suspended_at timestamptz,
  owner_username text, subscription_status text, subscription_plan text,
  member_count int, verified_claims int, pending_claims int,
  campaign_count int, open_reports int
)
language sql stable security definer set search_path = '' as $$
  select
    b.id, b.name, b.slug, b.website, b.logo_url, b.created_at, b.suspended_at,
    (select pr.username from public.profiles pr where pr.id = b.owner_id),
    s.status, s.plan,
    (select count(*)::int from public.business_members bm where bm.business_id = b.id),
    (select count(*)::int from public.bathroom_claims c
      where c.business_id = b.id and c.status = 'verified'),
    (select count(*)::int from public.bathroom_claims c
      where c.business_id = b.id and c.status = 'pending'),
    (select count(*)::int from public.ad_campaigns ac where ac.business_id = b.id),
    (select count(*)::int from public.reports r
      join public.ad_campaigns ac on ac.id = r.ad_campaign_id
      where ac.business_id = b.id and r.status = 'open')
  from public.businesses b
  left join public.subscriptions s on s.business_id = b.id
  where public.is_admin()
    and (p_search is null or btrim(p_search) = ''
         or b.name ilike '%' || replace(replace(btrim(p_search), '%', '\%'), '_', '\_') || '%' escape '\')
  order by b.created_at desc;
$$;
grant execute on function public.admin_list_businesses(text) to authenticated;

-- Admins may correct any org profile (managers keep their own access).
drop policy if exists "managers update their business" on public.businesses;
create policy "managers update their business"
  on public.businesses for update to authenticated
  using ((select public.is_business_manager(id)) or (select public.is_admin()))
  with check ((select public.is_business_manager(id)) or (select public.is_admin()));
