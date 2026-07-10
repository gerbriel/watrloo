# Watrloo — Security & RLS Audit

Adversarial review of the data layer. Scope: `supabase/migrations/20260710000000_init.sql`,
`supabase/config.toml`, `src/lib/api/*.ts`, `src/lib/supabase.ts`, `src/auth/AuthProvider.tsx`,
`.env.example`, `.gitignore`.

> ## Remediation status
>
> This audit was written against the **first** migration. Several findings have
> since been fixed in `supabase/migrations/20260710010000_search_geo_privacy.sql`.
> The analysis below is preserved as originally written; **this table is
> authoritative for current state.**
>
> | ID | Finding | Status |
> | --- | --- | --- |
> | F1 | Username falls back to email local part | **Fixed** — opaque `user_<hex>`; the email is never read |
> | F2 | `review_photos.storage_path` unconstrained | **Fixed** — insert policy now requires the caller's `<uid>/` prefix |
> | F3 | No DELETE policy, no moderator role | **Open** — design in `USERS_AND_ROLES.md`, not applied |
> | F4 | Username collision TOCTOU | **Fixed** — insert-and-retry on `unique_violation` (5 attempts) |
> | F5 | NULL email skips the length guard | **Fixed** — `coalesce` before `char_length` |
> | F6 | Search term unbounded; `%`/`_` not neutralized | **Fixed** — replaced by the `search_bathrooms` RPC: bound parameter, term clamped to 100 chars, LIKE metacharacters escaped |
> | F7 | Unvalidated `avatar_url` | **Open** |
> | F8 / F9 | Public review-history correlation; no storage UPDATE policy | **Accepted by design** (see notes below) |

Threat model: the repo is **public** and the anon (publishable) key ships in the browser bundle
**by design**. Any attacker therefore has the anon key and can call PostgREST (`/rest/v1`),
GraphQL (`/graphql/v1`), Storage, and Auth directly — not just through the app UI. Every control
that matters must hold at the API boundary, not in the React code. RLS reads are intentionally
public (it's a directory); the audit assumes the attacker is an authenticated user with a
throwaway account (signup is open and email confirmation is **off**, see F3).

Platform behaviours asserted below were verified against primary sources; citations are inline.

---

## 1. Findings (ranked, most severe first)

| ID | Title | Severity | Status | One-line impact |
|----|-------|----------|--------|-----------------|
| **F1** | Username fallback seeds `profiles.username` from the email local-part into a world-readable table | Medium | Confirmed | Any username-less signup publishes the local part of the user's email as their public handle |
| **F2** | `review_photos.storage_path` is unconstrained text; insert policy checks only the parent review | Medium | Confirmed | A user can attach *any* object in the public bucket (incl. other users' / arbitrary paths) to their own review |
| **F3** | No moderation path: no DELETE policy on `bathrooms`, no moderator role, open signup | Medium | Confirmed | Any throwaway account can flood permanent junk bathrooms that nobody can delete via the API |
| **F4** | `handle_new_user` collision handling is not concurrency-safe and does not retry | Low | Confirmed | Concurrent same-username signups (or a double-collision) abort signup with an opaque 500 |
| **F5** | `handle_new_user` produces `NULL` username when `email` is NULL (guard doesn't catch NULL) | Low | Confirmed (latent) | If anonymous/phone signup is ever enabled, every such signup fails with a NOT-NULL violation |
| **F6** | Search term is unbounded and LIKE wildcards (`%` `_` `*`) are not neutralised | Low | Confirmed | Semantic match-broadening + potential seq-scan CPU burn on large datasets. **No** structural injection (see R2) |
| **F7** | `profiles.avatar_url` is unvalidated, world-readable, user-settable text | Low | Confirmed | Attacker can store arbitrary external/tracking URLs; `javascript:`/`data:` if ever rendered in an `href` |
| **F8** | Full public enumeration correlates a user's entire review history to their handle | Low / Info | Confirmed (largely by design) | `/rest/v1/profiles` + `reviews.author_id` lets anyone build a per-user activity/location profile |
| **F9** | No UPDATE policy on `storage.objects`, so `upsert: true` silently fails | Info | Confirmed | Not exploitable; documented so nobody "fixes" it by adding a loose UPDATE policy |

Refuted-but-scary hypotheses (things that look dangerous and are actually safe) are in §4.
Do not re-litigate them without reading that section.

---

## 2. Per-finding detail

### F1 — Email local-part leaks into the public `profiles.username` (Medium, Confirmed)

**Evidence.** `handle_new_user`, `20260710000000_init.sql:107-110`:

```sql
desired := coalesce(
  nullif(new.raw_user_meta_data ->> 'username', ''),
  split_part(new.email, '@', 1)      -- <-- fallback = the local part of the email
);
```

combined with the world-readable policy at `:157-158`:

```sql
create policy "profiles are viewable by everyone"
  on public.profiles for select using (true);
```

**Attack.** The React signup path (`AuthProvider.tsx:118-122`) always sends
`options.data.username`, so through the UI the fallback never fires. But the anon key is public,
so an attacker (or any integration, or a future OAuth/magic-link flow) can call the signup
endpoint directly with **no** username metadata:

```
POST /auth/v1/signup
{ "email": "jane.doe@bigcorp.com", "password": "…" }   # no options.data.username
```

The trigger then sets `username = split_part('jane.doe@bigcorp.com','@',1) = 'jane.doe'`, and
that value is immediately readable by everyone via `GET /rest/v1/profiles?select=username`. The
local part of a work email is very often `first.last` or `first_initial+last` — i.e. the user's
real name, published without consent.

**Why it works.** `profiles.id` is `auth.users.id` and reads are `using (true)`, so any row the
trigger writes is globally visible. The fallback derives a public identifier from PII.

**Severity rationale — Medium, not High.** The current app UI never triggers the fallback, so
today's *practical* exposure is limited to out-of-band signups. But the fallback is trivially
reachable (open signup endpoint, no email confirmation) and it leaks PII into a public table, and
it becomes a blanket leak the moment any username-less signup path (SSO, invite, admin import) is
added. That is a real, latent PII disclosure — Medium. It is **not** "the local part of *every*
user's email by default" as long as the UI is the only signup path; the doc corrects that framing
to keep the severity honest.

**Fix.** Never derive the handle from the email. Fall back to an opaque, collision-resistant
identifier. (Rolled into the consolidated function rewrite in §3, which also fixes F4/F5.)

```sql
-- fallback becomes: 'user_' || 8 hex chars, e.g. user_9f3a1c7d
```

**Residual risk.** Users who *choose* a handle equal to their email local part still publish it —
but that is their choice, not a default. None.

---

### F2 — `review_photos.storage_path` is attacker-chosen text (Medium, Confirmed)

**Evidence.** Column is plain text (`:69`): `storage_path text not null`. The insert policy
(`:203-210`) validates only the **parent review's ownership**, never the path:

```sql
create policy "users attach photos to their own reviews"
  on public.review_photos for insert to authenticated
  with check (
    exists (select 1 from public.reviews r
            where r.id = review_id and r.author_id = (select auth.uid()))
  );
```

**Attack.** Create a review I own, then insert a photo row on it whose `storage_path` points
anywhere:

```
POST /rest/v1/review_photos
{ "review_id": "<my review>", "storage_path": "<victim-uid>/private-ish.jpg" }
```

The `exists(...)` check passes (it's my review). `storage_path` is stored verbatim. The detail
page renders `publicPhotoUrl(storage_path)` (`photos.ts:47-50`), so another user's object — or any
arbitrary string that resolves under `/storage/v1/object/public/…` — is now displayed as *my*
review's photo.

**Why it works.** Photo ownership is enforced only through the review, and the pointer is
decoupled from the object it names. The Storage **upload** policy (`:236-241`) correctly forces
uploads under `<uid>/`, but nothing forces the **DB pointer** to reference an object the caller
actually owns or uploaded.

**Impact — Medium, not High.** The `review-photos` bucket is fully public (`:225-234`), so this is
**content spoofing / pointer-integrity abuse**, not a confidentiality breach: everything reachable
this way is already public. An attacker can (a) attribute someone else's photo to their own review,
(b) hotlink/craft misleading `../`-style keys, (c) bulk-insert junk pointers. Cross-user
*deletion* is still blocked — `deleteReviewPhoto` calls `storage.remove()`, which is gated by the
Storage delete policy's `(storage.foldername(name))[1] = auth.uid()` check (`:243-248`), so a
victim's path fails that check. So integrity/spoofing, capped at Medium.

**Fix.** Constrain the pointer to the caller's own prefix in the insert policy (an `auth.uid()`
check can't live in a table `CHECK` constraint because `auth.uid()` is `STABLE`, not `IMMUTABLE`).
See §3:

```sql
with check (
  exists (select 1 from public.reviews r
          where r.id = review_id and r.author_id = (select auth.uid()))
  and storage_path like ((select auth.uid())::text || '/%')   -- must be my folder
)
```

The uid is a UUID (hyphens only — no LIKE metacharacters), so the `like` prefix is exact.

**Residual risk.** A user can still point at a *non-existent* object under their own prefix, or at
another of their own objects. Acceptable; both are self-owned namespace. A stricter option is a
`BEFORE INSERT` trigger that verifies the object exists in `storage.objects` under the bucket, but
that couples the tables and is usually not worth it.

---

### F3 — No moderation path; permanent junk accumulates (Medium, Confirmed)

**Evidence.**
- `bathrooms` has SELECT/INSERT/UPDATE policies (`:170-180`) but **no DELETE policy**. With RLS
  enabled, a missing policy = deny; deletes affect 0 rows for everyone except the table owner /
  `service_role`.
- UPDATE is limited to `created_by` (`:177-180`), and `created_by uuid references public.profiles
  (id) on delete set null` (`:34`).
- Signup is open and unverified: `config.toml` → `enable_signup = true` and `[auth.email]
  enable_confirmations = false`.

**Attack.** Register throwaway accounts (email confirmation is off, so no working inbox is needed;
signup rate-limit is 30 per 5 min per IP, trivially rotated). Each account can `POST
/rest/v1/bathrooms` **without limit** — there is no per-row insert throttle. Every inserted row is
permanent: no client, not even the creator, can DELETE it. The directory fills with spam that only
a human with SQL/`service_role` access can remove.

**Second-order.** Two ways a bathroom becomes **uneditable by anyone, forever**:
1. Seed rows ship with `created_by = null` (`seed.sql:8`), and `auth.uid() = null` is never true.
2. When a creator deletes their auth account, `on delete set null` nulls `created_by`, orphaning
   the row into the same uneditable state.

**Impact — Medium.** Content-integrity / spam DoS with no in-band cleanup, plus permanent data rot.
Not Critical (no confidentiality/privilege impact), but it degrades the core product and has no
API-level remedy today.

**Fix.** Introduce a moderator role (an allowlist table + a `SECURITY DEFINER` predicate), give
moderators DELETE/UPDATE on any bathroom and DELETE on any review, and — deliberately — do **not**
give ordinary creators DELETE on bathrooms (a creator deleting a popular bathroom would cascade-
delete everyone else's reviews via `reviews … on delete cascade`, `:48`; that's a griefing vector,
so deletion stays moderator-only). Full SQL in §3.

**Residual risk.** Moderators are granted out-of-band (SQL/dashboard insert into `moderators`).
Spam can still be *created* faster than moderated; pair with an app-level insert rate limit or a
lightweight `before_user_created` hook / captcha if abuse appears. Enabling
`enable_confirmations = true` raises the cost of throwaway accounts.

---

### F4 — `handle_new_user` collision handling races and never retries (Low, Confirmed)

**Evidence.** `:117-122`:

```sql
if exists (select 1 from public.profiles p where p.username = desired) then
  desired := left(desired, 17) || '_' || substr(new.id::text, 1, 6);
end if;
insert into public.profiles (id, username) values (new.id, desired);
```

**TOCTOU under concurrency — Confirmed.** Two signups pick the same `desired = 'bob'` at nearly the
same time. Under the default `READ COMMITTED` isolation, each transaction's `EXISTS` sees only rows
committed before its statement began; neither sees the other's uncommitted profile row. **Both**
evaluate `exists(...) = false`, both skip the suffix branch, both attempt `insert … 'bob'`. The
unique index on `username` (`:11`) serialises them: the first commits; the second blocks on the
index, then receives `unique_violation`. Because the function has **no exception handler**, the
error propagates out of the `AFTER INSERT` trigger and aborts the enclosing `auth.users` insert.
The user sees Supabase's generic `500 — Database error saving new user`. The "suffix rather than
fail" intent (`:117`) is exactly what the race defeats.

**Non-retrying fallback — Confirmed.** Even single-threaded, the suffix
`left(desired,17) || '_' || substr(uuid,1,6)` is checked **zero** times. Its uniqueness rests on 6
hex chars (24 bits) of the user's UUID. If that suffixed handle *also* already exists, the insert
throws `unique_violation` and, again, signup fails. Not attacker-*targetable* (the victim's suffix
depends on the victim's server-generated UUID, which the attacker can't predict), so this is an
availability/robustness bug, not an integrity one — Low.

**Fix.** Insert inside a retry loop that catches `unique_violation` and re-rolls a fresh random
suffix. See §3.

**Residual risk.** After N retries the function re-raises (astronomically unlikely with random
suffixes). A PK conflict on `id` (trigger somehow firing twice for one user) would also exhaust the
loop and re-raise — correct, since retrying the username can't fix a duplicate id.

---

### F5 — NULL email produces a NULL username; the `< 3` guard doesn't catch it (Low, Confirmed latent)

**Evidence.** `:107-114`:

```sql
desired := coalesce(nullif(new.raw_user_meta_data ->> 'username',''),
                    split_part(new.email,'@',1));
desired := regexp_replace(desired, '[^a-zA-Z0-9_]', '', 'g');
if char_length(desired) < 3 then
  desired := 'user_' || substr(new.id::text, 1, 8);
end if;
```

**Attack / trigger condition.** If `new.email` is NULL and no username metadata is supplied, then:
`split_part(NULL,'@',1)` → `NULL`; `regexp_replace(NULL,…)` → `NULL`;
`char_length(NULL) < 3` evaluates to **NULL, which is not TRUE**, so the `if` body is skipped and
the fallback never fires; `left(NULL,24)` → `NULL`; `insert … values(new.id, NULL)` violates
`username … not null` → the signup transaction fails.

`auth.users.email` is NULL for **anonymous** and **phone-only** sign-ins. Current config disables
both (`enable_anonymous_sign_ins = false`, `[auth.sms] enable_signup = false`), so this is **latent,
not currently reachable** — status Confirmed-latent. It becomes a live "every such signup 500s" bug
the instant either is enabled.

**Fix.** Coalesce to `''` (never leave `desired` NULL) and don't reference `new.email` at all.
Folded into §3 (F1's rewrite drops email entirely and uses `coalesce(…, '')`).

**Residual risk.** None once the rewrite lands. Test to confirm current state (see §5).

---

### F6 — Unbounded search term + un-neutralised LIKE wildcards (Low, Confirmed)

**Evidence.** `src/lib/api/bathrooms.ts:82-98`:

```ts
function ilikeValue(term: string): string {
  const safe = term.replace(/[\\"]/g, '\\$&');   // escapes only \ and "
  return `"%${safe}%"`;
}
…
query = query.or(`name.ilike.${value},address.ilike.${value}`);
```

**Structural injection: refuted** (see R2 for the proof — the `\`/`"` escaping is exactly what
PostgREST requires, so `,` `)` `.` `:` inside the term stay literal and cannot break out of the
quoted value).

**What *is* wrong.**
1. **Wildcard injection.** `%`, `_`, and `*` are **not** escaped. PostgREST treats `*` as an alias
   for `%` ([PostgREST docs](https://postgrest.org/en/stable/references/api/tables_views.html)), and
   `%`/`_` are live `ILIKE` metacharacters. So a search for `50%` matches `50<anything>`, and a term
   of `%%%%%` (or `*****`) matches every row. Semantic only — the data is already public and
   paginated — but a literal search silently isn't literal.
2. **Unbounded length + forced seq scan.** `opts.search` is never length-capped. Every `ILIKE
   '%term%'` has a leading `%`, so no B-tree index applies and there is no trigram index — every
   search is a sequential scan over `bathrooms` on **two** columns (`name`, `address`). A long term
   packed with `%`/`_` alternations maximises `ILIKE` backtracking per row. On a large table this is
   a cheap CPU-burn request. Low today (small dataset), but it scales the wrong way.

**Fix (client-side; DB unaffected).** Cap length and neutralise LIKE metacharacters. The escaping is
two-layered (SQL `LIKE` escape = backslash, *then* PostgREST double-quote escape = backslash), so do
it in two ordered passes:

```ts
const MAX_SEARCH_LEN = 100;

function ilikeValue(term: string): string {
  const capped = term.slice(0, MAX_SEARCH_LEN);
  // Pass 1 — neutralise ILIKE wildcards (default LIKE escape char is backslash).
  //          %, _, and \ become \%, \_, \\ in the pattern the DB will match.
  const likeBody = capped.replace(/[\\%_]/g, '\\$&');
  const pattern = `%${likeBody}%`;              // outer % stay as the intended wildcards
  // Pass 2 — encode for PostgREST's double-quoted value (escape \ and ").
  const pgrst = pattern.replace(/[\\"]/g, '\\$&');
  return `"${pgrst}"`;
}
```

Worked example, term = `50%_\ "x` → returned value `"%50\\%\\_\\\\ \"x%"`; PostgREST unescapes to
the pattern `%50\%\_\\ "x%`, which `ILIKE` matches as the literal substring `50%_\ "x` (wildcards
neutralised, only the framing `%` remain). Note `*` no longer needs escaping once length is bounded,
but it is harmless to leave — a raw `*` still means "any" and users may expect that; if you want `*`
literal too, add it to the Pass-1 class: `/[\\%_*]/g`.

**Residual risk.** Leading-`%` scans remain un-indexed. If search volume grows, add a `pg_trgm` GIN
index on `name`/`address` and switch to a trigram-aware match. Consider a server-side length guard
too (a hostile client can bypass the JS cap), e.g. a PostgREST-facing RPC.

---

### F7 — Unvalidated, world-readable `avatar_url` (Low, Confirmed)

**Evidence.** `avatar_url text` (`:13`), no `CHECK`; updatable by the owner via `updateProfile`
(`profiles.ts:14-24`) under the `:164-167` update policy; readable by everyone (`:157-158`).

**Attack.** Set `avatar_url` to any string — an external tracker
(`https://evil.example/track?u=victim`), a huge remote image (client-side resource abuse for anyone
viewing the profile), a `data:` URI, or `javascript:…`. React escapes text and ignores
`javascript:` in `<img src>`, so this is Low; but if the value is ever placed in an `<a href>` or a
CSS `url()`, `javascript:`/`data:` become an XSS/exfil vector.

**Fix.** Require an https URL (blocks `javascript:`/`data:`), ideally pinned to your Storage host:

```sql
alter table public.profiles
  add constraint profiles_avatar_url_https
  check (avatar_url is null or avatar_url ~ '^https://[^ ]+$');
```

Stricter (env-specific): `check (avatar_url is null or avatar_url like
'https://<project-ref>.supabase.co/storage/v1/object/public/%')`. Included idempotently in §3.

**Residual risk.** Any https image URL is still allowed (tracking pixels). The stricter storage-only
form removes that; adopt it if avatars are always uploaded to your bucket.

---

### F8 — Enumeration correlates review history to identity (Low / Info, Confirmed, largely by design)

**Evidence.** `profiles` is world-readable (`:157-158`); `reviews` is world-readable (`:183-184`)
and carries `author_id` (`:49`). PostgREST embedding is enabled, so anyone can run:

```
GET /rest/v1/profiles?select=id,username,avatar_url,created_at        # full user directory
GET /rest/v1/reviews?select=*,author:profiles(username)&order=author_id
```

`max_rows = 1000` (`config.toml:18`) caps a page but `Range`/`offset` paginates the rest. The result
is a complete map of every user → every bathroom they reviewed, with timestamps and free-text — i.e.
a per-user behavioural/location profile. The raw `auth` UUID (`profiles.id`) is also exposed.

**Impact — Low / Info.** This is largely inherent to a public review directory (Yelp-style public
profiles). It is not a policy bug. Two things worth noting: (a) UUIDs are random v4, so the
enumeration is via *listing*, not *guessing* — you can't target a user by predicting their id; (b)
combined with F1, if any handle is an email local-part, the correlation attaches to a real identity.

**Mitigations (optional, product decisions).** Drop `id`/`author_id` from anon-facing selects behind
a view that only exposes `username`; or gate full review-history queries behind auth; or add
per-request caps. Fixing F1 removes the identity-linkage risk, which is the sharpest edge here.

**Residual risk.** Public directories are enumerable by nature; accept or curtail per product intent.

---

### F9 — No UPDATE policy on `storage.objects`; `upsert: true` silently fails (Info, Confirmed)

**Evidence.** The migration defines Storage `select`/`insert`/`delete` policies (`:232-248`) but no
`update` policy. Supabase Storage implements an upsert of an **existing** object as a row `UPDATE`
on `storage.objects`; with no UPDATE policy, RLS denies it for `authenticated`.

**Consequence.** `uploadReviewPhoto` uses `upsert: false` (`photos.ts:29`) with unique random keys,
so the app never hits this. But if anyone sets `upsert: true`, overwriting an **existing** object
fails with an RLS error (creating a *new* object still works via the INSERT policy). This is
**not** a vulnerability — it's fail-closed — and it is *why* one user cannot overwrite another's
object (see R4). Documented so nobody "fixes" the upsert ergonomics by adding a permissive UPDATE
policy and accidentally opening cross-user overwrite. If you truly need self-upsert, scope the
UPDATE policy to the owner's own prefix:

```sql
create policy "users update objects in their own folder"
  on storage.objects for update to authenticated
  using      (bucket_id = 'review-photos' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'review-photos' and (select auth.uid())::text = (storage.foldername(name))[1]);
```

---

## 3. Consolidated hardening migration

Drop into `supabase/migrations/` (e.g. `20260711000000_security_hardening.sql`). Written to be
re-runnable: policies are dropped-if-exists then recreated, tables/functions use
`if not exists`/`or replace`, the constraint is added inside a guard. **Review, then apply via your
normal migration flow — this doc does not apply it.**

```sql
-- ============================================================================
-- Watrloo security hardening
-- Fixes F1, F2, F3, F4, F5, F7. (F6 is a client-side change, see docs/ops/SECURITY.md §2.)
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- F1 + F4 + F5: rewrite handle_new_user
--   * fallback is opaque ('user_' + hex), never the email local part      (F1)
--   * insert inside a retry loop that re-rolls the suffix on collision     (F4)
--   * coalesce to '' so `desired` is never NULL, and never touch new.email (F5)
-- gen_random_uuid() is core (pg_catalog) in PG13+, so it resolves under
-- search_path = ''. All other refs are schema-qualified or pg_catalog built-ins.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  base    text;
  desired text;
  attempt int := 0;
begin
  base := regexp_replace(
            coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), ''),
            '[^a-zA-Z0-9_]', '', 'g');
  if char_length(base) < 3 then
    -- opaque, collision-resistant fallback (NOT derived from email)
    base := 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  end if;
  base    := left(base, 24);
  desired := base;

  loop
    begin
      insert into public.profiles (id, username) values (new.id, desired);
      return new;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 10 then
        raise;  -- astronomically unlikely with a random suffix; also covers a dup id
      end if;
      -- re-roll a fresh random suffix, staying within the 30-char username limit
      desired := left(base, 22) || '_' ||
                 substr(replace(gen_random_uuid()::text, '-', ''), 1, 7);
    end;
  end loop;
end;
$$;
-- trigger definition is unchanged (still on_auth_user_created); no need to recreate it.

-- ---------------------------------------------------------------------------
-- F2: constrain review photo pointers to the caller's own storage prefix.
-- (auth.uid() is STABLE, so it can live in a policy WITH CHECK but not in a
--  table CHECK constraint.)
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

-- ---------------------------------------------------------------------------
-- F3: moderator role + moderation policies.
-- Grant a moderator out-of-band:  insert into public.moderators values ('<uid>');
-- ---------------------------------------------------------------------------
create table if not exists public.moderators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.moderators enable row level security;
-- Intentionally NO policies: the table is readable/writable only by the table
-- owner / service_role. is_moderator() reads it as SECURITY DEFINER.

create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.moderators m where m.user_id = (select auth.uid())
  );
$$;

-- bathrooms: creator OR moderator may update; ONLY moderators may delete.
drop policy if exists "users update bathrooms they added" on public.bathrooms;
create policy "update bathrooms: creator or moderator"
  on public.bathrooms for update to authenticated
  using      ((select auth.uid()) = created_by or public.is_moderator())
  with check ((select auth.uid()) = created_by or public.is_moderator());

drop policy if exists "moderators delete bathrooms" on public.bathrooms;
create policy "moderators delete bathrooms"
  on public.bathrooms for delete to authenticated
  using (public.is_moderator());

-- reviews: keep author self-delete; add moderator delete (policies are OR-ed).
drop policy if exists "moderators delete any review" on public.reviews;
create policy "moderators delete any review"
  on public.reviews for delete to authenticated
  using (public.is_moderator());

-- ---------------------------------------------------------------------------
-- F7: require avatar_url to be an https URL (blocks javascript:/data:).
-- For a stricter lock, replace the regex with a LIKE on your storage host.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_avatar_url_https'
  ) then
    alter table public.profiles
      add constraint profiles_avatar_url_https
      check (avatar_url is null or avatar_url ~ '^https://[^ ]+$');
  end if;
end $$;

commit;
```

**F6 is not in the migration** — it is the client-side `ilikeValue` rewrite in §2 (F6).

---

## 4. Explicitly refuted (safe — do not re-litigate)

**R1 — `bathroom_stats` `security_invoker = on` is correct and load-bearing.**
Verified against the [PostgreSQL `CREATE VIEW` docs](https://www.postgresql.org/docs/current/sql-createview.html):
the default is `security_invoker = off`, and with it off, "if any of the underlying base relations
has row-level security enabled, then by default, the row-level security policies of the **view
owner** are applied." A view owned by the migration role (which owns the base tables) would thus
*bypass* RLS on `reviews`/`bathrooms`. Setting `= on` (`:79-80`) makes the view evaluate the
**querying** user's policies. For the *current* policy set it happens not to matter (both base
tables are `using (true)`), but the setting is exactly what prevents a leak if `reviews` is ever made
non-public. **Keep it. Do not remove it.**

**R2 — Search filter is not structurally injectable.**
The `.or()` value is `"%<term>%"` with `term.replace(/[\\"]/g,'\\$&')`. PostgREST requires reserved
characters inside a value to be double-quoted, and inside double quotes a literal `"` is written
`\"` and a literal `\` is written `\\`
([PostgREST tables/views ref](https://postgrest.org/en/stable/references/api/tables_views.html); the
`in`-operator examples show `\"`/`\\` escaping). The client does exactly that, so `,` `)` `.` `:`
inside the term are literal and cannot break out. PoC that *fails*: term
`%",name.ilike."x` → escaped to `%\",name.ilike.\"x` → value `"%%\",name.ilike.\"x%"`, which
PostgREST parses as the single quoted literal `%%",name.ilike."x%` — no second filter is injected.
Trailing-backslash breakout also fails: every `\` is doubled, so the framing closing quote is never
escaped (`\` → `"%\\%"`). The only residual is wildcard/length abuse — that's F6, not injection.

**R3 — `reviews.author_id → profiles(id)` indirection does not weaken the RLS check.**
`profiles.id` *is* `auth.users.id` (`:10`, 1:1, minted by the trigger), and `auth.uid()` returns the
JWT `sub` = `auth.users.id`. So `with check ((select auth.uid()) = author_id)` (`:186-188`) still
means "the review's author is me": the FK forces `author_id` to be a real profile id, and the policy
forces it to equal my uid — which is my own profile. There is no id under which an attacker can both
satisfy the FK and pass the check except their own. The `updated_at` touch trigger and the
`unique (bathroom_id, author_id)` upsert path don't change this. Safe.

**R4 — Storage per-user prefix cannot be escaped; no cross-user overwrite.**
Verified against the real `storage.foldername` definition
([supabase/storage schema](https://github.com/supabase/storage/blob/master/migrations/tenant/0002-storage-schema.sql)):
`string_to_array(name,'/')` then return all-but-last element. Traced against the upload check
`(storage.foldername(name))[1] = auth.uid()::text` (`:236-241`):

| crafted `name` | `foldername(name)` | `[1]` | insert allowed? |
|---|---|---|---|
| `uuid.jpg` (no slash) | `{}` | `NULL` | no (`NULL = uid` → not true) |
| `/uuid.jpg` (leading `/`) | `{''}` | `''` | no |
| `../<uid>/x.jpg` | `{'..','<uid>'}` | `'..'` | no |
| `<uid>/x.jpg` | `{'<uid>'}` | `'<uid>'` | yes (correct) |
| `<uid>/../<victim>/x.jpg` | `{'<uid>','..','<victim>'}` | `'<uid>'` | yes — **but** the key is stored **verbatim**; Storage does not path-normalise `..`, so it is a distinct object under *my* namespace, not `<victim>`'s object |

So `[1]` must equal the caller's uid, and no crafted name lets you write another user's exact key.
Overwriting a victim's *existing* object is doubly blocked: (a) that key's `[1]` isn't your uid, and
(b) an overwrite is a row UPDATE and there is no UPDATE policy (F9 / fail-closed). The app also uses
`upsert: false` with random UUID filenames. Safe.

**R5 — No secret leaks in the bundle or the repo.**
`src/lib/supabase.ts` reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; those are the
only `VITE_`-prefixed vars anywhere in `src`. `service_role` appears only in warning prose
(`README.md:28`, `.env.example:3`). The on-disk `.env.local` contains only those two `VITE_` keys —
no `service_role`, no service JWT (verified without printing values). `.gitignore` covers
`.env.local` twice (`*.local` at line 13 and an explicit `.env.local` at line 18), plus `.env` and
`.env.*.local`. Anon key in the client is correct by design; RLS is the enforcement boundary.

**R6 — `auth.users` is not reachable via the API.**
`config.toml:13` exposes only `schemas = ["public","graphql_public"]`. The `auth` schema is not
exposed to PostgREST/GraphQL, so `/rest/v1/…` cannot select `auth.users`, and PostgREST won't embed
across into an unexposed schema. Emails/password hashes stay server-side. (`extra_search_path`
includes `extensions` but that only affects request `search_path`, not API exposure.) The only
identity data reachable is what `profiles` deliberately exposes — see F1/F8.

**R7 — `set search_path = ''` does not break the trigger.**
`pg_catalog` is always implicitly searched regardless of `search_path`
([PG search-path docs](https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PATH)),
so built-ins (`regexp_replace`, `split_part`, `coalesce`, `gen_random_uuid`, casts, …) resolve.
Every non-catalog reference in the function is schema-qualified (`public.profiles`), which is exactly
why the empty search_path is safe *and* necessary (it blocks a `search_path`-hijack against the
`SECURITY DEFINER` function). Good hardening — keep it. The profile row is minted despite the
`"users insert their own profile"` policy because the function runs as its owner (the table owner),
and RLS is not enforced for the table owner unless `FORCE ROW LEVEL SECURITY` is set (it isn't) —
so that client-facing INSERT policy on `profiles` is effectively dead code (harmless; could be
dropped).

---

## 5. Tests to confirm the "Suspected/latent" items

These require a DB you control (local `supabase start`); do not run against production.

- **F5 (NULL email).** With the *current* trigger, create an `auth.users` row with `email = NULL`
  and no `raw_user_meta_data.username` (e.g. enable anonymous sign-in locally and call
  `signInAnonymously`). Expect the signup to fail with a NOT-NULL violation on `profiles.username`.
  After applying §3, expect it to succeed with `username` = `user_<8 hex>`.
- **F4 (race).** Fire two concurrent signups with identical `username` metadata (two parallel
  `/auth/v1/signup` calls). With the current trigger, expect one `500 Database error saving new
  user`. After §3, expect both to succeed, the second with a random `_<hex>` suffix.
- **F2.** As user A, `POST /rest/v1/review_photos` on A's own review with
  `storage_path = "<B-uid>/x.jpg"`. Before §3: inserts. After §3: rejected by the WITH CHECK
  (`storage_path` not under A's prefix).
- **F6.** `GET /rest/v1/bathrooms?or=(name.ilike."%50\%%")` style requests; confirm a `%` in the
  term matches literally only after the client fix, and that a 100-char cap is enforced.

---

*Prepared as a static audit of the migration and client code. No live database was queried and no
source/config/migration files were modified; all fixes are proposals in this document.*
