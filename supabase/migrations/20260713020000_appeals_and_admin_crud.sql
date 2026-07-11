-- Watrloo: appeals process + owner-visible removal reasons + admin hard delete.
--
-- Moderation so far is one-directional: a moderator removes content and the
-- owner can't even see that it happened (the visibility RLS hides removed rows
-- from everyone but moderators). This adds the other direction:
--   * my_removed_content(): owners see their own removed reviews/bathrooms
--     WITH the moderator's removal reason (pulled from the audit log).
--   * appeals: the owner files one appeal per removed item; an admin grants
--     (content restored) or denies (with a note the owner can read).
--   * admin_hard_delete_bathroom(): the permanent variant, admin-only and
--     audited. The photo BYTES must be removed by the client first (SQL can't
--     reach storage) — same ordering lesson as deleteReview.

-- ---------------------------------------------------------------------------
-- 1. Audit vocabulary (FULL list — see the 20260713010000 header for why).
-- ---------------------------------------------------------------------------
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'delete_review_photo',
    'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'stop_campaign',
    'suspend_business', 'unsuspend_business', 'dispatch_blast',
    'set_growth_setting', 'update_placement',
    'grant_appeal', 'deny_appeal', 'hard_delete_bathroom',  -- new
    'upsert_attribute'                                      -- new (taxonomy)
  ));

alter table public.moderation_actions drop constraint if exists moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in (
    'review', 'bathroom', 'report', 'profile', 'photo',
    'business', 'campaign', 'setting', 'placement',
    'appeal', 'attribute'                                    -- new
  ));

-- ---------------------------------------------------------------------------
-- 2. Appeals. One per removed item; write paths are RPC-only.
-- ---------------------------------------------------------------------------
create table if not exists public.appeals (
  id            uuid primary key default gen_random_uuid(),
  appellant_id  uuid not null references public.profiles (id) on delete cascade,
  review_id     uuid references public.reviews (id) on delete cascade,
  bathroom_id   uuid references public.bathrooms (id) on delete cascade,
  reason        text not null check (char_length(reason) between 1 and 2000),
  status        text not null default 'open' check (status in ('open','granted','denied')),
  decided_by    uuid references public.profiles (id) on delete set null,
  decision_note text check (char_length(decision_note) <= 2000),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  check ((review_id is not null)::int + (bathroom_id is not null)::int = 1)
);
create index if not exists appeals_open_idx on public.appeals (created_at desc) where status = 'open';

alter table public.appeals enable row level security;
grant select on public.appeals to authenticated;
drop policy if exists "appellant reads own appeals or moderators all" on public.appeals;
create policy "appellant reads own appeals or moderators all"
  on public.appeals for select to authenticated
  using (appellant_id = (select auth.uid()) or (select public.is_moderator()));
-- No insert/update policy: file_appeal / admin_decide_appeal only.

-- ---------------------------------------------------------------------------
-- 3. File an appeal: owner-only, target must actually be removed, one open
--    appeal per target, reason sanitized client-side and length-capped here.
-- ---------------------------------------------------------------------------
create or replace function public.file_appeal(
  p_review_id uuid default null, p_bathroom_id uuid default null, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if (p_review_id is null) = (p_bathroom_id is null) then
    raise exception 'appeal exactly one item' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 1 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  if p_review_id is not null then
    if not exists (select 1 from public.reviews r
                    where r.id = p_review_id and r.author_id = uid
                      and r.deleted_at is not null) then
      raise exception 'not your removed review' using errcode = '42501';
    end if;
    if exists (select 1 from public.appeals a
                where a.review_id = p_review_id and a.status = 'open') then
      raise exception 'an appeal is already open for this item' using errcode = '23505';
    end if;
  else
    if not exists (select 1 from public.bathrooms b
                    where b.id = p_bathroom_id and b.created_by = uid
                      and b.deleted_at is not null) then
      raise exception 'not your removed bathroom' using errcode = '42501';
    end if;
    if exists (select 1 from public.appeals a
                where a.bathroom_id = p_bathroom_id and a.status = 'open') then
      raise exception 'an appeal is already open for this item' using errcode = '23505';
    end if;
  end if;

  insert into public.appeals (appellant_id, review_id, bathroom_id, reason)
  values (uid, p_review_id, p_bathroom_id, left(btrim(p_reason), 2000))
  returning id into v_id;
  return v_id;
end; $$;
grant execute on function public.file_appeal(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Owner's view of their own removed content, with the removal reason from
--    the audit log and any appeal state. RPC (not a policy change) so removed
--    rows never leak back into normal list queries.
-- ---------------------------------------------------------------------------
create or replace function public.my_removed_content()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'body', r.body, 'rating', r.rating,
        'bathroom_id', r.bathroom_id, 'bathroom_name', b.name,
        'deleted_at', r.deleted_at,
        'removal_reason', (
          select ma.detail ->> 'reason' from public.moderation_actions ma
          where ma.action = 'soft_delete_review' and ma.target_id = r.id
          order by ma.created_at desc limit 1),
        'appeal', (
          select jsonb_build_object('status', a.status, 'decision_note', a.decision_note,
                                    'created_at', a.created_at)
          from public.appeals a where a.review_id = r.id
          order by a.created_at desc limit 1)
      ) order by r.deleted_at desc)
      from public.reviews r
      join public.bathrooms b on b.id = r.bathroom_id
      where r.author_id = uid and r.deleted_at is not null), '[]'::jsonb),
    'bathrooms', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'address', b.address,
        'deleted_at', b.deleted_at,
        'removal_reason', (
          select ma.detail ->> 'reason' from public.moderation_actions ma
          where ma.action = 'soft_delete_bathroom' and ma.target_id = b.id
          order by ma.created_at desc limit 1),
        'appeal', (
          select jsonb_build_object('status', a.status, 'decision_note', a.decision_note,
                                    'created_at', a.created_at)
          from public.appeals a where a.bathroom_id = b.id
          order by a.created_at desc limit 1)
      ) order by b.deleted_at desc)
      from public.bathrooms b
      where b.created_by = uid and b.deleted_at is not null), '[]'::jsonb)
  );
end; $$;
grant execute on function public.my_removed_content() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Decide an appeal. Admin-only (an appeal overturns a moderator, so it
--    escalates one tier). Granting restores the content in the same
--    transaction; both paths are audited with the decision note.
-- ---------------------------------------------------------------------------
create or replace function public.admin_decide_appeal(
  p_appeal_id uuid, p_grant boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.appeals;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into a from public.appeals where id = p_appeal_id and status = 'open';
  if a.id is null then
    raise exception 'appeal not open' using errcode = 'P0002';
  end if;

  if p_grant then
    if a.review_id is not null then
      update public.reviews set deleted_at = null, deleted_by = null where id = a.review_id;
      insert into public.moderation_actions (actor_id, action, target_type, target_id)
      values ((select auth.uid()), 'restore_review', 'review', a.review_id);
    else
      update public.bathrooms set deleted_at = null, deleted_by = null where id = a.bathroom_id;
      insert into public.moderation_actions (actor_id, action, target_type, target_id)
      values ((select auth.uid()), 'restore_bathroom', 'bathroom', a.bathroom_id);
    end if;
  end if;

  update public.appeals
     set status = case when p_grant then 'granted' else 'denied' end,
         decided_by = (select auth.uid()),
         decision_note = nullif(left(btrim(coalesce(p_note, '')), 2000), ''),
         decided_at = now()
   where id = p_appeal_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case when p_grant then 'grant_appeal' else 'deny_appeal' end,
          'appeal', p_appeal_id,
          jsonb_build_object('note', p_note,
                             'review_id', a.review_id, 'bathroom_id', a.bathroom_id));
end; $$;
grant execute on function public.admin_decide_appeal(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Admin hard delete (permanent). The client MUST remove the review-photo
--    storage objects first — deleting rows first would strand the bytes at
--    public URLs forever. Cascades take reviews, photos rows, claims,
--    placements, and campaigns tied to this bathroom; the UI must say so.
-- ---------------------------------------------------------------------------
create or replace function public.admin_hard_delete_bathroom(p_bathroom_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select name into v_name from public.bathrooms where id = p_bathroom_id;
  if v_name is null then
    return; -- already gone; idempotent
  end if;

  -- Audit BEFORE the delete so the record survives the cascade.
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'hard_delete_bathroom', 'bathroom', p_bathroom_id,
          jsonb_build_object('name', v_name, 'reason', p_reason));

  delete from public.bathrooms where id = p_bathroom_id;
end; $$;
grant execute on function public.admin_hard_delete_bathroom(uuid, text) to authenticated;

-- Admin helper: every photo storage path under a bathroom, for the
-- delete-bytes-first step.
create or replace function public.admin_bathroom_photo_paths(p_bathroom_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(rp.storage_path), '{}')
  from public.review_photos rp
  join public.reviews r on r.id = rp.review_id
  where r.bathroom_id = p_bathroom_id and public.is_admin();
$$;
grant execute on function public.admin_bathroom_photo_paths(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Standardized attribute taxonomy: admin-extensible amenities ("good") and
--    cautions ("cons"/disclaimers), replacing "add another boolean column"
--    forever. The four legacy boolean amenities stay untouched; this is the
--    growth path.
-- ---------------------------------------------------------------------------
create table if not exists public.attribute_defs (
  slug        text primary key check (slug ~ '^[a-z0-9_]{2,40}$'),
  label       text not null check (char_length(label) between 1 and 60),
  kind        text not null check (kind in ('amenity','caution')),
  description text check (char_length(description) <= 200),
  active      boolean not null default true,
  sort        int not null default 100,
  created_at  timestamptz not null default now()
);
alter table public.attribute_defs enable row level security;
grant select on public.attribute_defs to anon, authenticated;
drop policy if exists "attribute defs are public" on public.attribute_defs;
create policy "attribute defs are public" on public.attribute_defs
  for select using (true);
-- Writes: admin RPC only.

create or replace function public.admin_upsert_attribute(
  p_slug text, p_label text, p_kind text,
  p_description text default null, p_active boolean default true, p_sort int default 100)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.attribute_defs (slug, label, kind, description, active, sort)
  values (p_slug, p_label, p_kind, p_description, p_active, p_sort)
  on conflict (slug) do update
    set label = excluded.label, kind = excluded.kind,
        description = excluded.description, active = excluded.active,
        sort = excluded.sort;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'upsert_attribute', 'attribute', gen_random_uuid(),
          jsonb_build_object('slug', p_slug, 'label', p_label, 'kind', p_kind,
                             'active', p_active));
end; $$;
grant execute on function public.admin_upsert_attribute(text, text, text, text, boolean, int)
  to authenticated;

create table if not exists public.bathroom_attributes (
  bathroom_id    uuid not null references public.bathrooms (id) on delete cascade,
  attribute_slug text not null references public.attribute_defs (slug) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (bathroom_id, attribute_slug)
);
alter table public.bathroom_attributes enable row level security;
grant select on public.bathroom_attributes to anon, authenticated;
drop policy if exists "bathroom attributes are public" on public.bathroom_attributes;
create policy "bathroom attributes are public" on public.bathroom_attributes
  for select using (true);
-- Writes: RPC only (replace-set), so authorization lives in one place.

-- Owner (creator), verified claiming business manager, or moderator sets the
-- full attribute list for a bathroom. Unknown/inactive slugs are rejected.
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
             where b.id = p_bathroom_id and b.created_by = uid)
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
grant execute on function public.set_bathroom_attributes(uuid, text[]) to authenticated;

-- Starter taxonomy (admin-editable from the control room afterwards).
insert into public.attribute_defs (slug, label, kind, description, sort) values
  ('hand_dryer',        'Hand dryer',            'amenity', null, 10),
  ('paper_towels',      'Paper towels',          'amenity', null, 20),
  ('menstrual_products','Menstrual products',    'amenity', null, 30),
  ('family_room',       'Family restroom',       'amenity', null, 40),
  ('shower',            'Shower',                'amenity', null, 50),
  ('open_24_7',         'Open 24/7',             'amenity', null, 60),
  ('requires_purchase', 'Purchase expected',     'caution', 'Staff may expect you to buy something.', 10),
  ('frequently_closed', 'Often closed',          'caution', 'Reported closed during posted hours.', 20),
  ('poorly_lit',        'Poorly lit',            'caution', null, 30),
  ('long_lines',        'Long lines at peak',    'caution', null, 40),
  ('maintenance_issues','Frequent maintenance issues', 'caution', 'Recurring reports of broken fixtures or supplies.', 50)
on conflict (slug) do nothing;
