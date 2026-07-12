-- Watrloo: the bathroom ownership model, enforced.
--
-- Adding a bathroom is a CONTRIBUTION through a regular account — it never
-- confers ownership. Ownership (managing the listing's facts, responding as
-- the venue) comes only through a business account claiming the bathroom
-- (verified by an admin), or through platform moderators. This drops the
-- founder-era policy that let creators keep editing bathrooms they added.
--
-- What creators keep: credit (created_by), appeal rights if their
-- contribution is removed, and a short window to finish tagging attributes
-- as part of the add-a-bathroom flow itself.

-- 1. Creators no longer edit bathroom facts. (Moderators and verified
--    claiming businesses keep their paths: the "moderators update any
--    bathroom" policy and the business_update_listing RPC.)
drop policy if exists "users update bathrooms they added" on public.bathrooms;

-- 2. Attribute tagging: the creator may set attributes only within an hour
--    of creating the bathroom (the add flow), after which it's business
--    managers and moderators only.
create or replace function public.set_bathroom_attributes(p_bathroom_id uuid, p_slugs text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not (
    exists (select 1 from public.bathrooms b
             where b.id = p_bathroom_id and b.created_by = uid
               and b.created_at > now() - interval '1 hour')
    or public.is_moderator()
    or public.manages_bathroom(p_bathroom_id)
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_slugs, '{}')) s
    where not exists (select 1 from public.attribute_defs d
                       where d.slug = s and d.active)
  ) then
    raise exception 'unknown or inactive attribute' using errcode = '22023';
  end if;

  delete from public.bathroom_attributes
   where bathroom_id = p_bathroom_id
     and attribute_slug <> all (coalesce(p_slugs, '{}'));
  insert into public.bathroom_attributes (bathroom_id, attribute_slug)
  select p_bathroom_id, s from unnest(coalesce(p_slugs, '{}')) s
  on conflict do nothing;
end; $$;
