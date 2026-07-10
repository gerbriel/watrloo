-- Watrloo: paid business accounts (phase 1 — manual, no self-serve payment).
--
-- See docs/ops/BUSINESS_ACCOUNTS.md. A company requests access via a form, an
-- admin approves (arranging payment out of band), and the business can then
-- claim its listings, keep facts/amenities accurate, respond to reviews, and
-- bulk-import a chain. Businesses are a SEPARATE axis from app_role: power over
-- a listing flows claim -> business -> member, never a global grant.
--
-- The load-bearing rule: a business controls its listing FACTS and can respond
-- to / report reviews, but has NO path to edit or delete reviews. Review removal
-- stays with platform moderators (the 20260710020000 migration).
--
-- Authorization is RLS + SECURITY DEFINER RPCs. Manual for now: the admin sets a
-- subscription active by hand after arranging payment; Stripe is a later phase.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 160),
  slug       text unique check (slug ~ '^[a-z0-9-]{1,80}$'),
  website    text check (char_length(website) <= 300),
  logo_url   text check (char_length(logo_url) <= 500),
  owner_id   uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        text not null default 'staff' check (role in ('owner', 'manager', 'staff')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

create table public.subscriptions (
  business_id          uuid primary key references public.businesses (id) on delete cascade,
  plan                 text not null default 'standard',
  status               text not null default 'trialing'
                       check (status in ('active', 'trialing', 'past_due', 'canceled')),
  current_period_end   timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,
  updated_at           timestamptz not null default now()
);

create table public.bathroom_claims (
  id           uuid primary key default gen_random_uuid(),
  bathroom_id  uuid not null references public.bathrooms (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'verified', 'rejected')),
  requested_by uuid references public.profiles (id) on delete set null,
  reviewed_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);
-- At most one business owns a listing.
create unique index bathroom_claims_one_verified on public.bathroom_claims (bathroom_id)
  where status = 'verified';
create index bathroom_claims_business_idx on public.bathroom_claims (business_id);

create table public.business_access_requests (
  id             uuid primary key default gen_random_uuid(),
  requester_id   uuid references public.profiles (id) on delete set null,
  business_name  text not null check (char_length(business_name) between 1 and 160),
  website        text check (char_length(website) <= 300),
  contact_email  text check (char_length(contact_email) <= 200),
  message        text check (char_length(message) <= 2000),
  locations_note text check (char_length(locations_note) <= 4000),
  status         text not null default 'open'
                 check (status in ('open', 'approved', 'rejected')),
  reviewed_by    uuid references public.profiles (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index business_access_requests_open_idx on public.business_access_requests (created_at desc)
  where status = 'open';

create table public.review_responses (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references public.reviews (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (review_id)
);
create index review_responses_review_idx on public.review_responses (review_id);

create trigger review_responses_touch_updated_at
  before update on public.review_responses
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Helpers (SECURITY DEFINER: read membership regardless of the caller's RLS,
--    which also avoids recursion with the policies that call them). Wrapped as
--    (select public.fn()) at call sites for the once-per-statement InitPlan.
-- ---------------------------------------------------------------------------
create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = (select auth.uid())
  );
$$;

-- Owner/manager can change the business + its listings; plain staff cannot.
create or replace function public.is_business_manager(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = (select auth.uid())
      and role in ('owner', 'manager')
  );
$$;

-- The core scope check: caller manages a business that holds a VERIFIED claim on
-- this bathroom AND that business's subscription is live. This is the paywall +
-- the ownership check in one place.
create or replace function public.manages_bathroom(p_bathroom_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bathroom_claims c
    join public.business_members m on m.business_id = c.business_id
    join public.subscriptions s    on s.business_id = c.business_id
    where c.bathroom_id = p_bathroom_id
      and c.status = 'verified'
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'manager')
      and s.status in ('active', 'trialing')
  );
$$;

grant execute on function public.is_business_member(uuid)  to authenticated;
grant execute on function public.is_business_manager(uuid) to authenticated;
grant execute on function public.manages_bathroom(uuid)    to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
alter table public.businesses              enable row level security;
alter table public.business_members        enable row level security;
alter table public.subscriptions           enable row level security;
alter table public.bathroom_claims         enable row level security;
alter table public.business_access_requests enable row level security;
alter table public.review_responses        enable row level security;

grant select on public.businesses              to anon, authenticated;
grant select on public.business_members        to authenticated;
grant select on public.subscriptions           to authenticated;
grant select on public.bathroom_claims         to authenticated;
grant select, insert on public.business_access_requests to authenticated;
grant select on public.review_responses        to anon, authenticated;
grant update on public.businesses              to authenticated;

-- businesses: public can read the advertiser-facing profile (name/logo/website
-- power the "Official" badge). Managers can update their own profile. Rows are
-- created only by the admin approval RPC.
create policy "businesses are viewable by everyone"
  on public.businesses for select using (true);
create policy "managers update their business"
  on public.businesses for update to authenticated
  using ((select public.is_business_manager(id)))
  with check ((select public.is_business_manager(id)));

-- business_members: you can see the rosters of businesses you belong to.
create policy "members read their business roster"
  on public.business_members for select to authenticated
  using ((select public.is_business_member(business_id)));

-- subscriptions: members can read their own; writes are admin/service_role only.
create policy "members read their subscription"
  on public.subscriptions for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));

-- claims: members create pending claims for their business and read them;
-- admins read all. Verification/rejection is admin-RPC only (no update policy).
create policy "members read their claims or admin all"
  on public.bathroom_claims for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_moderator()));
create policy "managers file claims for their business"
  on public.bathroom_claims for insert to authenticated
  with check (
    (select public.is_business_manager(business_id))
    and status = 'pending'
    and requested_by = (select auth.uid())
  );
-- Verified claims are public so the "Official" badge can render for anyone;
-- pending/rejected claims stay visible only to the business and admins.
grant select on public.bathroom_claims to anon;
create policy "verified claims are public"
  on public.bathroom_claims for select using (status = 'verified');

-- access requests: anyone signed in files their own; they see their own, admins
-- see all. Approval/rejection is admin-RPC only.
create policy "users file their own access request"
  on public.business_access_requests for insert to authenticated
  with check ((select auth.uid()) = requester_id);
-- A company shouldn't need a Watrloo consumer account to ask for access. Anon
-- may insert only rows with a null requester_id (so it can't impersonate a
-- member); length is capped by the CHECK constraints and the client sanitizes.
grant insert on public.business_access_requests to anon;
create policy "anyone can file an access request"
  on public.business_access_requests for insert to anon
  with check (requester_id is null);
create policy "read own access request or all as admin"
  on public.business_access_requests for select to authenticated
  using ((select auth.uid()) = requester_id or (select public.is_moderator()));

-- review responses: public reads (they're public replies); writes via RPC only.
create policy "review responses are viewable by everyone"
  on public.review_responses for select using (true);

-- ---------------------------------------------------------------------------
-- 4. RPCs — business side
-- ---------------------------------------------------------------------------

-- Edit a claimed listing's FACTS only. Never touches created_by/deleted_at/
-- ratings, and never reviews. Re-checks scope, logs to the moderation audit.
create or replace function public.business_update_listing(
  p_bathroom_id uuid,
  p_name text,
  p_address text,
  p_description text,
  p_wheelchair_accessible boolean,
  p_gender_neutral boolean,
  p_changing_table boolean,
  p_requires_key boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.manages_bathroom(p_bathroom_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.bathrooms
     set name = p_name,
         address = p_address,
         description = p_description,
         wheelchair_accessible = p_wheelchair_accessible,
         gender_neutral = p_gender_neutral,
         changing_table = p_changing_table,
         requires_key = p_requires_key
   where id = p_bathroom_id and deleted_at is null;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'update_bathroom', 'bathroom', p_bathroom_id,
          jsonb_build_object('via', 'business'));
end;
$$;

-- Post or update the single official response to a review, for a business that
-- manages the review's bathroom.
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
  if not public.manages_bathroom(v_bathroom) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select c.business_id into v_business
  from public.bathroom_claims c
  where c.bathroom_id = v_bathroom and c.status = 'verified'
  limit 1;

  insert into public.review_responses (review_id, business_id, author_id, body)
  values (p_review_id, v_business, (select auth.uid()), p_body)
  on conflict (review_id)
  do update set body = excluded.body, author_id = excluded.author_id, updated_at = now();
end;
$$;

-- Owner adds / removes a teammate on a business they own.
create or replace function public.business_add_member(p_business_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = (select auth.uid()) and role = 'owner'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_role not in ('manager', 'staff') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  insert into public.business_members (business_id, user_id, role)
  values (p_business_id, p_user_id, p_role)
  on conflict (business_id, user_id) do update set role = excluded.role;
end;
$$;

create or replace function public.business_remove_member(p_business_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = (select auth.uid()) and role = 'owner'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Never let the last owner be removed.
  if exists (select 1 from public.business_members where business_id = p_business_id and user_id = p_user_id and role = 'owner')
     and (select count(*) from public.business_members where business_id = p_business_id and role = 'owner') <= 1 then
    raise exception 'cannot remove the last owner' using errcode = '23514';
  end if;

  delete from public.business_members
  where business_id = p_business_id and user_id = p_user_id;
end;
$$;

grant execute on function public.business_update_listing(uuid, text, text, text, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.business_respond_to_review(uuid, text) to authenticated;
grant execute on function public.business_add_member(uuid, uuid, text)  to authenticated;
grant execute on function public.business_remove_member(uuid, uuid)      to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPCs — admin side (gate on is_admin, log everything)
-- ---------------------------------------------------------------------------

-- Approve an access request: create the business, make the requester its owner,
-- start a subscription (admin has arranged payment out of band). Returns the id.
create or replace function public.admin_approve_access_request(p_request_id uuid, p_plan text default 'standard')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.business_access_requests;
  v_business uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_req from public.business_access_requests where id = p_request_id;
  if v_req is null or v_req.status <> 'open' then
    raise exception 'request not open' using errcode = 'P0002';
  end if;

  insert into public.businesses (name, website, owner_id)
  values (v_req.business_name, v_req.website, v_req.requester_id)
  returning id into v_business;

  insert into public.business_members (business_id, user_id, role)
  values (v_business, v_req.requester_id, 'owner');

  insert into public.subscriptions (business_id, plan, status)
  values (v_business, p_plan, 'active');

  update public.business_access_requests
     set status = 'approved', reviewed_by = (select auth.uid()), reviewed_at = now()
   where id = p_request_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'approve_access_request', 'business', v_business,
          jsonb_build_object('request', p_request_id));

  return v_business;
end;
$$;

create or replace function public.admin_reject_access_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.business_access_requests
     set status = 'rejected', reviewed_by = (select auth.uid()), reviewed_at = now()
   where id = p_request_id and status = 'open';
end;
$$;

-- Verify or reject a claim. Verifying is what actually hands a business control.
create or replace function public.admin_review_claim(p_claim_id uuid, p_verify boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.bathroom_claims
     set status = case when p_verify then 'verified' else 'rejected' end,
         reviewed_by = (select auth.uid()), reviewed_at = now()
   where id = p_claim_id and status = 'pending';

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  select (select auth.uid()),
         case when p_verify then 'verify_claim' else 'reject_claim' end,
         'bathroom', c.bathroom_id, jsonb_build_object('claim', p_claim_id, 'business', c.business_id)
  from public.bathroom_claims c where c.id = p_claim_id;
end;
$$;

grant execute on function public.admin_approve_access_request(uuid, text) to authenticated;
grant execute on function public.admin_reject_access_request(uuid)        to authenticated;
grant execute on function public.admin_review_claim(uuid, boolean)        to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Extend the moderation audit vocabulary for the actions above.
-- ---------------------------------------------------------------------------
alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim'));
