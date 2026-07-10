-- Watrloo: indexed fuzzy search, spatial duplicate detection, and a privacy fix.

-- Supabase convention: extensions live in their own schema, not `public`.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Privacy fix.
--
-- The original trigger fell back to the email local-part when no username was
-- supplied. `profiles` is world-readable, so that published a piece of every
-- user's email address to anyone who asked. Fall back to an opaque handle.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  desired text;
  attempts int := 0;
begin
  -- Idempotence: never fail a signup because a profile somehow already exists.
  if exists (select 1 from public.profiles p where p.id = new.id) then
    return new;
  end if;

  -- `coalesce` first: a NULL email or NULL metadata would make `char_length`
  -- return NULL, and `NULL < 3` is not TRUE, so the guard below would be skipped.
  desired := regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-zA-Z0-9_]', '', 'g'
  );

  -- No usable username supplied: mint an opaque one. Never derive it from the
  -- email address.
  if char_length(desired) < 3 then
    desired := 'user_' || encode(extensions.gen_random_bytes(5), 'hex');
  end if;
  desired := left(desired, 24);

  -- Insert-and-retry, not check-then-insert: under READ COMMITTED, two
  -- concurrent signups both pass an `exists` check and one then aborts the
  -- whole signup transaction. Catching the unique violation is race-free.
  loop
    begin
      insert into public.profiles (id, username) values (new.id, desired);
      return new;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 5 then raise; end if;
      desired := left(desired, 17) || '_' || encode(extensions.gen_random_bytes(3), 'hex');
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Indexed fuzzy search.
--
-- `name ilike '%term%'` cannot use a btree index and is typo-intolerant. A GIN
-- trigram index makes the leading-wildcard ILIKE indexable and lets us rank by
-- similarity instead of returning matches in arbitrary order.
-- ---------------------------------------------------------------------------
create index if not exists bathrooms_name_trgm_idx
  on public.bathrooms using gin (name extensions.gin_trgm_ops);
create index if not exists bathrooms_address_trgm_idx
  on public.bathrooms using gin (address extensions.gin_trgm_ops);

/**
 * Ranked search over name + address.
 *
 * SECURITY INVOKER (the default for `language sql`) so the caller's RLS still
 * applies — this function must not become a way to read around policies.
 *
 * Taking the term as a bound parameter also removes the PostgREST `.or()` filter
 * string the client used to build by hand, which is one less injection surface.
 */
create or replace function public.search_bathrooms(
  q text default null,
  lim int default 50,
  off int default 0
)
returns setof public.bathrooms
language sql
stable
set search_path = ''
as $$
  with params as (
    -- Clamp the term: an unbounded string of `%` is a cheap way to burn CPU.
    select nullif(btrim(left(coalesce(q, ''), 100)), '') as term
  ),
  pattern as (
    select
      term,
      case
        when term is null then null
        -- Neutralize LIKE metacharacters so a term of `%` matches a literal
        -- percent sign rather than every row. Backslash first, or we escape
        -- our own escapes.
        else '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as pat
    from params
  )
  select b.*
  from public.bathrooms b, pattern p
  where
    p.term is null
    or b.name ilike p.pat escape '\'
    or b.address ilike p.pat escape '\'
  order by
    case
      when p.term is null then 0
      else greatest(
        extensions.similarity(b.name, p.term),
        extensions.similarity(b.address, p.term)
      )
    end desc,
    b.created_at desc
  limit greatest(0, least(lim, 200))
  offset greatest(0, off);
$$;

-- ---------------------------------------------------------------------------
-- 3. Spatial duplicate detection.
--
-- Two users adding the same bathroom is the most likely data-quality failure.
-- A generated geography column keeps the point in sync with lat/lng with no
-- application code, and a GiST index makes the radius query cheap. The existing
-- btree (lat, lng) can only range-scan on its leading column, so it is weak for
-- 2-D proximity; this replaces that access path for the "is it a dupe" question.
-- ---------------------------------------------------------------------------
alter table public.bathrooms
  add column if not exists geog extensions.geography(Point, 4326)
  generated always as (
    extensions.st_setsrid(extensions.st_point(lng, lat), 4326)::extensions.geography
  ) stored;

create index if not exists bathrooms_geog_idx
  on public.bathrooms using gist (geog);

/** Bathrooms within `p_meters` of a point, nearest first. Used to warn before insert. */
create or replace function public.nearby_bathrooms(
  p_lat double precision,
  p_lng double precision,
  p_meters double precision default 40
)
returns setof public.bathrooms
language sql
stable
set search_path = ''
as $$
  select b.*
  from public.bathrooms b
  where extensions.st_dwithin(
    b.geog,
    extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography,
    greatest(1, least(p_meters, 1000))
  )
  -- `st_dwithin` has already narrowed this to a handful of rows via the GiST
  -- index, so an exact distance sort is cheap. (The `<->` KNN operator would
  -- need `OPERATOR(extensions.<->)` spelled out under `search_path = ''`.)
  order by extensions.st_distance(
    b.geog,
    extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography
  )
  limit 5;
$$;

-- ---------------------------------------------------------------------------
-- 4. Constrain review_photos.storage_path.
--
-- The insert policy checked only that you owned the parent review. But
-- `storage_path` is free text, so you could attach any object in the (public)
-- bucket to your own review — including someone else's photo. Storage RLS
-- already confines uploads to `<uid>/`, so require the row to agree with that.
-- ---------------------------------------------------------------------------
drop policy if exists "users attach photos to their own reviews" on public.review_photos;

create policy "users attach photos to their own reviews"
  on public.review_photos for insert to authenticated
  with check (
    exists (
      select 1 from public.reviews r
      where r.id = review_id and r.author_id = (select auth.uid())
    )
    and storage_path like ((select auth.uid())::text || '/%')
  );

grant execute on function public.search_bathrooms(text, int, int) to anon, authenticated;
grant execute on function public.nearby_bathrooms(double precision, double precision, double precision) to anon, authenticated;
