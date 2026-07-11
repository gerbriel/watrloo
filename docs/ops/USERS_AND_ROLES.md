# Watrloo — Users & Roles

Design for the role / permission system. Status: **tier 1 implemented** in
`supabase/migrations/20260710020000_roles_reports_moderation.sql` — the
`user_roles` table, `is_moderator()`/`is_admin()`, soft-delete + moderator
visibility, `reports`, `moderation_actions`, and the moderation/role RPCs, with
an in-app `/admin` portal (report queue, review + bathroom moderation, role
management). The implementation uses the **table-based** helper (§4.1) rather
than the JWT custom-access-token hook (§3.2c); that hook remains the documented
optimization to remove the per-statement table touch. Not yet built: account
anonymization on deletion (§6) and anything needing `service_role` (listing/
banning auth users), which requires an Edge Function. Sections below are the
original design rationale and remain the reference.

To deploy: `supabase db push` to the linked project, then bootstrap the first
admin once from the SQL editor (see the tail of the migration).

**Non-negotiable premise.** The repo is public and ships the Supabase anon key.
Every line of client code and every policy name is readable by an attacker. So
authorization is whatever Postgres RLS + GRANTs enforce. The React layer can
only *hide buttons*. If a rule matters, it lives in the database.

## Verification

Independent fact-check of the platform claims in this document (checked 2026-07-10 against primary sources). The two headline claims — Custom Access Token Hook on Free, and the InitPlan optimization — both confirmed.

| Claim | Status | Source | Note |
|---|---|---|---|
| Custom Access Token Hook is available on the **Free** plan | **CONFIRMED** | [auth-hooks](https://supabase.com/docs/guides/auth/auth-hooks) | availability table lists Custom Access Token = **Free, Pro** (also: Before User Created = Free, Pro) |
| Hook is a Postgres fn `f(event jsonb) returns jsonb`; enabled via Dashboard → Authentication → Hooks, or `config.toml` `pg-functions://…` uri | **CONFIRMED** | [auth-hooks](https://supabase.com/docs/guides/auth/auth-hooks) | — |
| RLS `(select auth.uid())` / `(select public.is_moderator())` hoists to a **once-per-statement InitPlan**; applies to `auth.jwt()` and `security definer` fns | **CONFIRMED** | [RLS performance](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) | "Wrapping the function… causes an initPlan… to cache the results versus calling the function on each row." Valid only when the result doesn't depend on row data — the `stable` helpers here qualify |
| Column-level `REVOKE` is a no-op while the role holds table-level UPDATE; correct fix = revoke table-level then `GRANT (col,…)` | **CONFIRMED** | [PostgreSQL GRANT/REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html) | — |
| Stock Supabase grants table-wide privileges to `authenticated` | **CONFIRMED (adjacent)** | [discussion #7428](https://github.com/orgs/supabase/discussions/7428) | cited; consistent, not re-fetched this pass |
| `app_metadata` is user-immutable; `auth.jwt() -> 'app_metadata' ->> 'role'` read path | **CONFIRMED (adjacent)** | [RBAC guide](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac) | consistent with the auth-hooks / RBAC docs |
| `config.toml` `[auth.hook.custom_access_token]` key + `pg-functions://` uri format | **UNVERIFIABLE** | — | doc already flags ⚠; verify against the installed CLI version |
| Direct `insert into auth.users` for the sentinel row | **UNVERIFIABLE** | — | doc already flags ⚠; the nullable-`author_id` variant avoids touching `auth.users` |

---

## 1. Recommended role model

Three tiers. Ordinary users are represented by the **absence** of a role row —
we do not store a `'user'` role, so the common case costs nothing and there is
no default value to get wrong.

| Role | How you get it | What it can do that a normal user can't | Why it exists / why not more |
|------|----------------|------------------------------------------|-------------------------------|
| **user** (implicit) | Sign up. No `user_roles` row. | — Create bathrooms. Create/edit/delete **own** reviews. Edit bathrooms **they** created. | The base tier. Everything scoped to `auth.uid()`. |
| **moderator** | Granted by an admin (insert a `user_roles` row). | Update **any** bathroom (fix a wrong address, fix amenities). Delete **any** bathroom (needed for merges/dupes). Soft-delete/delete **any** review (spam, abuse). Permanently delete **any single review photo** (explicit content — destroys the bytes, audited, no restore; `moderate_delete_review_photo` + a bucket-wide storage delete policy). Read + resolve `reports`. | This is the role that fixes the two holes in today's schema: nobody can correct a bathroom whose `created_by` went null, and nobody but the author can remove an abusive review. Volume role — granted somewhat liberally, so it deliberately **cannot** mint more roles. |
| **admin** | Bootstrapped once by `service_role`; thereafter granted by another admin. | Everything a moderator can, **plus** grant/revoke roles, and any destructive/schema-adjacent op we gate on `is_admin()`. | Separation of duties: the ability to *hand out power* is rarer and higher-trust than the ability to *use* it. Keeping admin distinct means a compromised moderator account cannot escalate itself or others. |

`admin` is a strict superset of `moderator`: `is_moderator()` returns true for
both; `is_admin()` returns true for admin only. Policies that say "moderators
can…" therefore also admit admins with no extra clause.

### Roles I considered and rejected

- **"Trusted contributor" earned by contribution count (wiki-style "edit any
  bathroom").** Rejected for v1. (a) It's a farmable attack surface: grind N
  cheap contributions, then vandalize at scale with edit-any rights. (b)
  Bathroom facts (address, accessibility flags) are exactly the data that
  benefits from *review*, not from open editing. (c) It forces a computed,
  recount-on-every-action role, which is real complexity for a benefit
  ("less moderator load") we have no evidence we need yet. The right escape
  valve is letting anyone **file a report / suggested edit** (section 5) and
  letting a moderator apply it — same throughput relief, no new privilege.
  Revisit only if moderators become a bottleneck.
- **Separate `curator` between moderator and admin.** Rejected. Two content
  roles is one too many at this size; `moderator` already covers all content
  actions. Split later if role assignment volume justifies delegating it.
- **Per-region / per-city moderators.** Rejected for v1. Adds a scoping column
  and a join to every policy for a scale we don't have. The `user_roles` schema
  below leaves room to add a `scope` column later without a rewrite.

---

## 2. THE PRIVILEGE-ESCALATION ANALYSIS  ⚠️ headline

> Putting `role` on `profiles` and keeping the current self-update policy is a
> one-line account takeover. This section is the reason the storage decision in
> §3 goes the way it does.

### 2.1 The current policy

```sql
create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
```

This is correct **today** because every column on `profiles` (`username`,
`avatar_url`) is fine for the owner to change. The policy's contract is: *"you
may update a profile row iff it is yours."*

### 2.2 What breaks the instant you add `role`

Suppose someone adds `role app_role not null default 'user'` to `profiles` and
leaves the policy untouched. Now run this from the **public** anon-key client,
signed in as any user:

```js
// This is not an exploit that needs special access. It is the normal client.
await supabase
  .from('profiles')
  .update({ role: 'admin' })
  .eq('id', myUserId);
```

Trace it through the policy:

- `using ((select auth.uid()) = id)` → the row is mine → **passes**.
- `with check ((select auth.uid()) = id)` → after the change the row is still
  mine (I didn't touch `id`) → **passes**.

The update commits. I am now an admin. **This is a live, trivial, remote
privilege escalation** the moment a `role` column exists under this policy.

### 2.3 Why RLS alone cannot fix it — the load-bearing insight

RLS decides **which rows** a statement may touch. It does **not** decide **which
columns**. A `WITH CHECK` that only inspects `auth.uid() = id` is a statement
*about the row's identity*; it says nothing about whether `role` changed. There
is no `WITH CHECK` you can write that means "…and you didn't modify the `role`
column" using only the row predicate, because RLS never sees "old vs new column
values" as a first-class thing you can compare across all columns generically —
you'd have to enumerate and pin every other column, and even then a plain
`with check (role = 'user')` would forbid *admins* from ever holding a role too.

Column-level control lives at a **different layer** than RLS:

1. **GRANT/REVOKE column privileges** (privilege layer, checked before RLS), or
2. **A trigger** that inspects `OLD.role` vs `NEW.role` (procedural layer).

### 2.4 Fix A — column privileges (and the Supabase trap that makes the naive form a no-op)

The instinct is:

```sql
-- ❌ DOES NOTHING on a stock Supabase project.
revoke update (role) on public.profiles from authenticated;
```

This is a **no-op** here, and getting this wrong is the classic mistake.
Reason: privilege checks are a **union** of table-level and column-level grants.
If the role already holds **table-level** `UPDATE`, a column-level *revoke*
can't subtract from it — the table grant still satisfies the check. From the
PostgreSQL docs: *"if a role has been granted privileges on a table, then
revoking the same privileges from individual columns will have no effect… the
table-level grant is unaffected by a column-level operation."*

And a stock Supabase project **does** grant table-wide privileges to
`authenticated` (this is exactly Supabase Discussion #7428, *"Grant ALL then
Revoke does not work for single column"*). So `authenticated` holds table-level
`UPDATE` on `profiles` out of the box, and the revoke-one-column form silently
achieves nothing.

The **correct** form: drop the table-level grant, then re-grant only the columns
users are allowed to write.

```sql
-- ✅ Correct: remove the table-wide UPDATE, hand back only the safe columns.
revoke update on public.profiles from authenticated;          -- also drop anon if it was ever granted
grant  update (username, avatar_url) on public.profiles to authenticated;
```

Now `authenticated` has **no** privilege that covers the `role` column, so any
statement that tries to assign `role` is rejected at the privilege layer —
*before RLS is even consulted*, and regardless of how the RLS predicate reads.
Adding a new user-writable column later means adding it to this `GRANT` list;
forgetting to is fail-closed (they just can't write it), which is the safe
direction to fail.

Caveat you must document if you go this way: `service_role` (and `postgres`)
bypass RLS but still obey column grants unless separately privileged; the admin
path that *does* change roles must run as a role that holds the column
privilege. With the table-in-`profiles` design that means changing roles from a
server context, which is nearly all the pain of §3's separate-table design with
none of its cleanliness.

### 2.5 Fix B — a trigger that rejects role changes (defense in depth)

Even with column grants, a trigger makes the invariant explicit and survives a
future careless `GRANT`:

```sql
create or replace function public.forbid_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
  then
    raise exception 'role may not be changed here';
  end if;
  return new;
end;
$$;

create trigger profiles_forbid_self_role_change
  before update on public.profiles
  for each row execute function public.forbid_self_role_change();
```

This is belt-and-suspenders, not a substitute for the grant.

### 2.6 Verdict

Both fixes work, but they exist only to *patch a column that shouldn't be on a
user-writable row in the first place*. The escalation surface is created by
co-locating an authorization field with fields the user is trusted to edit. The
robust move is to **not store `role` on `profiles` at all** — which is §3.

---

## 3. Where the role lives — decision + full migration

### 3.1 The three options, compared

| | (a) `profiles.role` | (b) separate `user_roles` table | (c) `user_roles` **+** custom access-token hook → JWT claim |
|---|---|---|---|
| **Escalation resistance** | Poor by default (§2). Needs column-grant surgery *and* ongoing vigilance. | Strong: table has **no** user-writable policy; users literally cannot `INSERT`/`UPDATE` it. | Strong: same table protection; the hook runs as `supabase_auth_admin`, not as the user. |
| **RLS read cost** | Cheap (same-row column) — but only after you've paid the §2 tax. | A **subquery per policy evaluation** (`exists (select 1 from user_roles …)`). Hoistable to once-per-statement with the `(select …)` trick, but still a table touch. | **Zero joins.** Role is a JWT claim; `auth.jwt()` is in-memory. `is_moderator()` reads the token, no table. |
| **Freshness** | Immediate. | Immediate (reads live table). | **Stale until token refresh** (~1h, or next sign-in). A revoked moderator keeps power until their access token rolls. |
| **Operational simplicity** | One column — deceptively simple, then §2. | Plain SQL to grant a role: `insert into user_roles …`. Queryable/joinable for an admin UI. | Same grant ergonomics as (b), **plus** a one-time hook setup and the freshness caveat. |

### 3.2 Recommendation: **(c)** — `user_roles` table as source of truth, surfaced into the JWT by a Custom Access Token Hook

This is the pattern in Supabase's own RBAC guide. It gives escalation
resistance (b)'s table protection, plus join-free RLS, at the cost of one hook
and eventual-consistency on role changes — acceptable because role changes are
rare and a ~1h propagation delay on *granting* power is harmless, while on
*revoking* it we can force a sign-out (below). If you want zero-delay revocation
and don't mind a per-statement subquery, the **pure-(b) fallback helper** in
§4.3 drops in without touching any policy.

**Verified against docs (July 2026):**
- Custom Access Token Hook is available on the **Free plan** (docs list it as
  *Free, Pro*). ✅
- Hook is a Postgres function `f(event jsonb) returns jsonb`; you enable it in
  **Dashboard → Authentication → Hooks** (or `config.toml` for local dev). ✅
- RLS policies read the claim with `auth.jwt()`, and
  `auth.jwt() -> 'app_metadata' ->> 'role'` (or a top-level custom claim) is the
  documented access path. ✅

### 3.3 Full migration (ordered, runnable)

```sql
-- ============================================================================
-- Migration: role system (user_roles + custom access token hook)
-- Depends on: 20260710000000_init.sql
-- ============================================================================

-- 1. Role enum. moderator ⊂ admin is enforced in the helpers, not the type.
create type public.app_role as enum ('moderator', 'admin');

-- 2. Source-of-truth table. One row per (user, role). No 'user' rows.
create table public.user_roles (
  user_id    uuid       not null references auth.users (id) on delete cascade,
  role       public.app_role not null,
  granted_by uuid       references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

alter table public.user_roles enable row level security;

-- 3. RLS: users may READ their own roles (handy for the client), and admins may
--    read all. NOBODY gets a user-writable policy — no INSERT/UPDATE/DELETE
--    policy exists, so PostgREST refuses every write from anon/authenticated.
--    Writes happen only via service_role (which bypasses RLS) or the admin RPC
--    in §5. This is the whole point: the escalation column of §2 is unreachable.
create policy "users read their own roles"
  on public.user_roles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "admins read all roles"
  on public.user_roles for select to authenticated
  using ((select public.is_admin()));      -- helper defined in §4

-- 4. Let the auth server read this table so the hook can compute claims, and
--    make sure ordinary clients cannot. (Table grants, distinct from RLS.)
grant usage on schema public to supabase_auth_admin;
grant select on table public.user_roles to supabase_auth_admin;
revoke all on table public.user_roles from anon, authenticated;   -- keep grants tight; RLS above governs reads

create policy "auth admin reads roles"
  on public.user_roles for select to supabase_auth_admin
  using (true);

-- 5. The Custom Access Token Hook. Runs as supabase_auth_admin, before a token
--    is issued, and injects the highest role the user holds. We write it into
--    app_metadata (user-immutable by convention) AND as a top-level claim for
--    convenience. absence of a row => 'user'.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb := event -> 'claims';
  meta      jsonb := coalesce(claims -> 'app_metadata', '{}'::jsonb);
  top_role  public.app_role;
begin
  -- admin outranks moderator; enum order ('moderator','admin') → max() = admin
  select max(role) into top_role
  from public.user_roles
  where user_id = (event ->> 'user_id')::uuid;

  if top_role is not null then
    meta   := jsonb_set(meta, '{role}', to_jsonb(top_role::text), true);
    claims := jsonb_set(claims, '{app_metadata}', meta, true);
    claims := jsonb_set(claims, '{user_role}', to_jsonb(top_role::text), true);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- 6. Grants for the hook (per Supabase docs): only the auth admin may execute
--    it; everyone else is revoked.
grant  execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;
```

**Enabling the hook** (not SQL — do this after the migration applies):

- **Hosted / production:** Dashboard → **Authentication → Hooks** → *Custom
  Access Token* → select the Postgres function
  `public.custom_access_token_hook`. (Free plan is sufficient.)
- **Local dev:** in `supabase/config.toml`
  ```toml
  [auth.hook.custom_access_token]
  enabled = true
  uri = "pg-functions://postgres/public/custom_access_token_hook"
  ```
  *(config.toml key/uri format per the local-dev docs; verify against your CLI
  version — marked ⚠️ as the one item I couldn't confirm against the exact
  current toml schema.)*

**Bootstrapping the first admin** (run once as `service_role`, e.g. SQL editor):

```sql
insert into public.user_roles (user_id, role)
values ('<the-founder-uuid>', 'admin')
on conflict do nothing;
-- Then have that user sign out and back in so their JWT carries the claim.
```

---

## 4. Role-aware RLS

### 4.1 The helper — `is_moderator()` / `is_admin()` (JWT variant, recommended)

```sql
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('moderator', 'admin'),
    false
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

grant execute on function public.is_moderator() to authenticated, anon;
grant execute on function public.is_admin()     to authenticated, anon;
```

**Why each qualifier matters:**

- **`stable`** — the result depends only on the current transaction's JWT, not
  on the row being scanned, and doesn't change within a statement. Declaring it
  `stable` (a) is *truthful* (it isn't `volatile`), and (b) is what lets the
  planner treat `(select public.is_moderator())` as a one-time **InitPlan**
  instead of re-invoking it per row. A `volatile` function would be called for
  every row and would defeat the optimization in §4.2.
- **`security definer`** — for the JWT variant this is not strictly required
  (reading `auth.jwt()` needs no table privilege), but it is **mandatory** for
  the table-lookup fallback in §4.3, which must read `user_roles` — a table the
  `authenticated` role has *no* SELECT grant on. `security definer` runs the
  function with the owner's privileges so the check works *without* handing
  users direct read access to the roles table. Kept here for symmetry so both
  variants are drop-in interchangeable.
- **`set search_path = ''`** — a `security definer` function is a privilege
  escalation vector: if an attacker can create an object (a table, a function
  named `jwt`, an operator) in a schema that appears *earlier* on the function's
  `search_path`, they can hijack what an unqualified name resolves to and run
  their code as the definer. Pinning `search_path = ''` forces every reference
  to be schema-qualified (hence `auth.jwt()`, `public.user_roles`) and removes
  the hijack surface entirely. This is required hygiene for every
  `security definer` function — the existing `handle_new_user` already does it.

### 4.2 Calling it once per statement, not once per row (the InitPlan trick)

Supabase's RLS performance guidance: wrap volatile-looking calls in a scalar
subquery so the planner hoists them into an **InitPlan** evaluated **once per
statement** rather than **once per row**. It applies to `auth.uid()`,
`auth.jwt()`, and to our `stable` helpers:

```sql
-- once per row  (slow on a big scan):   using ( public.is_moderator() )
-- once per stmt (fast):                 using ( (select public.is_moderator()) )
```

On a large `bathrooms`/`reviews` scan this is the difference between a
constant-time check and one function call per candidate row. Every policy below
uses the `(select …)` form. (Supabase's own `auth_rls_initplan` advisor lints
for exactly this.)

### 4.3 Table-lookup fallback (pure option (b), zero-staleness) — drop-in

If you skip the hook, or want role changes to take effect **immediately** (no
waiting for token refresh), define the *same-named* helpers to read the table.
Every policy in §4.4 keeps working unchanged, because they only call
`public.is_moderator()` / `public.is_admin()`.

```sql
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('moderator', 'admin')
  );
$$;
-- is_admin() analogous with role = 'admin'.
```

Trade-off: correctness-now vs a per-statement subquery. Wrapped in
`(select public.is_moderator())` it's still one lookup per statement, so the
cost is modest. Pick one variant; don't ship both.

### 4.4 Rewritten policies

These **replace** the corresponding policies in the init migration. Drop the old
one, create the new one (a policy can't be edited in place).

```sql
-- ---- bathrooms --------------------------------------------------------------
-- UPDATE: creator OR any moderator (fixes "wrong address, creator gone").
drop policy if exists "users update bathrooms they added" on public.bathrooms;
create policy "update own bathrooms or any as moderator"
  on public.bathrooms for update to authenticated
  using      ((select auth.uid()) = created_by or (select public.is_moderator()))
  with check ((select auth.uid()) = created_by or (select public.is_moderator()));

-- DELETE: today there is NO delete policy at all → nobody can remove a bathroom.
-- Add one, moderator-scoped. (Deleting a bathroom cascades its reviews/photos.)
create policy "moderators delete bathrooms"
  on public.bathrooms for delete to authenticated
  using ((select public.is_moderator()));
-- If you also want creators to delete their own un-reviewed bathrooms, extend to:
--   using ((select public.is_moderator()) or (select auth.uid()) = created_by)

-- ---- reviews ----------------------------------------------------------------
-- SELECT: hide soft-deleted rows from the public; moderators still see them.
drop policy if exists "reviews are viewable by everyone" on public.reviews;
create policy "reviews are viewable unless soft-deleted"
  on public.reviews for select
  using (deleted_at is null or (select public.is_moderator()));

-- UPDATE: author edits own; moderator may update any (used for soft-delete).
drop policy if exists "users update their own reviews" on public.reviews;
create policy "update own reviews or any as moderator"
  on public.reviews for update to authenticated
  using      ((select auth.uid()) = author_id or (select public.is_moderator()))
  with check ((select auth.uid()) = author_id or (select public.is_moderator()));

-- DELETE: author removes own; moderator may hard-delete any (spam/abuse).
drop policy if exists "users delete their own reviews" on public.reviews;
create policy "delete own reviews or any as moderator"
  on public.reviews for delete to authenticated
  using ((select auth.uid()) = author_id or (select public.is_moderator()));
```

`profiles` INSERT/UPDATE policies are left exactly as-is — because we chose §3(c)
there is **no** `role` column on `profiles`, so the §2 hole never opens and no
column-grant surgery is needed.

> Note on moderator UPDATE of reviews: allowing a moderator to rewrite another
> user's `body`/`rating` is undesirable (impersonation). Prefer soft-delete
> (set `deleted_at`) over editing content. If you want to *enforce* "a moderator
> may only touch `deleted_at`", add a column-grant split like §2.4 for reviews,
> or funnel moderator writes exclusively through the RPC in §5.4. The audit
> trail (§5.3) records whatever they do either way.

---

## 5. Moderation primitives (minimum, but real)

### 5.1 Soft-delete for reviews

Hard-deleting a spam review loses the evidence and the audit target. Soft-delete
keeps the row, hides it from the public (via the SELECT policy in §4.4), and
lets moderators reverse a mistake.

```sql
alter table public.reviews
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id) on delete set null;

-- Keep the public aggregate honest: soft-deleted reviews must not count.
-- (Proposed replacement for the bathroom_stats view's join.)
create or replace view public.bathroom_stats
with (security_invoker = on) as
select
  b.id                                    as bathroom_id,
  count(r.id)::int                        as review_count,
  round(avg(r.rating)::numeric, 2)        as avg_rating,
  round(avg(r.cleanliness)::numeric, 2)   as avg_cleanliness,
  round(avg(r.privacy)::numeric, 2)       as avg_privacy,
  round(avg(r.accessibility)::numeric, 2) as avg_accessibility
from public.bathrooms b
left join public.reviews r
  on r.bathroom_id = b.id and r.deleted_at is null   -- <- the only change
group by b.id;
```

Bathrooms are hard-deleted (they cascade reviews/photos, and a stale place is
just noise). Reviews are soft-deleted. That asymmetry is intentional.

### 5.2 `reports` — users flag content

```sql
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles (id) on delete set null,
  -- Exactly one target. Real FKs (not a polymorphic string) so integrity holds
  -- and a deleted target cleans up its reports.
  review_id   uuid references public.reviews (id)   on delete cascade,
  bathroom_id uuid references public.bathrooms (id) on delete cascade,
  reason      text not null check (char_length(reason) between 1 and 1000),
  status      text not null default 'open'
              check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  check ( (review_id is not null)::int + (bathroom_id is not null)::int = 1 )
);
create index reports_open_idx on public.reports (created_at desc) where status = 'open';

alter table public.reports enable row level security;

-- Any signed-in user files a report as themselves.
create policy "users file their own reports"
  on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id);

-- A reporter can see their own reports; moderators see everything.
create policy "read own reports or all as moderator"
  on public.reports for select to authenticated
  using ((select auth.uid()) = reporter_id or (select public.is_moderator()));

-- Only moderators triage (change status / set resolver).
create policy "moderators update reports"
  on public.reports for update to authenticated
  using      ((select public.is_moderator()))
  with check ((select public.is_moderator()));
```

Reports are **not** publicly readable — they can contain accusations. No DELETE
policy: reports are resolved/dismissed, not erased.

### 5.3 `moderation_actions` — audit trail

Every moderator action is attributable and immutable. `actor_id` is nullable
with `on delete set null` so the audit **survives** the moderator's account
deletion.

```sql
create table public.moderation_actions (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null check (action in (
                'soft_delete_review', 'restore_review', 'delete_review',
                'delete_bathroom', 'update_bathroom', 'merge_bathroom',
                'resolve_report', 'dismiss_report',
                'grant_role', 'revoke_role')),
  target_type text not null check (target_type in ('review','bathroom','report','profile')),
  target_id   uuid not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index moderation_actions_target_idx on public.moderation_actions (target_type, target_id);

alter table public.moderation_actions enable row level security;

-- Readable by moderators. Writable by NOBODY via PostgREST directly — rows are
-- inserted only by the SECURITY DEFINER RPCs in §5.4, so an action can't be
-- performed without leaving a record. (No insert/update/delete policy exists.)
create policy "moderators read the audit log"
  on public.moderation_actions for select to authenticated
  using ((select public.is_moderator()));
```

### 5.4 One worked RPC (the pattern)

Route destructive moderator actions through `security definer` functions that
(1) re-check the role server-side, (2) perform the action, (3) write the audit
row — atomically, so the log can't be skipped.

```sql
create or replace function public.moderate_soft_delete_review(
  p_review_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'not authorized';
  end if;

  update public.reviews
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_review_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values (auth.uid(), 'soft_delete_review', 'review', p_review_id,
          jsonb_build_object('reason', p_reason));
end;
$$;

grant execute on function public.moderate_soft_delete_review(uuid, text) to authenticated;
```

`grant_role` / `revoke_role` RPCs follow the same shape but gate on
`is_admin()`, `insert`/`delete` on `user_roles`, and log to
`moderation_actions`. That is the *only* sanctioned write path to `user_roles`
outside `service_role`.

---

## 6. Account lifecycle

### 6.1 Deletion: cascade vs anonymize

Today, deleting an account (`auth.users` row) cascades:
`auth.users → profiles → reviews` (every review the person wrote **vanishes**)
and `bathrooms.created_by → null`. That destroys community content — a helpful
review of a bathroom disappears because its author later closed their account,
and the average rating silently shifts.

**Proposal: anonymize the author instead of cascading their reviews.** Keep the
review text and ratings (community value), sever the link to the person (privacy
value). Reassign orphaned reviews to a sentinel `[deleted]` profile.

Two wrinkles to get right:

1. The `profiles.username` check is `^[a-zA-Z0-9_]{3,30}$` — the literal string
   `[deleted]` **fails** it (brackets aren't allowed). Use a conforming handle
   like `deleted_user` and render it as "[deleted]" in the UI.
2. `profiles.id` is FK → `auth.users(id)`. A sentinel profile needs a matching
   `auth.users` row (or you'd have to relax the FK). Seed one fixed system row
   once, via `service_role`.

```sql
-- One-time seed (service_role). Fixed UUID; never delete this row.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000',
        'deleted@watrloo.invalid', '{}'::jsonb)
on conflict (id) do nothing;
insert into public.profiles (id, username)
values ('00000000-0000-0000-0000-000000000000', 'deleted_user')
on conflict (id) do nothing;

-- Before a profile is deleted (which is itself driven by the auth.users cascade),
-- hand its reviews to the sentinel instead of letting them cascade away.
create or replace function public.anonymize_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sentinel constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if old.id = sentinel then
    return old;  -- never anonymize the sentinel itself
  end if;
  -- unique(bathroom_id, author_id): if the sentinel already reviewed this
  -- bathroom, drop the departing user's duplicate rather than collide.
  delete from public.reviews r
   where r.author_id = old.id
     and exists (select 1 from public.reviews s
                  where s.bathroom_id = r.bathroom_id and s.author_id = sentinel);
  update public.reviews
     set author_id = sentinel
   where author_id = old.id;
  return old;
end;
$$;

create trigger profiles_anonymize_before_delete
  before delete on public.profiles
  for each row execute function public.anonymize_on_profile_delete();
```

**Trade-off, stated honestly.** This is a deliberate GDPR posture: we treat a
review as user-generated *content contributed to a public directory*, not as
personal data, and on erasure we remove the **linkage** (author identity) rather
than the content. That's defensible and common, but it is a policy choice —
if you must support hard "delete everything I ever wrote," keep the original
cascade behind a user-selectable option ("delete my reviews too") and default to
anonymize.

*Simpler variant (if you'd rather not seed an auth.users row):* make
`reviews.author_id` nullable and change its FK to `on delete set null`; render a
null author as "[deleted]". Loses nothing except the `unique(bathroom_id,
author_id)` guarantee for orphaned rows (harmless) and needs the SELECT/JOINs to
tolerate null authors.

### 6.2 Username changes

Currently unconstrained beyond uniqueness + regex — a user can rename every
second, which enables impersonation churn and breaks any "who is @x" memory.
Minimum viable friction:

```sql
alter table public.profiles
  add column username_changed_at timestamptz;

create or replace function public.rate_limit_username()
returns trigger
language plpgsql
as $$
begin
  if new.username is distinct from old.username then
    if old.username_changed_at is not null
       and old.username_changed_at > now() - interval '30 days' then
      raise exception 'username can be changed at most once every 30 days';
    end if;
    new.username_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger profiles_rate_limit_username
  before update on public.profiles
  for each row execute function public.rate_limit_username();
```

A full `username_history` table (old handle, changed_at) is worth adding **only**
if you need to resolve old @mentions or investigate abuse; it's optional for v1.
If you add it, insert into it from this same trigger.

### 6.3 The email-leak in `handle_new_user`

```sql
desired := coalesce(
  nullif(new.raw_user_meta_data ->> 'username', ''),
  split_part(new.email, '@', 1)   -- ⚠️ leaks the email local-part publicly
);
```

`profiles.username` is world-readable (the SELECT policy is `using (true)`), and
usernames appear next to every review. If a user signs up without supplying a
username, their public handle becomes the local-part of their email — for
`jane.doe.1994@gmail.com` that publishes `jane.doe.1994`, i.e. their real name
and often their exact Gmail address minus the domain. That is a real PII leak on
every default signup.

**Fix:** never derive the public handle from the email. Fall back to an opaque,
collision-resistant handle instead.

```sql
-- Replacement fallback inside handle_new_user():
desired := nullif(new.raw_user_meta_data ->> 'username', '');
if desired is null then
  desired := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
end if;
desired := regexp_replace(desired, '[^a-zA-Z0-9_]', '', 'g');
if char_length(desired) < 3 then
  desired := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
end if;
-- …rest of the collision-suffix logic unchanged…
```

Since our sign-up flow (`AuthProvider.signUp`) always passes a `username`, the
fallback only fires for out-of-band signups (OAuth, magic link, admin-created),
which is exactly where a user never chose a handle and where leaking their email
would be worst.

---

## 7. Client surface (TypeScript)

**Honest caveat up front:** everything in this section is **cosmetic**. It hides
buttons and avoids doomed requests for a better UX. It enforces nothing. A user
can edit the bundle, call `supabase.from(...)` directly, or forge a request —
and RLS (§4) is what actually stops them. Never let a client check be the only
thing between a user and an action.

### 7.1 Read the role from the JWT

The hook injects the claim into the **token**, not into the user record
Supabase caches, so `session.user.app_metadata.role` is **not** reliably
populated for hook-minted claims. Decode the access token instead.

```ts
// src/auth/role.ts
export type AppRole = 'moderator' | 'admin';

/** Decode the middle segment of a JWT without a dependency. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pull the role claim the custom access-token hook wrote. */
export function roleFromAccessToken(accessToken: string | undefined): AppRole | null {
  if (!accessToken) return null;
  const claims = decodeJwtPayload(accessToken);
  const meta = (claims?.app_metadata ?? {}) as { role?: unknown };
  const raw = meta.role ?? claims?.user_role;
  return raw === 'admin' || raw === 'moderator' ? raw : null;
}

export const isModeratorRole = (r: AppRole | null): boolean =>
  r === 'moderator' || r === 'admin';
export const isAdminRole = (r: AppRole | null): boolean => r === 'admin';
```

### 7.2 Expose it on `useAuth()`

Add to `AuthContextValue` and derive from the session (recomputes whenever the
token refreshes, so a freshly-granted role appears after the next refresh):

```ts
// additions to AuthProvider.tsx
import { roleFromAccessToken, isModeratorRole, isAdminRole } from '@/auth/role';
import type { AppRole } from '@/auth/role';

interface AuthContextValue {
  // …existing fields…
  role: AppRole | null;
  isModerator: boolean;
  isAdmin: boolean;
}

// inside AuthProvider, alongside `user`:
const role = useMemo<AppRole | null>(
  () => roleFromAccessToken(session?.access_token),
  [session?.access_token],
);

// include in the memoized context value:
const value = useMemo<AuthContextValue>(
  () => ({
    session, user, profile, loading,
    role,
    isModerator: isModeratorRole(role),
    isAdmin: isAdminRole(role),
    signUp, signIn, signOut, refreshProfile,
  }),
  [session, user, profile, loading, role, signUp, signIn, signOut, refreshProfile],
);
```

### 7.3 `<RequireRole>` guard

```tsx
// src/auth/RequireRole.tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Cosmetic route gate. RLS is the real enforcement; this only spares the user a
 * dead-end screen. `admin` satisfies a `moderator` requirement (admin ⊃ moderator).
 */
export function RequireRole({
  role,
  children,
}: {
  role: 'moderator' | 'admin';
  children: ReactNode;
}) {
  const { loading, session, isModerator, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) return null; // or the same spinner RequireAuth uses
  if (!session) return <Navigate to="/signin" replace state={{ from: location }} />;

  const ok = role === 'admin' ? isAdmin : isModerator;
  if (!ok) return <Navigate to="/" replace />;

  return <>{children}</>;
}
```

Usage: gate the moderation dashboard route in
`<RequireRole role="moderator">…</RequireRole>`, and conditionally render
delete/merge buttons with `const { isModerator } = useAuth();`. If a forged
request slips past the missing button, the policies in §4 reject it — which is
the point.

---

## 8. Rejected designs (and why)

- **`profiles.role` column with the current self-update policy.** Rejected —
  §2. One-line self-escalation to admin. Even the column-grant fix leaves
  authorization co-located with user-editable data and requires perpetual
  vigilance on every future `GRANT`.
- **`REVOKE UPDATE (role) …` as the escalation fix.** Rejected — it's a **no-op**
  when `authenticated` holds table-level UPDATE (which stock Supabase grants).
  Must `REVOKE UPDATE` at table level then `GRANT UPDATE (col,…)`. This subtlety
  is exactly why the column-on-profiles approach is error-prone.
- **Enforcing "can't change role" purely in RLS `WITH CHECK`.** Rejected —
  impossible in the general case. RLS gates rows, not columns; column control is
  a different layer (GRANT or trigger).
- **Role in `auth.users.raw_app_meta_data`, no `user_roles` table.** Considered.
  It auto-surfaces into the JWT `app_metadata` claim with **no hook at all** —
  attractively simple. Rejected as the *primary* store because writing it
  requires the Admin API / `service_role` for every grant, and it isn't a
  first-class SQL table you can query, join, list in an admin UI, or add
  `granted_by`/`scope` columns to. Good enough for a single hard-coded admin;
  not for a system with moderators. `user_roles` + hook gives the same JWT-read
  ergonomics with a manageable source of truth.
- **Reading roles by joining `user_roles` in every policy (pure option b), no
  hook.** Not rejected — kept as the §4.3 fallback for zero-staleness. Not the
  default only because the hook removes the per-statement subquery and the app
  can tolerate ~1h propagation on grants.
- **"Trusted contributor" contribution-count tier; extra `curator` role;
  per-region moderators.** Rejected for v1 — §1. Attack surface / complexity
  without demonstrated need; schema leaves room to add later.
- **Cascading reviews to oblivion on account deletion.** Rejected — §6.1.
  Destroys community content and silently skews ratings. Anonymize to a sentinel
  instead.
- **Client-side role checks as enforcement.** Rejected categorically — §7. The
  anon key and all code are public; client guards are UX, RLS is security.

---

## Sources (verified July 2026)

- Custom Access Token Hook — signature, grants, purpose: <https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook>
- Auth Hooks overview — **Free-plan availability**, Postgres-vs-HTTP, Dashboard/config.toml enablement: <https://supabase.com/docs/guides/auth/auth-hooks>
- RBAC guide — `user_roles`/`role_permissions`, hook, `authorize()`, `auth.jwt()` claim reads, GRANT/REVOKE: <https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac>
- Custom Claims & app_metadata (user-immutable; `auth.jwt() -> 'app_metadata' ->> 'role'`): <https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac>
- RLS `(select …)` InitPlan optimization (once-per-statement): <https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv> and <https://github.com/orgs/supabase/discussions/14576>
- RLS general (`auth.uid()`, `auth.jwt()` in policies): <https://supabase.com/docs/guides/database/postgres/row-level-security>
- PostgreSQL privileges — column vs table-level union semantics; correct revoke-then-grant pattern: <https://www.postgresql.org/docs/current/ddl-priv.html> and <https://www.postgresql.org/docs/current/sql-revoke.html>
- Supabase grants ALL to `authenticated` → single-column revoke is a no-op: <https://github.com/orgs/supabase/discussions/7428>

**Marked unverified / verify locally:**
- ⚠️ The exact `config.toml` `[auth.hook.custom_access_token]` key + `pg-functions://` URI format against your installed CLI version.
- ⚠️ Direct `insert into auth.users (...)` for the sentinel row — permitted for a
  one-time `service_role` system row, but Supabase generally steers you to the
  Admin API; confirm your project allows it, or use the nullable-`author_id`
  variant which avoids touching `auth.users` entirely.
