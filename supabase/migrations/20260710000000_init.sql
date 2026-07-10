-- Watrloo: initial schema
-- Ratings for public bathrooms.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: public-facing identity, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique
             check (username ~ '^[a-zA-Z0-9_]{3,30}$'),
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bathrooms: the rated entity. Amenities are properties of the place, not of
-- any one review, so they live here rather than on `reviews`.
-- ---------------------------------------------------------------------------
create table public.bathrooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  address     text not null check (char_length(address) between 1 and 300),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  description text check (char_length(description) <= 2000),

  wheelchair_accessible boolean not null default false,
  gender_neutral        boolean not null default false,
  changing_table        boolean not null default false,
  requires_key          boolean not null default false,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index bathrooms_created_at_idx on public.bathrooms (created_at desc);
-- Supports the bounding-box query the map view issues on every pan.
create index bathrooms_lat_lng_idx on public.bathrooms (lat, lng);

-- ---------------------------------------------------------------------------
-- reviews: one per (bathroom, author). `rating` is required; the three
-- sub-scores are optional so a user can leave a quick overall rating.
-- ---------------------------------------------------------------------------
create table public.reviews (
  id            uuid primary key default gen_random_uuid(),
  bathroom_id   uuid not null references public.bathrooms (id) on delete cascade,
  author_id     uuid not null references public.profiles (id) on delete cascade,
  rating        smallint not null check (rating between 1 and 5),
  cleanliness   smallint check (cleanliness between 1 and 5),
  privacy       smallint check (privacy between 1 and 5),
  accessibility smallint check (accessibility between 1 and 5),
  body          text check (char_length(body) <= 4000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (bathroom_id, author_id)
);

create index reviews_bathroom_id_idx on public.reviews (bathroom_id, created_at desc);
create index reviews_author_id_idx on public.reviews (author_id);

-- ---------------------------------------------------------------------------
-- review_photos: storage_path points into the `review-photos` bucket.
-- ---------------------------------------------------------------------------
create table public.review_photos (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.reviews (id) on delete cascade,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index review_photos_review_id_idx on public.review_photos (review_id);

-- ---------------------------------------------------------------------------
-- Aggregates. security_invoker makes the view respect the querying user's RLS
-- rather than the view owner's, so it cannot be used to read around policies.
-- ---------------------------------------------------------------------------
create view public.bathroom_stats
with (security_invoker = on) as
select
  b.id                                          as bathroom_id,
  count(r.id)::int                              as review_count,
  round(avg(r.rating)::numeric, 2)              as avg_rating,
  round(avg(r.cleanliness)::numeric, 2)         as avg_cleanliness,
  round(avg(r.privacy)::numeric, 2)             as avg_privacy,
  round(avg(r.accessibility)::numeric, 2)       as avg_accessibility
from public.bathrooms b
left join public.reviews r on r.bathroom_id = b.id
group by b.id;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Mint a profile whenever an auth user is created. Username comes from
-- signup metadata, falling back to a derived, collision-resistant handle.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  desired text;
begin
  desired := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    split_part(new.email, '@', 1)
  );
  desired := regexp_replace(desired, '[^a-zA-Z0-9_]', '', 'g');
  if char_length(desired) < 3 then
    desired := 'user_' || substr(new.id::text, 1, 8);
  end if;
  desired := left(desired, 24);

  -- Suffix on collision rather than failing the signup transaction.
  if exists (select 1 from public.profiles p where p.username = desired) then
    desired := left(desired, 17) || '_' || substr(new.id::text, 1, 6);
  end if;

  insert into public.profiles (id, username) values (new.id, desired);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reviews_touch_updated_at
  before update on public.reviews
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Reads are public: this is a directory, anon users must be able to browse.
-- Writes are authenticated and scoped to the acting user.
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.bathrooms     enable row level security;
alter table public.reviews       enable row level security;
alter table public.review_photos enable row level security;

-- profiles
create policy "profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "users insert their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- bathrooms
create policy "bathrooms are viewable by everyone"
  on public.bathrooms for select using (true);

create policy "authenticated users add bathrooms"
  on public.bathrooms for insert to authenticated
  with check ((select auth.uid()) = created_by);

create policy "users update bathrooms they added"
  on public.bathrooms for update to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by);

-- reviews
create policy "reviews are viewable by everyone"
  on public.reviews for select using (true);

create policy "users write their own reviews"
  on public.reviews for insert to authenticated
  with check ((select auth.uid()) = author_id);

create policy "users update their own reviews"
  on public.reviews for update to authenticated
  using ((select auth.uid()) = author_id)
  with check ((select auth.uid()) = author_id);

create policy "users delete their own reviews"
  on public.reviews for delete to authenticated
  using ((select auth.uid()) = author_id);

-- review_photos: ownership is derived through the parent review.
create policy "review photos are viewable by everyone"
  on public.review_photos for select using (true);

create policy "users attach photos to their own reviews"
  on public.review_photos for insert to authenticated
  with check (
    exists (
      select 1 from public.reviews r
      where r.id = review_id and r.author_id = (select auth.uid())
    )
  );

create policy "users delete photos on their own reviews"
  on public.review_photos for delete to authenticated
  using (
    exists (
      select 1 from public.reviews r
      where r.id = review_id and r.author_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Storage: review photos. Public read, writes confined to a per-user prefix
-- (`<uid>/...`) so one user cannot overwrite another's objects.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'review-photos', 'review-photos', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do nothing;

create policy "review photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'review-photos');

create policy "users upload to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'review-photos'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "users delete from their own folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'review-photos'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
