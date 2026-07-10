# Watrloo — SQL Validation

Every SQL block proposed across the six ops docs was executed against the **live**
hosted database inside explicit `BEGIN … ROLLBACK` transactions (never committed).
Functions were not just created but **called**; policies were exercised with a
simulated authenticated user; triggers were fired; EXPLAIN plans were captured on
throwaway data. After every session the invariants held:
`select count(*) from public.bathrooms` = **10**, `public.profiles` = **1**,
`public.reviews` = **0** (see the environment note — profiles was already 1 at
baseline, not 0; nothing I ran changed any count).

> Method note: I simulated an authenticated request with
> `select set_config('request.jwt.claims', '{"sub":"…","app_metadata":{"role":"admin"}}', true)`,
> which is exactly what PostgREST does per request — so `auth.uid()` / `auth.jwt()`
> return real values inside functions, triggers, and RLS predicates. Throwaway rows
> (users, bathrooms, reviews, photos) were generated inside the rolled-back
> transactions to exercise runtime behavior; a couple of tests updated/deleted the
> single existing profile **inside a rolled-back transaction** to fire a trigger —
> flagged inline where it happened. Nothing persisted.

**Environment**
- Client: `psql (PostgreSQL) 17.10 (Homebrew)` (`/opt/homebrew/opt/postgresql@17/bin/psql`).
- Server: `PostgreSQL 17.6 on x86_64-pc-linux-gnu` (Supabase, `…pooler.supabase.com:5432`).
- Connected role: `postgres` — **not** a superuser (`rolsuper = f`) but **has `BYPASSRLS`**,
  is a member of `pg_read_all_data`, and holds `SELECT/INSERT/UPDATE/DELETE/TRIGGER`
  on `storage.objects` (though it does **not** own it; owner is `supabase_storage_admin`).
- Extensions **installed**: `postgis 3.3.7`, `pg_trgm 1.6`, `pg_stat_statements 1.11`,
  `pgcrypto 1.3` (all in schema `extensions`).
- Extensions **available and installable but not installed**: `pg_cron 1.6.4`, `pg_net 0.20.3`
  (both `create extension` cleanly as `postgres` — confirmed in a rollback txn).
- `postgres` role `search_path` = `"$user", public, extensions` (this is why unqualified
  PostGIS operators resolve at runtime).

---

## 1. Verdict table (failures / blockers first)

| Doc | SQL block | Verdict | One-line reason |
|-----|-----------|---------|-----------------|
| AVAILABILITY | F9 Fix A — `reap_review_photo_objects` BEFORE DELETE on `reviews` | **WOULD BREAK SOMETHING** | `delete from storage.objects` is blocked by the platform's `storage.protect_delete()` trigger → **aborts every deletion of a review that has photos**. |
| USERS_AND_ROLES | §3.3 role migration **as written** | **FAILS** | Policy `"admins read all roles"` calls `public.is_admin()` which isn't defined until §4.1 → `ERROR: function public.is_admin() does not exist`. Passes when reordered. |
| OBSERVABILITY | §2.1 `client_errors_guard` trigger | **FAILS** | `current_setting('request.headers', true)::json` throws `invalid input syntax for type json` because that GUC's default is the **empty string** in this project (not NULL). One-line `nullif()` fix verified. |
| USERS_AND_ROLES | §6.1 sentinel seed | **FAILS (intent)** | `on_auth_user_created` front-runs the explicit insert, so the sentinel gets a random `user_<hex>` handle, **not** `deleted_user`; the `on conflict do nothing` then no-ops. Fix verified. |
| USERS_AND_ROLES | §2.5 `forbid_self_role_change` trigger | **FAILS (partial)** | Fires correctly, but its `service_role` escape hatch never works: `current_setting('request.jwt.claim.role', true)` is **empty** even for service-role writes → it would block *all* role changes. Moot under the recommended no-`role`-column design. |
| SCALING | §2.2 `bathrooms_in_bounds` **as written** | **PASSES (fragile)** | Runs under the real runtime (extensions in `search_path`), but unqualified `::geography` / `&&` throw `type "geography" does not exist` under `search_path=''`. Hardened form verified. |
| SCALING | §2.1–2.3 EXPLAIN claims | **PARTIALLY CONFIRMED** | geog-GiST AFTER plan is exactly as claimed; the btree "BEFORE" plan is **better** than predicted (lng is an Index Cond, not a filter); trigram index is usable but the planner keeps a seq scan until ≫5k rows. |
| SECURITY | §3 `handle_new_user` rewrite (F1/F4/F5) | **ALREADY APPLIED** | Live `handle_new_user` (migration `20260710010000`) already does opaque fallback + insert-and-retry. The rewrite is equivalent; re-running it is a harmless no-op. |
| SECURITY | §3 `review_photos` insert policy (F2) | **ALREADY APPLIED** | Identical to the `storage_path like '<uid>/%'` policy already live from migration `20260710010000`. |
| SECURITY | §3 F3 `moderators` + `is_moderator()` + policies | **PASSES** but **CONFLICTS** | Works, but defines a *different* `public.is_moderator()` than USERS_AND_ROLES (moderators table vs `user_roles`/JWT). Ship one, not both. |
| SECURITY | §3 F7 `profiles_avatar_url_https` constraint | **PASSES** | The one existing profile has `avatar_url IS NULL`, so the check validates cleanly. |
| USERS_AND_ROLES | §2.4 REVOKE-UPDATE claim | **PASSES (proven)** | Naive `revoke update (role)` is a **no-op**; the `revoke update … / grant update (username, avatar_url)` form works. Empirically demonstrated. |
| USERS_AND_ROLES | §3.3 (reordered) `user_roles` + hook + grants | **PASSES** | Table, RLS, `supabase_auth_admin` grants, and `custom_access_token_hook` all create and the hook injects `app_metadata.role` + `user_role` when called. |
| USERS_AND_ROLES | §4.1 JWT helpers / §4.3 table-lookup helpers | **PASSES** | Both variants return correct results at runtime; `auth.jwt()`/`auth.uid()` resolve under `search_path=''`. |
| USERS_AND_ROLES | §4.4 rewritten policies | **PASSES** | Require `reviews.deleted_at` (§5.1) to exist first — ordering constraint noted. |
| USERS_AND_ROLES | §5.1 soft-delete cols + `bathroom_stats` redef | **PASSES** but **CONFLICTS** | Works; competes with SCALING's `bathroom_stats` redefinition (see §4). |
| USERS_AND_ROLES | §5.2 `reports`, §5.3 `moderation_actions`, §5.4 RPC | **PASSES** | Tables, policies, and the `moderate_soft_delete_review` RPC all work end-to-end (soft-deletes + writes an audit row). |
| USERS_AND_ROLES | §6.1 `anonymize_on_profile_delete` trigger | **PASSES** | Reassigns a departing user's reviews to the sentinel instead of cascade-deleting them. |
| USERS_AND_ROLES | §6.2 `rate_limit_username` trigger | **PASSES** | Second rename within 30 days raises; first stamps `username_changed_at`. |
| RATE_LIMITING | §2.1 `rate_limits` + §2.2 `check_rate_limit` | **PASSES** | Raises `sqlstate PT429` on over-limit; no-ops when `auth.uid()` is null. |
| RATE_LIMITING | §3.1 review AFTER-INSERT / §3.2 bathroom BEFORE-INSERT triggers | **PASSES** | 11th review and 6th bathroom raise PT429 from inside the trigger. |
| RATE_LIMITING | §3.3 `write_allowed` | **PASSES** | Returns true for a >2-min-old profile. |
| RATE_LIMITING | §7.1 `under_photo_quota` + storage upload policy swap | **PASSES** | Dropping + recreating the `storage.objects` upload policy works as `postgres`. |
| RATE_LIMITING | §7.2 `enforce_photo_caps` (PT413) + enqueue trigger + queue table | **PASSES** | 5th photo per review raises PT413; delete enqueues the path. |
| RATE_LIMITING | "trigger on `storage.objects` is flaky / `42501 must be owner`" | **DISPROVEN here** | `CREATE TRIGGER` on `storage.objects` **succeeds** as this `postgres` role (has `TRIGGER` priv). Not needed anyway — the RLS-policy path (§7.1) is what's used. |
| RATE_LIMITING / OBSERVABILITY | `cron.schedule(...)`, `net.http_post(...)` | **NOT VALIDATABLE** | `pg_cron`/`pg_net` install cleanly, but scheduling and outbound HTTP are side-effecting and excluded from rollback testing. |
| OBSERVABILITY | §2.1 `client_errors` table/RLS + §4 `health_checks` | **PASSES** | Insert policy, admin select policy, and the health-check insert body all work. |
| AVAILABILITY | F9 Fix B orphan-finder query | **PASSES (read-only)** | The `not exists` sweep runs; **but** the follow-up "delete each via `storage.objects`" hits the same `protect_delete` block — must go through the Storage API. |
| AVAILABILITY | F8 `profiles.deleted_at` + anonymize-in-place update | **PASSES** | Column adds; the anonymizing `UPDATE` works. (Competes with USERS §6.1 — see §4.) |
| AVAILABILITY | F2 read-only recovery (`set … ; vacuum; set …`) | **PARTIAL** | The two `SET` statements parse/execute; `VACUUM` is **NOT VALIDATABLE** (cannot run in a txn; not run). |
| AVAILABILITY | restore-drill `set session_replication_role = replica` | **PASSES** | Works as this `postgres` role despite it not being a true superuser. |

---

## 2. Failures in detail (with real output + verified fix)

### 2.1 AVAILABILITY F9 Fix A — reap trigger aborts review deletion (WOULD BREAK SOMETHING)

The platform installs a `BEFORE DELETE FOR EACH STATEMENT` trigger `protect_objects_delete`
on `storage.objects` that unconditionally blocks direct deletes:

```
tgname                    | def
--------------------------+--------------------------------------------------------------
protect_objects_delete    | ... BEFORE DELETE ON storage.objects ... EXECUTE FUNCTION storage.protect_delete()
```

The proposed `reap_review_photo_objects()` runs `delete from storage.objects …` in a
`BEFORE DELETE` trigger on `reviews`. Attempting to delete a review that has a photo:

```
ERROR:  Direct deletion from storage tables is not allowed. Use the Storage API instead.
HINT:  This prevents accidental data loss from orphaned objects.
CONTEXT:  PL/pgSQL function storage.protect_delete() line 5 at RAISE
SQL statement "delete from storage.objects
  where bucket_id = 'review-photos'
    and name in (select storage_path from public.review_photos where review_id = old.id)"
PL/pgSQL function public.reap_review_photo_objects() line 3 at SQL statement
```

**Why it's worse than "doesn't work":** because the trigger is `BEFORE DELETE` on
`reviews`, the raised exception **aborts the whole review deletion**. Shipping this
trigger makes it impossible to delete any review that has photos — a live availability
regression, not a dead no-op.

**Corrected approach (verified):** do **not** delete from `storage.objects` in SQL.
Reuse RATE_LIMITING's pattern instead — enqueue the paths and let a Storage-API caller
free the bytes:

```sql
create trigger review_photos_enqueue_deletion
  after delete on public.review_photos
  for each row execute function public.enqueue_photo_object_deletion();
-- ON DELETE CASCADE from reviews removes review_photos rows, which fires this and
-- captures each storage_path into public.pending_object_deletions.
```

I re-ran the RATE_LIMITING enqueue trigger this way and confirmed the storage path is
captured on delete with **no** `protect_delete` error:

```
=== §7.2 pending_object_deletions captured the path on delete ===
                storage_path
---------------------------------------------
 97ceeb8e-…/x.webp
```

RATE_LIMITING §7.2 already reaches this conclusion; AVAILABILITY F9 Fix A contradicts it
and must be dropped.

### 2.2 USERS_AND_ROLES §3.3 — forward reference to `is_admin()` (FAILS as written)

Running §3.3 verbatim:

```
CREATE POLICY        -- "users read their own roles"
ERROR:  function public.is_admin() does not exist
HINT:  No function matches the given name and argument types...
```

The `"admins read all roles"` policy references `public.is_admin()`, but that helper is
only created later in §4.1. **Fix:** create the §4.1/§4.3 helpers **before** the §3.3
policies (as done in the assembled migration in §5). With the helpers first, the entire
role migration applies and the `custom_access_token_hook` runs correctly:

```
### run the hook with an admin user_roles row seeded ###
hook_output
{"claims": {"user_role": "admin", "app_metadata": {"role": "admin"}}, "user_id": "…"}
```

### 2.3 OBSERVABILITY §2.1 `client_errors_guard` — empty-string GUC breaks the cast (FAILS)

`request.headers` is a **pre-registered** GUC in this project whose default is the empty
string, not NULL — so `current_setting('request.headers', true)` returns `''`, and
`''::json` throws. Any insert into `client_errors` from a context where PostgREST hasn't
populated the header (SQL editor, `service_role`, a `pg_cron` write) fails:

```
ERROR:  invalid input syntax for type json
DETAIL:  The input string ended unexpectedly.
CONTEXT:  PL/pgSQL function public.client_errors_guard() line 2 during statement block local variable initialization
```

This directly defeats the doc's "fire-and-forget, never error the client" intent.

**Fix (verified):** wrap the setting in `nullif(…, '')` before the cast:

```sql
declare
  fwd text := nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for';
```

Re-tested both branches:

```
-- no header set (default ''):  INSERT 0 1, client_ip = NULL   (no error)
-- x-forwarded-for present:     INSERT 0 1, client_ip = 203.0.113.7
```

### 2.4 USERS_AND_ROLES §6.1 sentinel seed — wrong sentinel handle (FAILS intent)

The seed relies on the plain `insert into public.profiles (…,'deleted_user')`, but the
`on_auth_user_created` trigger fires on the preceding `insert into auth.users` and mints
the profile first with an opaque handle; the explicit insert then no-ops on conflict:

```
INSERT 0 1     -- auth.users
INSERT 0 0     -- profiles insert no-ops (trigger already created the row)
id                                   | username
-------------------------------------+-----------------
00000000-0000-0000-0000-000000000000 | user_48cdbe98eb   -- NOT 'deleted_user'
```

The sentinel would render as a random `user_…` instead of "[deleted]".

**Fix (verified):** force the handle with `on conflict (id) do update`:

```sql
insert into public.profiles (id, username)
values ('00000000-0000-0000-0000-000000000000', 'deleted_user')
on conflict (id) do update set username = 'deleted_user';
-- -> username = deleted_user
```

### 2.5 USERS_AND_ROLES §2.5 `forbid_self_role_change` — dead service_role bypass (FAILS partial)

The trigger fires correctly (proven: a `role` change raises `role may not be changed here`).
But its guard reads the wrong GUC. PostgREST populates `request.jwt.claims` (the whole
JSON); it does **not** populate the legacy per-claim `request.jwt.claim.role`:

```
select set_config('request.jwt.claims','{"sub":"…","role":"service_role"}', true);
 singular_claim_role |                    full_claims
---------------------+----------------------------------------------------
 (empty)             | {"sub":"…","role":"service_role"}
```

So `current_setting('request.jwt.claim.role', true) is distinct from 'service_role'` is
**always true**, and the trigger would raise even on a legitimate `service_role` write —
the escape hatch never opens. If you ever adopt the (rejected) `profiles.role` design,
read `current_setting('request.jwt.claims', true)::jsonb ->> 'role'` instead. Under the
recommended `user_roles` design there's no `role` column, so this trigger isn't needed.

### 2.6 SCALING §2.2 `bathrooms_in_bounds` — unqualified `::geography` / `&&` (PASSES, fragile)

Works under the real runtime (10/10 seed rows returned for a US viewport), but the
function sets **no** `search_path`, so it depends on `extensions` being on the path. Force
it off and it breaks:

```
set local search_path = public;
select count(*) from public.bathrooms_in_bounds(24, -125, 50, -66);
ERROR:  type "geography" does not exist
LINE 3: ...velope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
```

This is inconsistent with the migration-`20260710010000` hardening pattern (every other
function sets `search_path=''` and schema-qualifies PostGIS). It also omits the
`grant execute … to anon, authenticated` the other RPCs include (it works only via the
default `PUBLIC` execute grant), and a `>180°`-wide envelope raises
`Antipodal (180 degrees long) edge detected!` for `geography`.

**Hardened form (verified to run under `search_path=''`):**

```sql
create or replace function public.bathrooms_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
) returns setof public.bathrooms language sql stable set search_path = '' as $$
  select b.* from public.bathrooms b
  where b.geog operator(extensions.&&)
        extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::extensions.geography;
$$;
grant execute on function public.bathrooms_in_bounds(double precision,double precision,double precision,double precision)
  to anon, authenticated;
```

---

## 3. Claims settled empirically

### 3.1 The `REVOKE UPDATE` claim (USERS_AND_ROLES §2.4) — CONFIRMED

With a dummy `role text` column added to `profiles` in a rollback txn:

```
BASELINE:                          has_column_privilege(authenticated, role, UPDATE) = t
after  revoke update (role) ...  : has_column_privilege(authenticated, role, UPDATE) = t   <-- NO-OP
after  revoke update on profiles ; grant update (username, avatar_url):
        role     -> f     username -> t     avatar_url -> t
```

The naive column-level `revoke` is a no-op because `authenticated` holds **table-level**
`UPDATE` (confirmed in `information_schema.role_table_grants`). Only dropping the table
grant and re-granting specific columns removes `role`. **The doc is correct.**
Bonus: `anon` also holds table-level `UPDATE/INSERT/DELETE` on `profiles`, so the doc's
"`-- also drop anon if it was ever granted`" comment is warranted (RLS still blocks anon,
but the grant exists).

### 3.2 Trigger on `storage.objects` (the "42501 must be owner" question) — DISPROVEN here

`postgres` has `has_table_privilege('postgres','storage.objects','TRIGGER') = t`, and
`CREATE TRIGGER … ON storage.objects` **succeeds** in a rollback txn. The RATE_LIMITING
"flaky, don't depend on it" caveat does not reproduce on this project as this role. (It's
irrelevant anyway — the quota uses an RLS **policy** on `storage.objects`, and
`DROP POLICY … ; CREATE POLICY …` on it also succeeds.) What *is* firmly blocked is
**direct DELETE** from `storage.objects` (via `storage.protect_delete()`, see §2.1).

### 3.3 `pg_cron` / `pg_net` availability — INSTALLABLE

```
create extension if not exists pg_cron;  -> pg_cron 1.6.4
create extension if not exists pg_net;   -> pg_net  0.20.3
```

Both install cleanly as `postgres` (rolled back). Neither is currently installed. The
`cron.schedule(...)` / `net.http_post(...)` call bodies were **not** executed (side
effects; out of scope for rollback testing).

### 3.4 `auth.uid()` / `auth.jwt()` in functions, triggers, RLS — WORKS

With `request.jwt.claims` set, `auth.uid()` and `auth.jwt()->'app_metadata'->>'role'`
return the expected values inside `security definer` functions (`is_moderator`,
`check_rate_limit`, `moderate_soft_delete_review`), inside triggers
(`enforce_bathroom_rate_limit`), and inside RLS predicates. Both resolve under
`search_path=''` (they're schema-qualified as `auth.*`). With no JWT they return NULL,
and the rate limiter correctly no-ops (trusted/service context).

### 3.5 `PT429` / `PT413` — raise + SQLSTATE confirmed; HTTP mapping not round-tripped

`raise sqlstate 'PT429'` and `'PT413'` propagate with the intended `message`/`detail`/`hint`
and SQLSTATE (captured with `\set VERBOSITY verbose`):

```
ERROR:  PT429: too fast (bathroom_hour)
HINT:  RATE_LIMITED
ERROR:  PT413: max 4 photos
HINT:  QUOTA_EXCEEDED
```

`supabase-js` surfaces the SQLSTATE as `error.code`, so `'PT429'`/`'PT413'` reach the
client as claimed. The `PTxyz → HTTP 4xx` status mapping is documented PostgREST behavior
that I did **not** round-trip: verifying it needs a **committed** function PostgREST can
see, and I never commit. Treat the HTTP-status half as documented-but-unverified here.

### 3.6 EXPLAIN plans (SCALING §2.1–2.3) — real plans on 5,010 rows

Generated ~5,000 throwaway bathrooms and `ANALYZE`d inside the rollback txn.

**Bounds — current lat/lng btree (small viewport):**
```
Sort (Sort Key: created_at DESC)
  -> Index Scan using bathrooms_lat_lng_idx on bathrooms  (rows=4)
       Index Cond: lat >= 40 AND lat <= 41 AND lng >= -74 AND lng <= -73
```
**Bounds — btree, wide-longitude strip:**
```
Bitmap Heap Scan on bathrooms   (rows=203)
  -> Bitmap Index Scan on bathrooms_lat_lng_idx
       Index Cond: lat >= 40 AND lat <= 41 AND lng >= -125 AND lng <= -66
```
Both put **lng in the `Index Cond`**, not in a `Filter` with "Rows Removed" — so the
doc's pessimistic "BEFORE" plan (seq scan / large filter) overstates the problem at this
scale. The btree is doing more than the doc credits it for.

**Bounds — proposed geog `&&` GiST:**
```
Index Scan using bathrooms_geog_idx on bathrooms b   (rows=1)
  Index Cond: geog && '0103…'::geography
```
Exactly the doc's "AFTER" plan — a true 2-D index probe. Confirmed.

**Search — trigram:** with a term matching everything the planner (correctly) seq-scans;
with a **selective** term (`%zanzibar%`, 3 of 5,010 rows) it *still* seq-scans at this size
(`cost=162, rows=1`) because the GIN trigram scan's startup cost loses to a 5k-row seq
scan. Forcing `enable_seqscan=off` proves the indexes **are** usable and produce exactly
the doc's plan:
```
Bitmap Heap Scan on bathrooms
  -> BitmapOr
       -> Bitmap Index Scan on bathrooms_name_trgm_idx     (Index Cond: name ~~* '%coffee%')
       -> Bitmap Index Scan on bathrooms_address_trgm_idx  (Index Cond: address ~~* '%coffee%')
```
So the trgm index is correct and ready, but it only becomes the planner's choice once the
table is much larger than 5k rows — matching the doc's own "search is only slow at scale /
priority: medium" caveat.

### 3.7 `bathroom_stats` slim view vs the client contract (SCALING §2.1) — MATCHES

The slim view emits `bathroom_id, review_count, avg_rating, avg_cleanliness, avg_privacy,
avg_accessibility` with `review_count::int` and `avg_* numeric`, and `NULL` avgs when the
relevant count is 0. That matches `BathroomStats` in `src/types/db.ts` and the
`normalizeStats`/`toNum` coercion in `src/lib/api/bathrooms.ts` exactly — `attachStats`'s
`.from('bathroom_stats').select('*').in('bathroom_id', ids)` keeps working verbatim.

### 3.8 `set session_replication_role = replica` (AVAILABILITY restore drill) — WORKS

Despite `postgres` not being a true superuser, `set session_replication_role = replica`
succeeds and reports `replica`. The Mode-B restore drill's key step is valid on this project.

---

## 4. Cross-document conflicts & ordering constraints

An implementer applying these docs naively, in the wrong order, gets a broken database.
The real conflicts:

1. **`public.is_moderator()` is defined twice, incompatibly.**
   SECURITY §3 defines it over a `moderators` table; USERS_AND_ROLES §4 defines it over
   `user_roles` (JWT or table-lookup). Same signature → whichever migration runs last
   silently wins. **Pick one role model.** (The assembled migration in §5 uses the
   USERS_AND_ROLES `user_roles` model and drops SECURITY's `moderators` table + helper.)

2. **`bathroom_stats` is redefined twice, incompatibly, and the two features interact
   badly.**
   - SCALING §2.1 replaces it with a **slim, non-aggregating** view over denormalized
     counter columns.
   - USERS_AND_ROLES §5.1 replaces it with the **aggregating** view plus
     `and r.deleted_at is null`.
   Last `create or replace view` wins. Worse: if you take **both** SCALING's counters
   **and** USERS's soft-delete, the counters are wrong — `apply_review_delta` maintains
   `review_count`/sums on row INSERT/UPDATE/DELETE, but a **soft-delete is an `UPDATE`
   setting `deleted_at`**, which `apply_review_delta` does not treat as a removal, so
   soft-deleted reviews **stay in the averages**. Reconcile by choosing one:
   (a) aggregating view + `deleted_at` filter (correct, simpler — what §5 ships), or
   (b) counters **plus** a soft-delete-aware `apply_review_delta` (extra work the docs
   don't provide).

3. **Two different account-deletion designs.**
   USERS_AND_ROLES §6.1 (anonymize reviews to a `deleted_user` sentinel, hard-delete the
   profile) vs AVAILABILITY F8 (`profiles.deleted_at`, anonymize the profile **in place**,
   never delete `auth.users`). Both work in isolation; they're mutually exclusive product
   choices. Don't ship both triggers/columns expecting them to compose.

4. **Multiple triggers pile onto `reviews`.** `reviews_touch_updated_at` (live),
   `reviews_rate_limit` (RATE §3.1, AFTER INSERT), `reviews_maintain_stats` (SCALING,
   AFTER INS/UPD/DEL), and the **broken** `reviews_reap_photos` (AVAILABILITY F9 — drop
   it). They can coexist by name, but see conflict #2 for the maintain-stats × soft-delete
   interaction, and §2.1 for why the reap trigger must be excluded.

5. **Intra-doc ordering rules that must be honored:**
   - Helpers `is_admin()`/`is_moderator()` **before** any policy that references them
     (USERS §3.3 as written violates this — see §2.2).
   - `reviews.deleted_at` (§5.1) **before** the reviews SELECT policy that filters on it
     (§4.4).
   - `user_roles` table **before** the helpers' table-lookup variant, and before the hook.

6. **OBSERVABILITY's `is_admin()` sketch reads `profiles.role`**, which does **not** exist
   under the recommended USERS_AND_ROLES design (no `role` column). Use USERS_AND_ROLES'
   `user_roles`-based `is_admin()`; the OBSERVABILITY admin/health policies then work
   unchanged (they only call `public.is_admin()`).

---

## 5. Assembled, ordered, de-duplicated migration (only what passed)

This is the union of the **passing** blocks in an order that applies cleanly. I ran this
**entire block** in one `BEGIN … ROLLBACK` transaction against the live DB; it applied with
no errors and every capstone assertion passed:

```
### sentinel username -> deleted_user
### is_admin -> t, is_moderator -> t   (simulated jwt, table-lookup helpers)
### moderate_soft_delete_review -> review soft_deleted = t, audit row written
### bathroom_stats review_count for the soft-deleted review's bathroom -> 0  (hidden)
### bathrooms_in_bounds (hardened, search_path='') -> 10 rows
```

**Excluded, and why:**
- SECURITY `handle_new_user` rewrite + F2 policy — **already live** (migration `20260710010000`).
- SECURITY `moderators` table + its `is_moderator()` — **superseded** by `user_roles` (conflict #1).
- SCALING counter columns + `apply_review_delta` + counter-based slim view — **deferred**:
  they conflict with soft-delete (conflict #2). Adopt later *with* a soft-delete-aware
  trigger. The aggregating `deleted_at`-filtered view is used instead.
- AVAILABILITY F9 Fix A reap trigger — **would break review deletion** (§2.1).
- USERS_AND_ROLES §2.5 `forbid_self_role_change` and the whole `profiles.role` path —
  not needed under the no-`role`-column design; and the trigger's service_role bypass is
  broken (§2.5).
- `custom_access_token_hook` — optional; the table-lookup helpers work with **zero** hook
  setup and give immediate role revocation. Keep the hook + JWT helpers only if you want
  join-free RLS and accept ~1h staleness (both variants were verified).
- All `cron.schedule(...)` / `net.http_post(...)` — install `pg_cron`/`pg_net` and add
  these as a **separate** step (side-effecting; not rollback-testable).
- Enabling the auth hook and setting Dashboard `max-rows` — not SQL.

```sql
-- ============================================================================
-- Watrloo consolidated hardening + roles + rate-limiting + observability
-- Depends on: 20260710000000_init.sql, 20260710010000_search_geo_privacy.sql
-- Verified end-to-end (apply order proven) against the live DB in a rolled-back txn.
-- ============================================================================
begin;

-- ---- A. Role system (USERS_AND_ROLES §3.3) --------------------------------
create type public.app_role as enum ('moderator', 'admin');
create table public.user_roles (
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.app_role not null,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);
alter table public.user_roles enable row level security;

-- ---- B. Helpers FIRST (table-lookup variant → immediate correctness) ------
create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles ur
                 where ur.user_id = auth.uid() and ur.role in ('moderator','admin'));
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles ur
                 where ur.user_id = auth.uid() and ur.role = 'admin');
$$;
grant execute on function public.is_moderator() to authenticated, anon;
grant execute on function public.is_admin()     to authenticated, anon;

create policy "users read their own roles" on public.user_roles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "admins read all roles" on public.user_roles for select to authenticated
  using ((select public.is_admin()));
grant usage on schema public to supabase_auth_admin;
grant select on table public.user_roles to supabase_auth_admin;
revoke all on table public.user_roles from anon, authenticated;
create policy "auth admin reads roles" on public.user_roles for select to supabase_auth_admin using (true);

-- ---- C. F7 avatar_url must be https (SECURITY §3) -------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_url_https') then
    alter table public.profiles add constraint profiles_avatar_url_https
      check (avatar_url is null or avatar_url ~ '^https://[^ ]+$');
  end if;
end $$;

-- ---- D. Soft-delete columns + deleted_at-aware stats view (USERS §5.1) ----
alter table public.reviews
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id) on delete set null;

create or replace view public.bathroom_stats with (security_invoker = on) as
select b.id as bathroom_id, count(r.id)::int as review_count,
  round(avg(r.rating)::numeric, 2)        as avg_rating,
  round(avg(r.cleanliness)::numeric, 2)   as avg_cleanliness,
  round(avg(r.privacy)::numeric, 2)       as avg_privacy,
  round(avg(r.accessibility)::numeric, 2) as avg_accessibility
from public.bathrooms b
left join public.reviews r on r.bathroom_id = b.id and r.deleted_at is null
group by b.id;

-- ---- E. Role-aware policies (USERS §4.4) ----------------------------------
drop policy if exists "users update bathrooms they added" on public.bathrooms;
create policy "update own bathrooms or any as moderator" on public.bathrooms for update to authenticated
  using ((select auth.uid()) = created_by or (select public.is_moderator()))
  with check ((select auth.uid()) = created_by or (select public.is_moderator()));
create policy "moderators delete bathrooms" on public.bathrooms for delete to authenticated
  using ((select public.is_moderator()));

drop policy if exists "reviews are viewable by everyone" on public.reviews;
create policy "reviews are viewable unless soft-deleted" on public.reviews for select
  using (deleted_at is null or (select public.is_moderator()));
drop policy if exists "users update their own reviews" on public.reviews;
create policy "update own reviews or any as moderator" on public.reviews for update to authenticated
  using ((select auth.uid()) = author_id or (select public.is_moderator()))
  with check ((select auth.uid()) = author_id or (select public.is_moderator()));
drop policy if exists "users delete their own reviews" on public.reviews;
create policy "delete own reviews or any as moderator" on public.reviews for delete to authenticated
  using ((select auth.uid()) = author_id or (select public.is_moderator()));

-- ---- F. reports + moderation_actions + RPC (USERS §5.2–5.4) ---------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles (id) on delete set null,
  review_id   uuid references public.reviews (id)   on delete cascade,
  bathroom_id uuid references public.bathrooms (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 1000),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz, created_at timestamptz not null default now(),
  check ((review_id is not null)::int + (bathroom_id is not null)::int = 1)
);
create index reports_open_idx on public.reports (created_at desc) where status = 'open';
alter table public.reports enable row level security;
create policy "users file their own reports" on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id);
create policy "read own reports or all as moderator" on public.reports for select to authenticated
  using ((select auth.uid()) = reporter_id or (select public.is_moderator()));
create policy "moderators update reports" on public.reports for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in ('soft_delete_review','restore_review','delete_review',
    'delete_bathroom','update_bathroom','merge_bathroom','resolve_report','dismiss_report','grant_role','revoke_role')),
  target_type text not null check (target_type in ('review','bathroom','report','profile')),
  target_id uuid not null, detail jsonb, created_at timestamptz not null default now()
);
create index moderation_actions_target_idx on public.moderation_actions (target_type, target_id);
alter table public.moderation_actions enable row level security;
create policy "moderators read the audit log" on public.moderation_actions for select to authenticated
  using ((select public.is_moderator()));

create or replace function public.moderate_soft_delete_review(p_review_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'not authorized'; end if;
  update public.reviews set deleted_at = now(), deleted_by = auth.uid() where id = p_review_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values (auth.uid(), 'soft_delete_review', 'review', p_review_id, jsonb_build_object('reason', p_reason));
end; $$;
grant execute on function public.moderate_soft_delete_review(uuid, text) to authenticated;

-- ---- G. Account lifecycle (USERS §6.1 with sentinel-handle FIX, §6.2) -----
insert into auth.users (id, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000','deleted@watrloo.invalid','{}'::jsonb)
  on conflict (id) do nothing;
insert into public.profiles (id, username)
  values ('00000000-0000-0000-0000-000000000000','deleted_user')
  on conflict (id) do update set username = 'deleted_user';   -- FIX: trigger front-runs the plain insert

create or replace function public.anonymize_on_profile_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare sentinel constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if old.id = sentinel then return old; end if;
  delete from public.reviews r where r.author_id = old.id
     and exists (select 1 from public.reviews s where s.bathroom_id = r.bathroom_id and s.author_id = sentinel);
  update public.reviews set author_id = sentinel where author_id = old.id;
  return old;
end; $$;
create trigger profiles_anonymize_before_delete before delete on public.profiles
  for each row execute function public.anonymize_on_profile_delete();

alter table public.profiles add column username_changed_at timestamptz;
create or replace function public.rate_limit_username()
returns trigger language plpgsql as $$
begin
  if new.username is distinct from old.username then
    if old.username_changed_at is not null and old.username_changed_at > now() - interval '30 days' then
      raise exception 'username can be changed at most once every 30 days';
    end if;
    new.username_changed_at := now();
  end if;
  return new;
end; $$;
create trigger profiles_rate_limit_username before update on public.profiles
  for each row execute function public.rate_limit_username();

-- ---- H. Rate limiting (RATE_LIMITING §2–3) --------------------------------
create table public.rate_limits (
  user_id uuid not null, action text not null, bucket timestamptz not null,
  count int not null default 0, primary key (user_id, action, bucket)
);
create index rate_limits_bucket_idx on public.rate_limits (bucket);
alter table public.rate_limits enable row level security;

create or replace function public.check_rate_limit(p_action text, p_limit int, p_window interval)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_secs double precision := extract(epoch from p_window);
        v_bucket timestamptz; v_count int;
begin
  if v_uid is null then return; end if;
  v_bucket := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  insert into public.rate_limits as rl (user_id, action, bucket, count) values (v_uid, p_action, v_bucket, 1)
  on conflict (user_id, action, bucket) do update set count = rl.count + 1 returning rl.count into v_count;
  if v_count > p_limit then
    raise sqlstate 'PT429' using message = format('You''re doing that too fast (%s).', p_action), hint = 'RATE_LIMITED';
  end if;
end; $$;
revoke all on function public.check_rate_limit(text, int, interval) from public;

create or replace function public.enforce_review_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.check_rate_limit('review_hour', 10, interval '1 hour');
  perform public.check_rate_limit('review_day',  30, interval '1 day');
  return null;
end; $$;
create trigger reviews_rate_limit after insert on public.reviews
  for each row execute function public.enforce_review_rate_limit();

create or replace function public.enforce_bathroom_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.check_rate_limit('bathroom_hour', 5,  interval '1 hour');
  perform public.check_rate_limit('bathroom_day',  20, interval '1 day');
  return new;
end; $$;
create trigger bathrooms_rate_limit before insert on public.bathrooms
  for each row execute function public.enforce_bathroom_rate_limit();

-- ---- I. Storage quota (RATE_LIMITING §7.1) --------------------------------
create or replace function public.under_photo_quota(p_max int default 20)
returns boolean language sql security definer set search_path = '' stable as $$
  select count(*) < p_max from storage.objects
  where bucket_id = 'review-photos' and (storage.foldername(name))[1] = (select auth.uid())::text;
$$;
drop policy "users upload to their own folder" on storage.objects;
create policy "users upload to their own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'review-photos'
              and (select auth.uid())::text = (storage.foldername(name))[1]
              and public.under_photo_quota(20));

-- ---- J. Photo caps + orphan-object queue (RATE_LIMITING §7.2) -------------
create table public.pending_object_deletions (
  storage_path text primary key, enqueued_at timestamptz not null default now()
);
create or replace function public.enforce_photo_caps()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_per_review int;
begin
  select count(*) into v_per_review from public.review_photos where review_id = new.review_id;
  if v_per_review >= 4 then
    raise sqlstate 'PT413' using message = 'That review already has the maximum of 4 photos.', hint = 'QUOTA_EXCEEDED';
  end if;
  return new;
end; $$;
create trigger review_photos_caps before insert on public.review_photos
  for each row execute function public.enforce_photo_caps();

create or replace function public.enqueue_photo_object_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pending_object_deletions (storage_path) values (old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end; $$;
create trigger review_photos_enqueue_deletion after delete on public.review_photos
  for each row execute function public.enqueue_photo_object_deletion();

-- ---- K. Client error sink (OBSERVABILITY §2.1, guard FIXED with nullif) ---
create table public.client_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message text not null, stack text, component_stack text, route text,
  user_id uuid references auth.users (id) on delete set null,
  user_agent text, release text,
  severity text not null default 'error' check (severity in ('warning','error','fatal')),
  fingerprint text not null, client_ip inet
);
create index client_errors_created_at_idx  on public.client_errors (created_at desc);
create index client_errors_fingerprint_idx on public.client_errors (fingerprint, created_at desc);
alter table public.client_errors enable row level security;
create policy "anyone may report an error" on public.client_errors for insert to anon, authenticated
  with check (char_length(message) <= 2000
    and (stack is null           or char_length(stack) <= 8000)
    and (component_stack is null or char_length(component_stack) <= 8000)
    and (route is null           or char_length(route) <= 300)
    and (user_agent is null      or char_length(user_agent) <= 400)
    and (release is null         or char_length(release) <= 80)
    and severity in ('warning','error','fatal')
    and (user_id is null or user_id = (select auth.uid())));

create or replace function public.client_errors_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  fwd text := nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for';  -- FIX: nullif
  recent int;
begin
  new.client_ip := nullif(split_part(coalesce(fwd, ''), ',', 1), '')::inet;
  select count(*) into recent from public.client_errors where created_at > now() - interval '1 minute';
  if recent >= 240 then return null; end if;
  select count(*) into recent from public.client_errors
   where fingerprint = new.fingerprint and created_at > now() - interval '1 hour';
  if recent >= 20 then return null; end if;
  return new;
end; $$;
create trigger client_errors_guard_trg before insert on public.client_errors
  for each row execute function public.client_errors_guard();
create policy "admins may read client errors" on public.client_errors for select to authenticated
  using (public.is_admin());

-- ---- L. Health checks (OBSERVABILITY §4 Option A) -------------------------
create table public.health_checks (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  metric text not null, value numeric not null, ok boolean not null, detail text
);
alter table public.health_checks enable row level security;
create policy "admins read health" on public.health_checks for select to authenticated
  using (public.is_admin());

-- ---- M. Bounds RPC (SCALING §2.2, search_path-hardened) -------------------
create or replace function public.bathrooms_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
) returns setof public.bathrooms language sql stable set search_path = '' as $$
  select b.* from public.bathrooms b
  where b.geog operator(extensions.&&)
        extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::extensions.geography;
$$;
grant execute on function public.bathrooms_in_bounds(double precision,double precision,double precision,double precision)
  to anon, authenticated;

commit;
```

**Post-apply, non-SQL steps** (documented, not run here): grant the first admin
(`insert into public.user_roles (user_id, role) values ('<uuid>','admin');`); optionally
install `pg_cron`/`pg_net` and schedule the rate-limit sweep + orphan reaper (via the
Storage API, never `delete from storage.objects`); optionally enable the custom
access-token hook and switch to the JWT helper variant; set Dashboard **Max rows** and keep
**Confirm email** on.

---

## 6. Database untouched

Every psql session ended in `ROLLBACK`. The closing check after the final (assembled-
migration) run:

```
 bathrooms | profiles | reviews
-----------+----------+---------
        10 |        1 |       0
```

Identical to baseline. No rows, schema objects, policies, functions, or grants were
persisted to the live database.
