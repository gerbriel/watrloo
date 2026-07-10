# Watrloo — Rate limiting & abuse mitigation

**Author:** RATE-LIMITING & ABUSE agent · **Date:** 2026-07-09
**Constraint being honored:** self-sufficient — no third-party or paid services on the hot path. Supabase Postgres/Auth/Storage + a static file on Cloudflare R2 are the only backends. **No Cloudflare WAF, no Upstash, no Redis, no external rate-limit service.** Everything below runs inside Postgres/Supabase or the browser.

Tiers reuse `TECH_EVALUATION.md`: **A** self-contained (our bundle / our Postgres), **B** free + self-hostable, **C** third-party on the hot path (rejected).

---

## 0. Platform facts I verified (don't take these from memory — they move)

These correct two premises in the brief and anchor the whole design. Every one is testable in ~2 minutes; §8 says how.

| Claim | Verified value | Source |
|---|---|---|
| PostgREST default max rows per response | **1000** (not unlimited). Dashboard → Project Settings → API → "Max rows". Hard cap you can raise to 1,000,000 — keep it low. | [postgREST config](https://docs.postgrest.org/en/v12/references/configuration.html), [Supabase discussion #3765](https://github.com/orgs/supabase/discussions/3765) |
| Custom HTTP status from SQL | `RAISE sqlstate 'PT429'` → **HTTP 429**; `message/detail/hint/sqlstate` map to JSON `message/details/hint/code`. `PGRST` sqlstate gives full control incl. **response headers** (e.g. `Retry-After`). | [PostgREST errors](https://docs.postgrest.org/en/v12/references/errors.html) |
| `auth.uid()` inside a trigger | Works. It reads the per-request `request.jwt.claims` GUC PostgREST sets at transaction start; a `BEFORE/AFTER INSERT` trigger fired during a REST request sees it. Returns **NULL** for service-role / SQL-editor / cron writes — design for that. | [Supabase RLS helpers](https://supabase.com/docs/guides/database/postgres/row-level-security#helper-functions) |
| `pg_cron` on Free tier | **Available on all tiers** ("Cron is only limited by the resources it uses CPU/Memory/Disk-wise on any tier" — Supabase staff). Resource-bound, not plan-gated. | [pg_cron docs](https://supabase.com/docs/guides/database/extensions/pg_cron), [discussion #37405](https://github.com/orgs/supabase/discussions/37405) |
| Trigger on `storage.objects` | Officially **allowed** — the platform explicitly permits "RLS policies and database triggers" on `storage.objects` — but `storage.objects` is owned by `supabase_storage_admin`, and people still hit `42501 must be owner of table objects`. **Flaky. Don't depend on it.** | [Permissions](https://supabase.com/docs/guides/platform/permissions), [discussion #34270](https://github.com/orgs/supabase/discussions/34270) |
| Deleting a `storage.objects` row via SQL | Does **NOT** free the underlying object bytes in S3. The row is metadata; byte deletion happens only through the Storage API. A pure-SQL reaper of `storage.objects` desyncs metadata from bytes — see §7. | [Storage architecture](https://supabase.com/docs/guides/storage/uploads/standard-uploads) (verify per §8) |
| Auth rate limits (defaults) | See §6 table. The one that bites: **built-in email sender = 2 emails/hour, project-wide.** | [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) |

---

## 1. Threat table

| # | Threat | Current exposure | Mitigation (all tier A unless noted) | Ship tier |
|---|---|---|---|---|
| 1 | **Review spam / brigading** | `unique(bathroom_id,author_id)` caps 1/bathroom/user, but N accounts (Sybil) or one user reviewing 10k bathrooms is open | Platform: email-confirm gates writes; 2-emails/hr SMTP throttles account minting. Build: `check_rate_limit` on `reviews` **AFTER INSERT** (10/hr, 30/day). Optional min-account-age RLS. Sybil is only *dampened*, not stopped (§6, §9) | P1 |
| 2 | **Bathroom-entry spam** | Open insert to any authenticated user; no cap; junk names / in-range-but-garbage lat/lng; 100k rows | `check_rate_limit` on `bathrooms` **BEFORE INSERT** (5/hr, 20/day). PostGIS dup-detection (already in `TECH_EVALUATION §4`) blunts near-dupes | P1 |
| 3 | **Storage abuse** | 5 MB/file + images-only + `<uid>/` prefix enforced, but **no cap on file count**; 1 GB free tier → one uid can exhaust it | Real cap: `under_photo_quota()` predicate on the storage INSERT policy (≤20 objects/uid). UX cap + clean error: `BEFORE INSERT` trigger on `review_photos` (≤4/review, ≤50/user) raising `PT413` | P1 |
| 4 | **Anon read abuse / scraping** | All reads public by design | **Not "unlimited"** — default max-rows=1000 already caps a single request. Lower it to ~200. True per-IP anon limiting is *not* doable in Postgres (client IP isn't reliably available) → accept it; the data is public (§4) | P2 (config only) |
| 5 | **Auth endpoint abuse** | Signup/signin brute force, spraying, enumeration | **Almost entirely the platform's job** — per-IP token bucket, generic "Invalid login credentials", obfuscated signup for existing emails. We add: keep confirm-email ON, client backoff on 429. CAPTCHA is the real next lever but is tier C → rejected (§9) | P3 (platform) |
| 6 | **Orphaned storage objects** | `deleteReviewPhoto` deletes row→object (crash between = orphan); review cascade deletes `review_photos` rows but **not** the objects | `pending_object_deletions` queue + `AFTER DELETE` trigger on `review_photos`; a scheduled **Edge Function** drains it via the Storage API (bytes can't be freed from SQL). `pg_cron` reconcile sweep for row-less orphans | P2 |

---

## 2. The core primitive: `rate_limits` + `check_rate_limit`

Adopt. One small table, one function, fired from triggers. Reasoning about the hard parts:

**Lock contention.** Rows are keyed `(user_id, action, bucket)`. The only writers that collide on a row are *the same user, same action, in the same time window* — i.e. exactly the abuser we want to serialize. Two different users never touch the same row, so there is no global hotspot. A user hammering `reviews` serializes on their own row for microseconds per insert; that is acceptable and is in fact the point.

**Fixed window, not sliding.** A sliding window needs one row per event (heavier, and needs its own cleanup). A fixed window is one row per `(user, action, window)` with an atomic counter. Bucket = `now()` floored to a multiple of the window length. Downside: a burst straddling a boundary can briefly allow up to 2× the limit. For abuse control (not billing) that is fine — halve the limit if it matters.

**Atomic increment.** `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` bumps and reads the counter under a single row lock — no read-then-write race.

**What the client sees.** The function `RAISE`s `PT429`, which PostgREST turns into a real `429` with a JSON body the UI can switch on (§5). This is the decisive reason to use a **trigger**, not an RLS predicate (compared in §2.3).

```sql
-- 2.1  Storage
create table public.rate_limits (
  user_id uuid        not null,
  action  text        not null,
  bucket  timestamptz not null,          -- window start (floored)
  count   int         not null default 0,
  primary key (user_id, action, bucket)
);
-- cleanup reads by time, not by pk prefix:
create index rate_limits_bucket_idx on public.rate_limits (bucket);
alter table public.rate_limits enable row level security;
-- No policies => no client (anon/authenticated) can read or write it directly.
-- SECURITY DEFINER functions below bypass RLS to maintain it.
```

```sql
-- 2.2  The check. SECURITY DEFINER so it can write rate_limits under RLS.
--      Raises PT429 when the caller is over budget; no-ops for trusted callers.
create or replace function public.check_rate_limit(
  p_action text,
  p_limit  int,
  p_window interval
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_secs   double precision := extract(epoch from p_window);
  v_bucket timestamptz;
  v_count  int;
begin
  -- Trusted server contexts (service_role, SQL editor, cron) have no JWT.
  -- Do not rate-limit them; they are not the threat.
  if v_uid is null then
    return;
  end if;

  v_bucket := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);

  insert into public.rate_limits as rl (user_id, action, bucket, count)
  values (v_uid, p_action, v_bucket, 1)
  on conflict (user_id, action, bucket)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  if v_count > p_limit then
    -- The over-limit increment rolls back with the aborted statement, so a
    -- blocked attempt does not "consume" a token — the counter stays pinned
    -- at the limit and every further attempt is rejected until the window rolls.
    raise sqlstate 'PT429'
      using message = format('You''re doing that too fast (%s). Try again shortly.', p_action),
            detail  = format('limit=%s per %s', p_limit, p_window),
            hint    = 'RATE_LIMITED';
  end if;
end;
$$;

revoke all on function public.check_rate_limit(text, int, interval) from public;
-- Called only from triggers (which run as the table owner), never by clients.
```

### 2.3 Trigger vs. RLS predicate — decided: **trigger**

The brief asks to compare `with check (... and public.under_rate_limit('review'))` against a trigger. I evaluated both and reject the RLS approach for rate limiting:

| | Trigger raising `PT429` | RLS `with check(under_rate_limit())` |
|---|---|---|
| Error the client gets | **`429` + custom JSON** — UI can say "posting too fast" | **`403`, `42501`, "new row violates row-level security policy"** — indistinguishable from a genuine auth failure; can't be customized |
| Side-effecting predicate | N/A (triggers are meant to act) | You must *write* (increment a counter) inside a `WITH CHECK` predicate — legal but semantically wrong; also re-evaluated on `UPDATE`, double-counting |
| Bypass by client | Impossible — client can't disable a trigger | Impossible — same |
| Security-boundary role | Not a boundary; it's abuse control | RLS *is* the security boundary; overloading it with rate state muddies the model |

Rate limiting is **not a security boundary** (RLS already enforces ownership); it's an abuse throttle where **error quality is the whole point**. Triggers win. Keep RLS for hard predicates only (ownership — already done; optional account-age, §3).

A `BEFORE UPDATE` note: don't rate-limit updates the same way — `touch_updated_at` and normal edits would trip it. Rate-limit **inserts**.

---

## 3. Threats 1 & 2 — review & bathroom write spam

### 3.1 Reviews — attach to **AFTER INSERT**, deliberately

`upsertReview` (`src/lib/api/reviews.ts`) issues `INSERT ... ON CONFLICT (bathroom_id,author_id) DO UPDATE`. Postgres fires `BEFORE INSERT` for *every* proposed row, but on conflict the row resolves to an **UPDATE** — so a `BEFORE INSERT` limiter would burn the user's budget every time they *edit* an existing review. `AFTER INSERT` fires **only when a genuinely new row is inserted** (conflict → `AFTER UPDATE` instead), so editing is free and only new reviews count. Raising in `AFTER INSERT` still aborts the statement and returns the 429; the counter row rolls back with it.

```sql
create or replace function public.enforce_review_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.check_rate_limit('review_hour', 10, interval '1 hour');
  perform public.check_rate_limit('review_day',  30, interval '1 day');
  return null;  -- AFTER trigger: return value ignored
end;
$$;

create trigger reviews_rate_limit
  after insert on public.reviews
  for each row execute function public.enforce_review_rate_limit();
```

### 3.2 Bathrooms — `BEFORE INSERT` (plain insert, fail early)

`createBathroom` is a plain insert (no upsert), so `BEFORE INSERT` is correct and cheaper (rejects before writing the row).

```sql
create or replace function public.enforce_bathroom_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.check_rate_limit('bathroom_hour', 5,  interval '1 hour');
  perform public.check_rate_limit('bathroom_day',  20, interval '1 day');
  return new;
end;
$$;

create trigger bathrooms_rate_limit
  before insert on public.bathrooms
  for each row execute function public.enforce_bathroom_rate_limit();
```

Tune the numbers to taste; these assume a legitimate power-user maps a building's worth of restrooms in a sitting but nobody needs 100/hour.

### 3.3 Optional: minimum account age / confirmed email as an RLS predicate

**Email confirmation is already enforced for free** and better than any RLS check: with "Confirm email" ON, `supabase.auth.signUp` returns `session === null` until the link is clicked (see `AuthProvider.signUp` → `needsEmailConfirmation`). No session ⇒ the caller holds the `anon` role, not `authenticated` ⇒ every `to authenticated` insert policy already rejects it. So "must confirm email before first write" needs **zero code** — just keep the setting on. Confirm it's on (§8).

Account *age* (defeat "confirm, then immediately spam") can be added, but it produces the generic `403` and is largely redundant given the email round-trip already costs minutes + a scarce SMTP send. Include only if bots become real:

```sql
-- Optional. authenticated cannot read auth.users, so read profiles.created_at
-- (minted at signup by handle_new_user). SECURITY DEFINER to be safe.
create or replace function public.write_allowed()
returns boolean language sql security definer set search_path = '' stable as $$
  select coalesce(
    (select created_at < now() - interval '2 minutes'
       from public.profiles where id = (select auth.uid())),
    false);
$$;
-- Then, when replacing the insert policies:
--   ... with check ((select auth.uid()) = created_by and public.write_allowed());
```

Priority: **low.** Ships behind the rate limiters.

---

## 4. Threat 4 — anon read abuse / scraping

**Correcting the brief:** PostgREST does *not* "happily serve `?limit=100000`". Supabase ships `max-rows = 1000`, so any single request is truncated to 1000 rows regardless of the requested `limit`/`range`. Lower it further — this app's biggest legitimate page is the 50-row directory list and bounded map queries:

- Dashboard → **Project Settings → API → Max rows → `200`** (zero code). This caps the payload of any accidental or malicious broad query.

What you **cannot** do within the constraint: per-IP rate-limit anonymous readers *in Postgres*. The client IP is not reliably available to SQL — PostgREST runs behind Supabase's edge/proxy, and while a `db-pre-request` hook can read forwarded headers, there is nowhere cheap to keep per-IP counters and no trustworthy IP to key them on. A determined scraper just paginates with `offset`/`range`. **Accept it:** every readable row is public *by product design* (it's a directory). The correct posture is "cheap to read, nothing sensitive to leak", which is already true. Effort here is better spent on the write-side threats.

`db-pre-request` is genuinely useful for **one** thing — a global guard, e.g. rejecting absurd offsets — but it fires on *every* request (including authenticated writes) and can only see what's in GUCs. I evaluated it and use only max-rows; see §9 for the rejection detail.

---

## 5. Client-side contract (the API layer)

The DB now returns structured `429`/`413`s. The `src/lib/api/*` layer should translate raw `PostgrestError`s into a typed error the UI can act on, so a component can say "you're posting too fast" instead of surfacing a Postgres string. (Design only — this doc writes no source; hand to the FEATURES/API agent.)

`supabase-js` surfaces `PostgrestError` with `.code` (= SQLSTATE, so `'PT429'`/`'PT413'`), `.message`, `.details`, `.hint`. Map it:

```ts
// src/lib/api/errors.ts  (proposed)
export type ApiErrorKind =
  | 'rate_limited'      // PT429 from check_rate_limit
  | 'quota_exceeded'    // PT413 from review_photos trigger / storage policy
  | 'already_reviewed'  // 23505 unique_violation on (bathroom_id, author_id)
  | 'forbidden'         // 42501 RLS / storage-quota policy
  | 'unknown';

export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, message: string, readonly retryable = false) {
    super(message);
  }
}

export function toApiError(e: unknown): ApiError {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case 'PT429': return new ApiError('rate_limited',
      "You're posting too fast. Give it a minute.", /* retryable */ true);
    case 'PT413': return new ApiError('quota_exceeded',
      "You've hit the photo limit. Delete some to add more.");
    case '23505': return new ApiError('already_reviewed',
      "You've already reviewed this bathroom — editing your existing review.");
    case '42501': return new ApiError('forbidden', "You can't do that.");
    default:      return new ApiError('unknown',
      (e as Error)?.message ?? 'Something went wrong.');
  }
}
```

Then each `api/*` function does `if (error) throw toApiError(error)`. UI rules:

- **Optimistic disable.** Disable the submit button from click until the request settles. This removes the double-click storm that trips the limiter in the first place.
- **Do NOT auto-retry non-idempotent writes.** `createBathroom` is not idempotent — a silent retry on a slow `429`/timeout risks a duplicate row. Surface `rate_limited` and let the user retry manually. `upsertReview` *is* idempotent (keyed on the unique constraint), so a single guarded retry is defensible — but still prefer showing the message.
- **Exponential backoff only for idempotent GETs.** The map-pan refetch (`listBathroomsInBounds`) and list queries can back off + jitter on `429`. TanStack Query (adopted in `TECH_EVALUATION §2`) already dedupes/cancels in-flight pans — set `retry` to skip `rate_limited`/`forbidden` and only retry transient network errors.
- **Auth screens.** `supabase-js` `AuthError` carries `.status` (429) and `.code` (e.g. `over_email_send_rate_limit`). On 429 in `signIn`/`signUp`, show "Too many attempts — wait a minute", don't loop.
- **Optional `Retry-After`.** If you want the UI to show a precise countdown, switch `check_rate_limit` to the `PGRST` sqlstate form, which lets you set response headers:
  ```sql
  raise sqlstate 'PGRST'
    using message = '{"code":"PT429","message":"You''re posting too fast.","hint":"RATE_LIMITED"}',
          detail  = '{"status":429,"headers":{"Retry-After":"3600"}}';
  ```

---

## 6. Threat 5 — auth endpoint abuse (mostly the platform's job)

The `auth` schema is Supabase-managed; you can't add triggers to it, and you don't need to. What you get for free ([Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) — **verify current numbers in-dashboard, they change and some are configurable**):

| Endpoint | Default limit | Keyed on | Configurable? |
|---|---|---|---|
| Email sends (signup confirm, recovery, invite, email-change) | **2 / hour** on built-in SMTP; 30 new users/hour on custom SMTP | Project-wide | Only with custom SMTP |
| All IP-limited endpoints (token bucket) | capacity **30**, brief bursts then throttle | Per IP | No |
| `/token` (sign-in w/ password, refresh) | ~1,800 / hour | Per IP | No |
| `/verify` | ~360 / hour | Per IP | No |
| `/otp` | 30 / hour | Project-wide | Dashboard |
| Anonymous sign-ins | 30 / hour | Per IP | No |

Consequences specific to this app:

- **Brute force / password spraying** is bounded by the per-IP token bucket. A distributed attack across many IPs isn't stoppable from Postgres — that's what a WAF/CAPTCHA is for, both tier C, both rejected. Accept the residual risk; passwords are Supabase-hashed and there's nothing high-value behind an account.
- **Email enumeration** is already mitigated: `signInWithPassword` returns a generic *"Invalid login credentials"* for both wrong-password and unknown-email, and with confirmation ON, signing up an existing email returns an obfuscated user rather than "already registered". Keep it that way (don't add a "username taken"-style check on the email path).
- **The 2-emails/hour built-in SMTP cap is a double-edged sword.** It is an *accidental* Sybil brake — you cannot confirm more than 2 new accounts per hour project-wide — but it will also throttle *legitimate* signups the moment you have real traffic. This is the single most important operational item: **before launch, wire a free-tier-friendly SMTP** (the constraint permits your own mail infra; a personal Gmail/self-hosted relay is tier A/B, not a paid API) so real users aren't blocked, and accept that doing so raises the Sybil ceiling to 30/hour — at which point the §3 rate limiters and the write-side caps are what actually contain damage.

Net: build nothing in the DB for threat 5. Keep confirm-email ON, wire your own SMTP, handle 429 on the client.

---

## 7. Threat 3 — storage quota; and Threat 6 — orphan reaping

### 7.1 Per-user storage quota — two layers, on purpose

**Layer 1 (the real cap) — a predicate on the storage INSERT policy.** This is the only thing that stops a client that uploads objects *without* ever inserting a `review_photos` row (the storage RLS only checks the `<uid>/` prefix, so raw uploads are otherwise uncapped). Triggers on `storage.objects` are flaky (§0), but **policies on `storage.objects` are fully supported** — the init migration already adds three. Replace the upload policy with one that also checks a count:

```sql
create or replace function public.under_photo_quota(p_max int default 20)
returns boolean language sql security definer set search_path = '' stable as $$
  select count(*) < p_max
  from storage.objects
  where bucket_id = 'review-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text;
$$;

-- Replace the existing "users upload to their own folder" policy:
drop policy "users upload to their own folder" on storage.objects;
create policy "users upload to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'review-photos'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.under_photo_quota(20)
  );
```

Count is O(objects-per-user); with ≤20 objects/uid and the name index that's trivial. The error is a generic `403` (RLS), which `toApiError` maps to `forbidden` — acceptable for the raw-upload abuse path.

**Layer 2 (nice error on the normal path) — a `review_photos` trigger.** The happy path uploads the object, then inserts a `review_photos` row (`src/lib/api/photos.ts`), and *already deletes the object if that row insert fails* (lines 39–43). So a trigger on the table **we fully own** gives a clean `PT413` **and** the existing client code auto-cleans the just-uploaded object. Enforce per-review and per-user caps here:

```sql
create or replace function public.enforce_photo_caps()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_per_review int;
  v_per_user   int;
begin
  select count(*) into v_per_review
  from public.review_photos where review_id = new.review_id;
  if v_per_review >= 4 then
    raise sqlstate 'PT413'
      using message = 'That review already has the maximum of 4 photos.',
            hint = 'QUOTA_EXCEEDED';
  end if;

  if v_uid is not null then
    select count(*) into v_per_user
    from public.review_photos rp
    join public.reviews r on r.id = rp.review_id
    where r.author_id = v_uid;
    if v_per_user >= 50 then
      raise sqlstate 'PT413'
        using message = 'You''ve reached your photo limit. Delete some to add more.',
              hint = 'QUOTA_EXCEEDED';
    end if;
  end if;

  return new;
end;
$$;

create trigger review_photos_caps
  before insert on public.review_photos
  for each row execute function public.enforce_photo_caps();
```

Set Layer-1's `p_max` at or a touch above Layer-2's per-user cap (e.g. 20 vs 50 — pick one policy; I'd use **20 objects/uid** as the hard storage cap and drop the per-user `review_photos` clause, keeping only per-review=4). Twenty objects × 5 MB = 100 MB worst case per uid; combined with the review rate limits the realistic footprint is far lower. Revisit if 1 GB gets tight.

**Egress**, not just storage, is the other free-tier limit. The basemap already moved to R2 (free egress) per the owner's setup; review photos stay on Supabase and are cached by Supabase's CDN on the public URL. Nothing more to build within the constraint — just don't raise the object cap carelessly.

### 7.2 Orphaned objects — reaping (Threat 6)

Two orphan sources:
1. **Cascade:** deleting a `review` cascades to `review_photos` rows but leaves the **objects**. (Biggest source.)
2. **Crash windows:** `deleteReviewPhoto` deletes the row then the object; `uploadReviewPhoto` uploads then inserts the row. A crash mid-sequence strands an object with no row.

**Why not just delete `storage.objects` from SQL / `pg_cron`?** Because deleting a `storage.objects` row does **not** free the S3 bytes (§0) — it desyncs metadata from storage and can leave the bytes billed forever, or worse, break the object. Byte deletion must go through the **Storage API**. So the reaper needs an HTTP caller. Within the constraint that means a **Supabase Edge Function** (Supabase-native, free-tier invocations — *not* a third party) invoked on a schedule; `pg_cron` alone can't do it.

**Design:**

```sql
-- 7.2a  Durable work queue (pure SQL, fully owned).
create table public.pending_object_deletions (
  storage_path text primary key,
  enqueued_at  timestamptz not null default now()
);

-- 7.2b  Capture BOTH explicit deletes and cascade deletes of review_photos.
create or replace function public.enqueue_photo_object_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pending_object_deletions (storage_path)
  values (old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end;
$$;

create trigger review_photos_enqueue_deletion
  after delete on public.review_photos
  for each row execute function public.enqueue_photo_object_deletion();
```

Now `deleteReviewPhoto` in the client can be simplified to *just delete the row* — the trigger enqueues the object and the reaper frees the bytes, removing the crash-between-row-and-object window entirely. (Optional client change; hand to the API agent.)

**7.2c The reaper — a scheduled Edge Function** (sketch; Supabase-native):

```ts
// supabase/functions/reap-photos/index.ts  (proposed — separate agent to add)
import { createClient } from 'jsr:@supabase/supabase-js@2';
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,   // server-only, never shipped to browser
);
const BUCKET = 'review-photos';

Deno.serve(async () => {
  // (1) Drain the queue: objects we KNOW are orphaned.
  const { data: queued } = await admin
    .from('pending_object_deletions').select('storage_path').limit(1000);
  if (queued?.length) {
    const paths = queued.map(r => r.storage_path);
    await admin.storage.from(BUCKET).remove(paths);          // frees bytes
    await admin.from('pending_object_deletions')
      .delete().in('storage_path', paths);
  }

  // (2) Reconcile sweep for row-less orphans (upload-crash window):
  //     list bucket objects, drop any with no matching review_photos.storage_path
  //     AND older than a grace period so in-flight uploads aren't reaped.
  //     (Paginate storage.list over each <uid>/ prefix; compare to
  //     select storage_path from review_photos; remove the difference where
  //     created_at < now() - 24h.)
  return new Response('ok');
});
```

Schedule it (and the rate-limit cleanup) with `pg_cron` — available on Free (§0):

```sql
-- Reap old rate-limit rows so the table doesn't grow unbounded.
select cron.schedule(
  'reap-rate-limits', '17 * * * *',
  $$ delete from public.rate_limits where bucket < now() - interval '2 days' $$
);

-- Invoke the Edge Function daily via pg_net (Supabase's HTTP extension).
-- Store the function URL + a service key in Vault; do NOT inline secrets.
select cron.schedule(
  'reap-photos', '30 3 * * *',
  $$ select net.http_post(
       url     := (select decrypted_secret from vault.decrypted_secrets where name='reap_photos_url'),
       headers := jsonb_build_object(
                    'Authorization',
                    'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key'))
     ) $$
);
```

If you prefer no Edge Function at all: `pg_net` can call the Storage REST API (`DELETE /storage/v1/object/review-photos/{path}`) directly from the cron job, looping over the queue — same effect, all in Postgres, at the cost of URL-encoding paths and handling per-object HTTP in plpgsql. Either is tier A/B (Supabase-only). **Do not** substitute a raw `delete from storage.objects` — it won't free bytes (§8 test).

---

## 8. How to verify the shaky claims (do these before relying on them)

1. **max-rows.** `curl "https://<REF>.supabase.co/rest/v1/bathrooms?select=id&limit=100000" -H "apikey: <ANON>"` → count rows; expect ≤ the dashboard "Max rows".
2. **PT429 → HTTP 429.** Temporarily wrap a test RPC in `raise sqlstate 'PT429' ...`, call it, confirm the HTTP status and that supabase-js gives `error.code === 'PT429'`.
3. **`auth.uid()` in a trigger.** Add a `raise notice '%', (select auth.uid())` in one of the trigger fns, insert via the JS client (authenticated) vs the SQL editor; expect a uuid in the first, NULL in the second.
4. **pg_cron on your project.** `create extension if not exists pg_cron;` then `select cron.schedule('t','* * * * *', $$select 1$$);` and check `cron.job` / `cron.job_run_details`. If it errors on plan, fall back to an external GitHub-Actions ping of the Edge Function (still no *paid* service, but tier B).
5. **`storage.objects` trigger permission** (only if you decide to try one anyway): attempt `create trigger ... on storage.objects` — if it throws `42501 must be owner`, you've confirmed the flaky path; stay on the RLS-policy approach in §7.1.
6. **SQL delete does NOT free bytes.** Upload a test object; copy its public URL; `delete from storage.objects where name = '<path>'`; re-fetch the URL. If the bytes still download, you've confirmed you must use the Storage API to reap — as designed in §7.2.
7. **Email confirmation is ON.** Dashboard → Authentication → Providers → Email → "Confirm email". Confirm `signUp` returns `session === null` (the app already branches on this).

---

## 9. What I'd ship first (prioritized)

1. **Two dashboard toggles, zero code (today).** Set **Max rows = 200**; confirm **Confirm email = ON**. Kills the "serve me 100k rows" premise and gates all writes behind a confirmed address.
2. **`rate_limits` + `check_rate_limit` + the two write triggers (§2, §3).** Highest value per line — directly contains threats 1 & 2, the real abuse vectors. `AFTER INSERT` on reviews, `BEFORE INSERT` on bathrooms.
3. **Storage quota, Layer 1 (§7.1)** — the `under_photo_quota` predicate on the upload policy. This is the actual 1 GB-exhaustion stopper. Add the per-review `review_photos` trigger for the nice error.
4. **Client error contract (§5).** `toApiError` + optimistic disable + "no auto-retry on non-idempotent writes". Turns raw Postgres strings into humane UI and stops the self-inflicted double-click storms.
5. **Own SMTP before launch (§6).** Not code, but the one thing that both unblocks real growth and is a prerequisite for the auth limits to make sense.
6. **Orphan reaper (§7.2) + `pg_cron` cleanup.** Correctness/cost hygiene, not an active abuse vector — ships after the above. The queue table + trigger first (cheap, pure SQL), the Edge Function drainer when convenient.
7. **Optional account-age RLS (§3.3), `Retry-After` header (§5).** Only if bots get real.

---

## 10. Explicitly rejected — and why

| Rejected | Why |
|---|---|
| **Cloudflare WAF / rate rules, Upstash, Redis, any external limiter** | Tier C, violates the self-sufficiency constraint outright. R2 is allowed *only* as a dumb static-file host for the basemap, not as a request-processing layer. |
| **CAPTCHA (hCaptcha / Cloudflare Turnstile)** — incl. Supabase's built-in bot protection | Supabase's "Enable CAPTCHA" needs an hCaptcha/Turnstile **secret key** → a third party on the auth hot path → tier C. This is the honest gap: it's the *only* thing that meaningfully stops distributed Sybil signup and password spraying, and the constraint forbids it. We compensate with email-confirm + write-side rate limits + the SMTP send cap, which raise cost without eliminating the threat. Flag to the owner as an accepted residual risk. |
| **Trigger on `storage.objects` for the quota** | `storage.objects` is owned by `supabase_storage_admin`; trigger creation intermittently fails with `42501 must be owner` on hosted Supabase (§0). The RLS-policy predicate (§7.1) is officially supported and does the same job. |
| **Pure-SQL / `pg_cron` reaper that `DELETE`s `storage.objects` rows** | Deleting the metadata row does not free the S3 bytes and desyncs storage — worse than the orphan it "fixes". Byte deletion must go through the Storage API (Edge Function or `pg_net` → Storage REST). See §8 test 6. |
| **RLS `with check(under_rate_limit())` for rate limiting** | Produces an uncustomizable `403 / 42501` the UI can't distinguish from a real auth failure, forces a side-effecting write inside a predicate, and double-fires on `UPDATE`. A trigger raising `PT429` is strictly better for abuse control (§2.3). RLS stays reserved for the ownership boundary. |
| **Per-IP rate limiting of anonymous reads in Postgres** | The client IP isn't reliably available to SQL (PostgREST sits behind Supabase's proxy) and there's no cheap per-IP store. It would be security theater. All readable data is public by product design; `max-rows` is the right and sufficient control (§4). |
| **`db-pre-request` hook as a rate limiter** | It fires on every request but can only see GUC/headers with no trustworthy IP and nowhere to keep counters; it can't meaningfully throttle. Its one legitimate use — a hard cap on absurd `offset`s — is marginal over `max-rows`. Not worth the per-request cost. |
| **Sliding-window rate limiting (one row per event)** | Heavier writes + its own cleanup burden for a precision this app doesn't need. Fixed windows are one counter row and good enough for abuse control (§2). |
| **`browser-image-compression` / any anti-spam SaaS (Akismet, etc.)** | Tier C or stale; unneeded. Client-side canvas downscale (already recommended in `TECH_EVALUATION §5`) keeps uploads under the 5 MB cap without a dependency. |

---

### Sources
- Supabase Auth rate limits — https://supabase.com/docs/guides/auth/rate-limits
- PostgREST errors (PTxyz / PGRST) — https://docs.postgrest.org/en/v12/references/errors.html
- PostgREST configuration (`max-rows`, `db-pre-request`) — https://docs.postgrest.org/en/v12/references/configuration.html
- Supabase max-rows default (1000) — https://github.com/orgs/supabase/discussions/3765
- pg_cron on Supabase (all tiers) — https://supabase.com/docs/guides/database/extensions/pg_cron , https://github.com/orgs/supabase/discussions/37405
- Supabase Cron — https://supabase.com/docs/guides/cron
- Platform permissions (triggers/RLS on `storage.objects`) — https://supabase.com/docs/guides/platform/permissions , https://github.com/orgs/supabase/discussions/34270
- Storage ownership / access control — https://supabase.com/docs/guides/storage/security/ownership , https://supabase.com/docs/guides/storage/security/access-control
- Row Level Security helpers (`auth.uid()`) — https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase REST error codes — https://supabase.com/docs/guides/api/rest/postgrest-error-codes
