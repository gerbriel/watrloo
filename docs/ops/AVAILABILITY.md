# Watrloo — Availability & Recovery

**Author:** AVAILABILITY & RECOVERY agent · **Date:** 2026-07-09
**Scope:** what breaks, how we detect it, how we recover, and what we deliberately accept.
**Constraint honored:** self-sufficient — Supabase free tier + Cloudflare R2 free tier + a free static host. No paid third-party services.

## Architecture as it bears on availability

Three independent runtime dependencies, each with its own failure surface:

| Layer | What it serves | Where | Free-tier ceiling |
|---|---|---|---|
| **Static SPA** | HTML/JS/CSS bundle (`dist/`) | Free static host (Cloudflare Pages / GitHub Pages / Netlify) | generous |
| **Supabase** | Postgres (PostgREST), Auth (GoTrue), Storage (review photos) | `https://<ref>.supabase.co` | **500 MB DB, 1 GB storage, 5 GB egress, 50k MAU** |
| **Basemap** | one static `us-z13.pmtiles` (~4.15 GB, see `basemap/us-z13.pmtiles`) | **Cloudflare R2** (planned), served by HTTP Range | **10 GB storage, $0 egress** |

Key structural facts that shape everything below:

- **Reads are anonymous and public.** RLS allows `select using (true)` on every table (`supabase/migrations/20260710000000_init.sql`). Anyone — signed in or not — can browse. The read path does **not** depend on Auth.
- **The single Supabase client** (`src/lib/supabase.ts`) is created once with the publishable/anon key and `autoRefreshToken: true`. Every page's data fetch flows through it.
- **Data fetching is bespoke `useEffect` today**, not TanStack Query. `Home`, `MapPage`, and `BathroomDetail` each hold `status: 'loading' | 'ready' | 'error'` and render a real error state with a "Try again" button (e.g. `src/pages/Home.tsx:108`, `src/pages/MapPage.tsx:55`). TanStack Query is an approved-but-unadopted upgrade (`docs/TECH_EVALUATION.md` §2).
- **The basemap is a static file.** The current committed code still renders Leaflet + OSM raster tiles (`src/components/map/BathroomMap.tsx:143`); the planned state is MapLibre + PMTiles on R2 (`docs/TECH_EVALUATION.md` §2.2). This doc designs for the **target R2/PMTiles** state and notes the interim OSM behavior where it differs.

> Every platform claim below is cited. Where a fact could not be verified from primary docs, it is marked **[unverified]** with the exact test to confirm it.

---

## 1. Failure modes, ranked by likelihood × blast radius

| # | Failure | Likelihood | Blast radius | Detection | Recovery time (RTO) |
|---|---|---|---|---|---|
| **F1** | **Supabase free project paused** (inactivity) | **High** (weekly clock) | **Total** — all data down (read + write) | Health cron 401/5xx; warning email ~1wk prior | Minutes (click Resume) — or **prevented entirely** by the cron |
| **F2** | **DB size > 500 MB → read-only** | Med (grows with content/photos-metadata) | **High** — writes fail, reads OK | Health cron write-probe; `cannot execute INSERT in a read-only transaction` | Minutes–hours (delete + vacuum, or upgrade) |
| **F3** | **Egress / org quota exceeded** → Fair-Use 402 | Med (a bot/scrape or viral day) | **High** — API returns 402 | Health cron 402 | Hours–days (wait for reset / reduce / upgrade) |
| **F4** | **Basemap unavailable** (R2 down, file deleted, CORS/Range broken) | Med | **Low** — map degrades, app usable | Health cron HEAD ≠ 206; user sees blank map | Minutes (re-upload / fix CORS); **degrades live** |
| **F5** | **Bad migration** (forward-only, no rollback) | Med (every schema change) | **High–Total** — corrupt/broken schema | Deploy fails; app errors post-deploy | Minutes–1h (restore pre-migration dump) |
| **F6** | **Auth outage / token-refresh failure** | Low–Med | **Low** — writes/sign-in blocked, **reads OK** | Sign-in fails; `/auth/v1/health` ≠ 200 | Bounded by Supabase; reads unaffected |
| **F7** | **Postgres connection / query pile-up** | Low | Med–High — 5xx / timeouts | Health cron latency/5xx | Minutes (pooler resets) |
| **F8** | **Account deletion cascade** destroys reviews; orphans bathrooms | Low (no in-app path **yet**) | Med — silent content loss | None today (no delete UI) | Not recoverable without backup |
| **F9** | **Orphaned storage objects** on review delete | High (every review delete) | Low, **cumulative** — eats the 1 GB cap | Storage usage creeps up | Reaper job |
| **F10** | **Static host / build outage** | Low | **Total** — nothing loads | Health cron on app URL | Minutes (redeploy / rollback) |
| **F11** | **Total project loss** (deleted after 90-day pause, or account issue) | Low | **Total + permanent** | Everything 404s | Restore drill into fresh project (§3) |

Ranking logic: F1 sits at the top because it is a **scheduled certainty** for an idle hobby project, not a random event — and its blast radius is total. F9 is high-likelihood but low, slow-burn impact. F8/F11 are low-likelihood but their impact is *irreversible without a backup*, which is why §3 exists.

---

## 2. Per-mode detail: detection, symptom, mitigation, recovery

### F1 — Supabase free project paused (the #1 outage)

**Policy (verified):** Supabase pauses Free-plan projects that "do not receive sufficient user database activity over the past week." The current docs deliberately avoid a hard number, saying "a few user requests to the database each day over the previous week" is enough to stay active; the widely-cited threshold is **7 days** of inactivity. You get a **warning email ~1 week before** the pause and a **confirmation email after**. A paused project can be restored **for up to 90 days**; after that, restoration is not guaranteed and the data is at risk of permanent deletion. ([free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing))

**User-visible symptom:** The static SPA still loads (it's on R2/Pages, independent). The basemap still loads (R2, independent). But every data call fails — `listBathrooms` rejects, so `Home` and `MapPage` fall into their `status === 'error'` branch ("Couldn't load bathrooms / the map", with "Try again"). Sign-in fails. Effectively: **the shell and map render, but there are no bathrooms and you can't log in.**

**Exact paused-endpoint behavior is [unverified]** — the docs don't state the HTTP response of a paused project. Test it against a paused project (or accept it will be a connection error / 5xx):
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $ANON" "https://$REF.supabase.co/rest/v1/bathrooms?select=id&limit=1"
```

**Mitigation (prevent it entirely):** A GitHub Actions cron that hits PostgREST every 6 h *is* "user database activity" and keeps the project active. This is the single highest-value ops automation in this doc — it removes F1 from the board and doubles as the health probe (see §4). This is legitimate: the docs describe pausing as protection against genuinely idle projects, and a lightweight daily query is exactly the "few user requests each day" that keeps it alive.

**Recovery (if it pauses anyway):**
1. Open the Supabase Dashboard → the organization → the paused project.
2. Click **Resume project** and confirm. It returns to its previous state (data + config intact). ([free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing))
3. Verify with the curl above (expect `200`).

---

### F2 — DB size exceeds 500 MB → read-only mode

**Policy (verified):** When a Free-plan project's **database size** (actual Postgres data, not the 1 GB disk) exceeds **500 MB**, the project enters **read-only mode**. Write queries fail with `cannot execute INSERT in a read-only transaction`. **Reads keep working.** ([database-size](https://supabase.com/docs/guides/platform/database-size), [changelog: 0.5 GB DB size on Free](https://supabase.com/changelog/33121-relaxing-database-size-limit-on-free-plan-0-5-gb-database-size-per-project))

**User-visible symptom:** Browsing works normally. Any write — adding a bathroom, posting/editing a review, uploading a photo's metadata row — throws. The app surfaces the raw error in the form's error state (e.g. `ReviewForm` `setError(...)`, `BathroomForm`). Users see "Could not save your review" with the Postgres message.

**Note for this app:** photo *bytes* count against the **1 GB storage** cap, not the 500 MB DB cap. What grows the DB is rows: reviews, bathrooms, profiles, and `review_photos` metadata. 500 MB is a lot of text rows, so F2 is a slow burn — but orphaned-object accumulation (F9) and table bloat make it come sooner than expected.

**Recovery (verified commands):** In the SQL Editor,
```sql
-- 1. Let this session write despite read-only mode:
set session characteristics as transaction read write;
-- 2. Delete unneeded data (old drafts, spam, orphaned rows), then reclaim space:
vacuum;
-- 3. Turn read-only mode off permanently once back under 500 MB:
set default_transaction_read_only = 'off';
```
([database-size](https://supabase.com/docs/guides/platform/database-size)) The lasting fix is to keep the DB small: run the orphan reaper (F9), and don't store large text blobs. Upgrading to Pro raises the ceiling but breaks the free constraint.

---

### F3 — Egress / organization quota exceeded → Fair-Use 402

**Policy (verified):** Free plan includes **5 GB egress** (historically split as ~5 GB database egress + ~5 GB cached egress — verify the current split on the pricing page ([pricing](https://supabase.com/pricing))). When an **organization** exceeds its plan quota, it can be placed under a **Fair-Use service restriction**: requests return **HTTP 402**. The DB-size quota that can trigger this is evaluated **per organization** (summed across projects) on the **average daily size over the billing period**, not the live number. ([database-size](https://supabase.com/docs/guides/platform/database-size), [billing-on-supabase](https://supabase.com/docs/guides/platform/billing-on-supabase))

**Why the free plan can't surprise-bill you:** there's no payment method and no spend cap concept on Free — so exceeding limits produces **restriction, not a bill**. ([billing-on-supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)) The specific 402/read-only enforcement thresholds are the enforcement mechanism.

**User-visible symptom:** API calls return 402; the app shows the generic error state everywhere. Looks like a total outage but is a quota block.

**Mitigation:** The largest egress risk for this app is **not** the basemap (that's on R2, $0 egress) — it's someone scraping the public REST API, or a photo hotlink. Keep the basemap on R2 (done by design). Cap list queries (already `limit: 500` on the map, `DEFAULT_LIMIT = 50` on lists — `src/lib/api/bathrooms.ts:11`). If reads spike, the read-only/402 restriction is temporary and resets on the billing boundary.

**Recovery:** Reduce usage and wait for the period reset; or (paid) upgrade. Confirm the 402 with the health cron.

---

### F4 — Basemap unavailable (R2 down / file deleted / CORS or Range broken)

**Symptom:** Map tiles fail to render. **The page must not crash** — pins are DOM markers overlaid on the map and are independent of the tile source.

**Detection:** Health cron issues a ranged HEAD and asserts `206 Partial Content` + `accept-ranges: bytes` (PMTiles requires Range). See §4.

**Failure sub-cases and fixes:**
- **File deleted / 404** → re-upload `basemap/us-z13.pmtiles` to R2 (it's a reproducible artifact rebuilt by `scripts/build-basemap.sh`; the ~4.15 GB copy also lives in `basemap/`). RTO = upload time.
- **CORS blocked (403 in browser, cron may still pass server-side)** → R2 bucket needs a CORS policy allowing ranged GET/HEAD from the app origin:
  ```json
  [
    {
      "AllowedOrigins": ["https://<your-app-domain>"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["range", "if-match"],
      "ExposeHeaders": ["content-range", "content-length", "etag", "accept-ranges"],
      "MaxAgeSeconds": 86400
    }
  ]
  ```
- **Range not honored** (returns `200` for the whole file instead of `206`) → PMTiles will try to download the entire 4.15 GB file. R2 honors Range by default; if this regresses, that's the alarm. ([R2 pricing / behavior](https://developers.cloudflare.com/r2/pricing/))

**Degradation:** designed in §3.1 — swap to a blank style, keep the pins. **Interim (Leaflet/OSM) note:** the current code degrades differently — dead OSM tiles just render as gray squares; Leaflet doesn't crash. That's acceptable but is the OSM policy risk flagged in `docs/TECH_EVALUATION.md` §2.1, which is *why* we move to R2.

---

### F5 — Bad migration (forward-only, no rollback story)

**Problem:** `supabase/migrations/` is forward-only. There is currently **no down migration and no rollback**. A migration that drops/renames the wrong thing, or half-applies, can break the schema the app depends on (`src/types/db.ts` is a hand-maintained mirror — a drift here breaks reads too).

**This is the honest rollback story for a free-tier project: the pre-migration backup IS the rollback.** Adopt this discipline:

1. **Snapshot immediately before every migration.** Run the §3 dump against prod *first*. Label it `pre-<migration-name>`.
2. **Wrap each migration in a transaction** so a failure auto-rolls-back instead of leaving a half-applied schema:
   ```sql
   begin;
   -- ... DDL ...
   commit;
   ```
   (Supabase does not guarantee per-file transactional application; make it explicit. Some statements — e.g. `create index concurrently` — cannot run in a transaction; isolate those into their own file.)
3. **Test on a throwaway first:** apply the new migration to a local `supabase start` (or a second free project) loaded from the latest dump, and boot the app against it, before touching prod.
4. **Recovery if prod is already broken:** restore the `pre-<migration>` dump via the §3 restore drill. Because schema comes from git and data from the dump, "roll back" = "re-point to the last good state."

**Optional hardening:** adopt a convention of shipping a paired `-- DOWN` block (as a comment or a sibling `..._down.sql`) documenting the reverse of each migration, so a rollback is a copy-paste, not an archaeology exercise.

---

### F6 — Auth outage / token-refresh failure (does it nuke anonymous reads?)

**Answer: No — reads survive. Verified by tracing the code.**

- The client is a **single** instance created with the anon key (`src/lib/supabase.ts`). The anon key is what authorizes **public reads**; it is embedded in the bundle and never expires with a session.
- `AuthProvider` (`src/auth/AuthProvider.tsx`) bootstraps the session with `getSession()` and subscribes to `onAuthStateChange`. A **token-refresh failure** fires a `TOKEN_REFRESHED` failure / `SIGNED_OUT` event; the handler simply does `setSession(nextSession)` (line 64–66). Worst case `session` becomes `null` → the app treats the user as **signed out**, not broken.
- When `session` is `null`, PostgREST requests still carry the **anon apikey**, so RLS `select using (true)` policies still return data. `AuthProvider` never throws on a missing session; `loading` flips to `false` after the first `getSession()` resolves regardless of outcome (line 55–62).

**So a GoTrue outage or an expired/failed refresh degrades to "logged-out browsing," which is fully functional for reads.** Only *writes* and *sign-in* are blocked (F1/F2-class behavior).

**Detection:** `GET /auth/v1/health` ≠ 200 (see §4). **Recovery:** bounded by Supabase; nothing to do on our side except confirm reads still work and wait.

**One caveat to watch [unverified]:** if a *stale/invalid* JWT is ever attached and PostgREST rejects it (401) rather than falling back to anon, a signed-in user could see read failures a signed-out user wouldn't. The mitigation is already present: on refresh failure the session is cleared to `null` (anon), not kept as a bad token. Confirm by forcing a refresh failure (revoke the session server-side, then load the list) and verifying the list still renders.

---

### F7 — Postgres connection exhaustion / long-running query pile-up

**Risk on this app:** low. The client talks to **PostgREST over the pooler**, not raw connections, and queries are simple indexed lookups (`bathrooms_lat_lng_idx`, `reviews_bathroom_id_idx`). The one unindexed hazard is the leading-`%` `ILIKE` search (`src/lib/api/bathrooms.ts:96`), a sequential scan on every search — cheap at small scale, a pile-up risk at large scale. The `pg_trgm` GIN index in `docs/TECH_EVALUATION.md` §7 fixes it.

**Detection:** health cron latency and 5xx. **Recovery:** the pooler recycles connections; transient. If chronic, add the trigram index and cap `range()` sizes (already bounded).

---

### F8 — Account deletion cascade: silent destruction of reviews + orphaned bathrooms

**What the schema does (verified from the migration):**
- `profiles.id → auth.users on delete cascade` — deleting an auth user deletes the profile.
- `reviews.author_id → profiles on delete cascade` — **deleting the profile deletes all their reviews.**
- `bathrooms.created_by → profiles on delete set null` — their added bathrooms **survive but become orphaned** (`created_by` = null).
- `review_photos.review_id → reviews on delete cascade` — photo *rows* vanish with the review (but the *objects* don't — see F9).

**Is this intended?** Partially. Two different judgments:
- **`bathrooms.created_by → set null` is correct.** A bathroom is a shared place, not owned content. Orphaning (keeping the entry, dropping the author link) is the right call.
- **`reviews → cascade` is the sharp edge.** Deleting an account **silently destroys all that person's reviews**, which yanks community content and makes `bathroom_stats` averages drop retroactively. For a ratings directory this is usually *not* what you want — Yelp/Reddit tombstone content and anonymize the author instead.

**Current exposure is latent, not live:** there is **no in-app account-deletion path** (`src/pages/Profile.tsx` only edits the username). The only way to trigger the cascade today is the owner deleting a user from the dashboard, or a future GDPR "delete my account" feature. So this is a **design decision to make before shipping deletion**, not an active incident.

**Recommendation — soft-delete / tombstone (for the DATA agent; not applied here):**
Prefer **deactivating the profile** over deleting the auth user, so reviews and aggregates are preserved:
```sql
-- Sketch only. Owner: DATA agent applies via a new forward migration.
alter table public.profiles add column deleted_at timestamptz;

-- "Delete account" = anonymize in place, keep the reviews:
update public.profiles
set username = 'deleted_' || substr(id::text, 1, 8),  -- keep it unique + valid vs the username regex
    avatar_url = null,
    deleted_at = now()
where id = :uid;
-- Do NOT delete from auth.users (that is what triggers the cascade).
```
Notes and gotchas:
- Reassigning *all* deleted users to one shared `[deleted]` sentinel profile would violate `unique (bathroom_id, author_id)` if two deleted users reviewed the same bathroom. Per-user anonymization (above) avoids that.
- If true auth-record deletion is legally required (GDPR erasure), first **re-parent or tombstone the reviews** (e.g. add a nullable `author_id` + `author_deleted boolean`, null the FK, keep body/rating) so the content survives the `auth.users` delete. That is a schema change with care around the NOT NULL + unique constraints.

**Recovery today:** none, without a backup. This is precisely why §3 dumps `auth.users` and `public.reviews`.

---

### F9 — Orphaned storage objects when a review is deleted

**The gap (verified from code + schema):** `deleteReviewPhoto` (`src/lib/api/photos.ts:52`) correctly removes **both** the row and the storage object. But **deleting a *review*** (`deleteReview`, `src/lib/api/reviews.ts:55`) only deletes the `reviews` row; the DB cascade removes the `review_photos` **rows**, but **storage objects are not in Postgres and are never touched.** Every review deletion that had photos leaves those image bytes stranded in the `review-photos` bucket, consuming the 1 GB cap forever (accelerating F2/storage exhaustion).

**Fix A — reap on delete (primary; DATA agent).** Delete the storage rows when the parent review goes, in the same cascade path. In Supabase, `storage.objects` is the metadata table the storage service reads, so removing those rows is the supported way to drop the objects:
```sql
-- Sketch only. Before the review is deleted, remove its objects' storage rows.
create or replace function public.reap_review_photo_objects()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from storage.objects
  where bucket_id = 'review-photos'
    and name in (select storage_path from public.review_photos where review_id = old.id);
  return old;
end;
$$;
create trigger reviews_reap_photos
  before delete on public.reviews
  for each row execute function public.reap_review_photo_objects();
```
Whether deleting the `storage.objects` row reclaims the byte immediately is **[unverified]** — confirm by deleting a review with a photo and watching Storage usage. If Supabase GC is async, bytes free up on its schedule.

**Fix B — periodic sweep (for objects already orphaned).** A scheduled job (pg_cron if enabled, else the GitHub Actions cron with the **service_role** key held as a secret) lists orphans and deletes them:
```sql
select o.name
from storage.objects o
where o.bucket_id = 'review-photos'
  and not exists (select 1 from public.review_photos p where p.storage_path = o.name);
```
Then delete each via the storage API (or the trigger's `delete from storage.objects`).

---

### F10 / F11 — Static host outage / total project loss

- **F10 (static host down):** the whole app 404s. Free static hosts (Pages/Netlify) are highly available; recovery is a redeploy or rollback to the last good build. Detection: health cron on the app URL.
- **F11 (total project loss):** project deleted after the 90-day pause window, or an org/account issue. This is the disaster the **restore drill** (§3) exists for. RTO = time to stand up a fresh project + apply migrations + load the last dump.

---

## 3. Backups & restore

### 3.1 What Supabase's free tier actually gives you (verified)

**Nothing automatic.** Supabase runs **no automated backups and no PITR on the free tier**, and explicitly says: *"We recommend that free tier plan projects regularly export their data using the Supabase CLI `db dump` command and maintain off-site backups."* Daily backups are Pro+ (Pro **7 days**, Team **14 days**, Enterprise **30 days**). PITR is a **paid usage-based add-on** (Pro+, and it requires at least a Small compute add-on); enabling PITR *disables* daily backups. ([backups](https://supabase.com/docs/guides/platform/backups), [PITR usage](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery))

**Conclusion:** on free tier, **backups are entirely our responsibility.** We build one that does not depend on Supabase's backup infrastructure at all.

### 3.2 Is GitHub Actions a "third-party service"? (honest evaluation)

The repo already lives on GitHub. A backup cron on GitHub Actions is:
- **Not on the runtime hot path.** No user request depends on it. If GitHub Actions vanished, the *app keeps running*; only the backup/health automation stops. That makes it **off-path tooling (tier B-ish)**, not a tier-C runtime dependency like the OSM tile server we're retiring.
- **Free within limits.** Public repo: unlimited GitHub-hosted minutes. Private repo Free plan: **2,000 Linux minutes/month + 500 MB artifact storage.** ([Actions billing/usage](https://docs.github.com/en/actions/concepts/billing-and-usage), [GitHub pricing](https://github.com/pricing)) A nightly `pg_dump` + a 6-hourly health probe run in ~1–3 min each → on the order of ~100–200 min/month — **well inside 2,000** even on a private repo. The one caveat: encrypted dump artifacts count against the 500 MB artifact storage, so keep `retention-days` modest or push to a private repo/R2 instead.

**Verdict:** acceptable and self-sufficient. It's free, off-path, and reversible.

### 3.3 What to dump (and what not to)

- **Schema:** do **not** dump it — it already lives in git (`supabase/migrations/*.sql`) and is the source of truth. Restore = re-apply migrations.
- **Data (own it):** `public.profiles`, `public.bathrooms`, `public.reviews`, `public.review_photos`.
- **Accounts (best-effort):** `auth.users`, `auth.identities` — so logins survive a total-project restore. This is the fragile part (see restore caveats).
- **Exclude:** `bathroom_stats` (it's a view — recomputed), `storage.migrations`, `auth.audit_log_entries`, `auth.flow_state` (churn/noise).
- **Storage bytes (photos) are NOT in `pg_dump`.** `pg_dump` captures the `review_photos`/`storage.objects` **metadata**, never the image bytes. Backing up photos requires a **separate object sync** (§3.6). Skipping it is a documented accepted risk (§7).

### 3.4 The dump — a `pg_dump` script + a GitHub Actions cron

**Connection-string gotcha (important):** GitHub-hosted runners are **IPv4-only**, but Supabase's **direct** connection (`db.<ref>.supabase.co:5432`) is now IPv6. Use the **Session Pooler** connection string (IPv4, port 5432) for `pg_dump` from Actions — *not* the Transaction pooler (which breaks `pg_dump`'s prepared statements). Find it in Dashboard → Project Settings → Database → Connection string → **Session pooler**. Also **match `pg_dump`'s major version to the server** (Dashboard → Project Settings → Infrastructure) or you'll hit `server version mismatch`.

`.github/workflows/backup.yml` (for the owner to add — this doc does not create it):
```yaml
name: backup
on:
  schedule: [{ cron: '30 8 * * *' }]   # 08:30 UTC daily
  workflow_dispatch:
jobs:
  dump:
    runs-on: ubuntu-latest
    steps:
      - name: Install client + age
        run: |
          sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
          curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
          sudo apt-get update && sudo apt-get install -y postgresql-client-17 age   # match server major
      - name: pg_dump (data + accounts; schema comes from git)
        env:
          PGCONN: ${{ secrets.SUPABASE_SESSION_POOLER_URL }}   # session pooler, IPv4
          AGE_RECIPIENT: ${{ secrets.AGE_RECIPIENT }}          # age public key
        run: |
          stamp=$(date -u +%Y%m%dT%H%M%SZ)
          pg_dump "$PGCONN" --data-only --no-owner --no-privileges \
            -t public.profiles -t public.bathrooms -t public.reviews -t public.review_photos \
            -t auth.users -t auth.identities \
            | gzip > "watrloo-$stamp.sql.gz"
          echo "$AGE_RECIPIENT" > age.txt
          age -R age.txt -o "watrloo-$stamp.sql.gz.age" "watrloo-$stamp.sql.gz"
          rm -f "watrloo-$stamp.sql.gz" age.txt
      - uses: actions/upload-artifact@v4
        with: { name: db-backup, path: '*.age', retention-days: 30 }
```
**Encryption:** dumps contain emails and password hashes — never store them plaintext. `age` (or `gpg`) with a public key you hold the private key for. The runner only ever has the *public* recipient; only you can decrypt. For durability beyond 30 days, additionally push the `.age` file to a **private repo** or an **R2 bucket** (R2 is already in the stack, $0 egress, 10 GB free).

**Manual equivalent (run locally any time):**
```bash
export PGCONN='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
pg_dump "$PGCONN" --data-only --no-owner --no-privileges \
  -t public.profiles -t public.bathrooms -t public.reviews -t public.review_photos \
  -t auth.users -t auth.identities | gzip > backup.sql.gz
age -r <AGE_PUBLIC_KEY> -o backup.sql.gz.age backup.sql.gz && rm backup.sql.gz
```

### 3.5 Restore drill — spelled out (a backup you have never restored is not a backup)

There are two disaster shapes; the drill differs.

**Mode A — same project, localized damage** (dropped table, bad migration F5). `auth.users` still exists, so FKs from `profiles` are satisfiable. Restore only the affected `public` tables.

**Mode B — total loss into a fresh project** (F11). `auth.users` is empty in the new project, so you must load accounts first, and you must relax triggers/FKs during the load (the `on_auth_user_created` trigger would otherwise fire on every `auth.users` insert and race the profile load).

**Full Mode-B drill:**
```bash
# 0. Decrypt the latest backup.
age -d -i ~/.age/watrloo.key backup.sql.gz.age | gunzip > restore.sql   # plaintext, handle carefully

# 1. Stand up a fresh project (Dashboard) OR local:  supabase start
supabase link --project-ref <NEW_REF>

# 2. Recreate the schema from git (source of truth) — this also creates the
#    on_auth_user_created trigger, RLS, and the storage bucket.
supabase db push        # applies supabase/migrations/*.sql

# 3. Load data with triggers + FK checks DISABLED for the session, so the
#    signup trigger doesn't mint duplicate profiles and load order doesn't matter.
NEW_DB='postgresql://postgres.<NEW_REF>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
{ echo 'set session_replication_role = replica;'; cat restore.sql; } \
  | psql "$NEW_DB" -v ON_ERROR_STOP=1 --single-transaction

# 4. Sanity-check row counts match the source (see drill assertions below).

# 5. Re-point the app at the new project and redeploy:
#    VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY -> new project's URL + anon key.

# 6. Basemap: R2 is independent of Supabase — nothing to do unless R2 also failed
#    (then re-upload basemap/us-z13.pmtiles and restore the CORS policy from F4).

# 7. Photos: only recoverable if the storage sync (§3.6) ran; otherwise image
#    bytes are gone though review_photos rows exist (broken <img> links).
rm -f restore.sql       # destroy the plaintext dump
```

**Restore caveats (state them honestly):**
- `set session_replication_role = replica` requires the connecting role to be a superuser/`postgres`; the session pooler `postgres` role qualifies. It disables triggers **and** FK checks for the load — exactly what we want.
- **Cross-version `auth.users` restore is the fragile part.** Supabase manages the `auth` schema and can change its columns between versions. Restore into a project on the **same/similar Supabase version**; if the auth columns drifted, the `public.*` (app content) still restores cleanly — **accounts are best-effort, app data is durable.**
- `--single-transaction` means the whole load commits or rolls back atomically — no half-restored state.

**Quarterly drill (do this, don't just read it):**
```bash
supabase start                                  # throwaway local project
supabase db push
{ echo 'set session_replication_role=replica;'; cat restore.sql; } | psql "$LOCAL_DB" --single-transaction
psql "$LOCAL_DB" -c "select
  (select count(*) from public.bathrooms)     as bathrooms,
  (select count(*) from public.reviews)       as reviews,
  (select count(*) from public.profiles)      as profiles,
  (select count(*) from auth.users)           as users;"
# Assert these match the source, then boot the SPA against the local project and load Home.
```
Record the date of the last successful drill in this file's changelog. **Until a restore has actually succeeded once, treat RPO/RTO in §6 as unproven.**

### 3.6 Photos (storage bucket) — separate sync

Photo bytes live only in the `review-photos` bucket. Supabase exposes an **S3-compatible endpoint**; sync it to R2 or local with `rclone`/`aws s3 sync` using Storage S3 access keys (Dashboard → Project Settings → Storage → S3 access keys):
```bash
rclone sync sb-storage:review-photos r2:watrloo-photo-backup   # sb-storage/r2 = rclone remotes
```
If you skip this, photos are an **accepted-loss** item (§7): a restore rebuilds the `review_photos` rows but the `<img>` targets 404.

---

## 4. Health checks & runbook

### 4.1 What to probe, from where

A static SPA has no server to expose `/healthz`, so the health check lives **outside** it: a **GitHub Actions cron** (free, off-path) that probes each dependency and doubles as the F1 anti-pause ping.

`.github/workflows/healthz.yml` (for the owner to add):
```yaml
name: healthz
on:
  schedule: [{ cron: '17 */6 * * *' }]   # every 6h — also keeps Supabase active (F1)
  workflow_dispatch:
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: PostgREST reachable (READ probe + anti-pause activity)
        run: |
          c=$(curl -s -o /dev/null -w '%{http_code}' \
            -H "apikey: ${{ secrets.SUPABASE_ANON_KEY }}" \
            "${{ secrets.SUPABASE_URL }}/rest/v1/bathrooms?select=id&limit=1")
          echo "PostgREST=$c"; test "$c" = "200"     # 401/5xx=paused, 402=egress fair-use
      - name: Auth (GoTrue) healthy
        run: |
          c=$(curl -s -o /dev/null -w '%{http_code}' "${{ secrets.SUPABASE_URL }}/auth/v1/health")
          echo "Auth=$c"; test "$c" = "200"
      - name: Basemap present + Range works (F4)
        run: |
          h=$(curl -sI -H 'Range: bytes=0-0' "${{ secrets.PMTILES_URL }}")
          echo "$h" | grep -qi '206 Partial Content'
          echo "$h" | grep -qi 'accept-ranges: bytes'
      - name: App shell serves (F10)
        run: |
          curl -sf "${{ secrets.APP_URL }}" | grep -qi '<title>Watrloo'
```
**Alerting is self-sufficient:** a failed step fails the job, and **GitHub emails the repo owner** on workflow failure — no third-party alerting service needed. (Optionally `gh issue create` on failure for a paper trail.) Ensure the Supabase account email and GitHub notification email are ones you actually read — the F1 warning email is the same channel.

### 4.2 Runbook (numbered, for 2am)

**Symptom: app loads, but no bathrooms / spinner → "Couldn't load" everywhere.**
1. Run: `curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" "$URL/rest/v1/bathrooms?select=id&limit=1"`.
2. `401` or connection error / 5xx → **project is paused (F1)**. Dashboard → project → **Resume project**. Re-run curl until `200`. Then check why the anti-pause cron didn't fire (workflow disabled? secrets rotated?).
3. `402` → **egress/Fair-Use restriction (F3)**. Check Dashboard → Usage. Reduce load; it resets on the billing boundary. Don't panic — it's a quota block, not data loss.
4. `200` but the app still errors → suspect the static host (jump to the map/shell symptom) or a client bug from a recent deploy → roll back the last deploy.

**Symptom: writes fail ("Could not save…"), but browsing works.**
1. Read the error. `cannot execute INSERT in a read-only transaction` → **DB over 500 MB, read-only (F2)**. SQL Editor: run the three `set …` / `vacuum` commands from F2. Then find what grew it (orphaned photos? run F9 reaper).
2. Auth error / `401` on write only → **sign-in/token problem (F6)**. Confirm `/auth/v1/health`. Reads are fine; wait it out. Verify a signed-out load of Home still works (it should).

**Symptom: map is blank or pins float on a gray/empty background.**
1. Run: `curl -sI -H 'Range: bytes=0-0' "$PMTILES_URL"`.
2. Not `206` / missing `accept-ranges` → **basemap problem (F4)**. `404` → re-upload `basemap/us-z13.pmtiles` to R2. `403` in-browser but `206` from curl → **CORS**: reapply the R2 CORS policy from F4. Whole-file `200` instead of `206` → Range regression; open an R2 support/status check.
3. **Do not treat this as a P1** — pins still render and the app is usable; fix at leisure.

**Symptom: nothing loads at all (blank page / 404 on the app URL).**
1. `curl -sf "$APP_URL"` → non-200 → **static host / build outage (F10)**. Check the host's dashboard; redeploy or roll back to the last good build.

**Symptom: just applied a migration and the app is throwing.**
1. **Bad migration (F5).** Do not attempt ad-hoc SQL surgery under pressure. Restore the `pre-<migration>` dump via the §3 restore drill (Mode A if same project). Re-test the migration on a throwaway before reapplying.

**Symptom: storage usage creeping toward 1 GB.**
1. **Orphaned objects (F9).** Run the orphan-finder query (F9 Fix B), delete the strays, and add the reap-on-delete trigger (F9 Fix A) so it stops recurring.

---

## 5. RPO / RTO targets (honest, for a free-tier hobby app)

**RPO** = max acceptable data loss (how far back you rewind). **RTO** = max acceptable downtime.

| Scenario | RPO (with the plan here) | RTO (with the plan here) | Cost to improve |
|---|---|---|---|
| **Pause (F1)** | **0** — no data lost | **~0** — *prevented* by the 6-hourly cron; if it slips, minutes to click Resume | already free |
| **Read-only / 402 (F2/F3)** | 0 — reads never stop | minutes (F2 SQL) to hours (F3 reset) | Pro plan removes the ceiling ($25/mo) |
| **DB data loss / bad migration / total loss (F5/F11)** | **≤ 24 h** (daily dump); ≤ 6 h if you dump 4×/day | **~30–60 min** to restore into a fresh project | Pro daily backups → ≤24 h managed; **PITR add-on → seconds/minutes**, paid |
| **Basemap loss (F4)** | **~0** — reproducible artifact + local 4 GB copy | minutes (re-upload) to hours (rebuild) | keep a second R2 copy (free) |
| **Photos (storage)** | **∞ unless §3.6 sync runs**; then ≤ sync interval | rows restore instantly; bytes only if synced | run the `rclone` sync (free) |
| **Static host (F10)** | 0 (build is in git) | minutes (redeploy) | multi-host / CDN (free-ish) |

**The single cheapest RPO/RTO win is the daily dump + 6-hourly health cron** — both free, both on GitHub Actions. Everything better than "≤24 h RPO / ~1 h RTO for a full loss" costs the Pro plan or the PITR add-on and breaks the free constraint. That trade is stated deliberately, not by omission.

---

## 6. Degradation design (code sketches)

> These are sketches for the FEATURES agent to implement in the relevant source files. This doc changes no source.

### 6.1 Basemap gone → pins on a plain background (never crash) — F4

MapLibre surfaces source/tile failures on the map's `error` event. Catch it, swap to a style with a single background layer, and keep going. **Markers are DOM overlays, independent of the style — they survive `setStyle`.**
```ts
// In the rewritten BathroomMap.tsx (MapLibre), after `const map = new maplibregl.Map(...)`
const BLANK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e7ecf0' } }],
};
let degraded = false;
map.on('error', (e) => {
  const msg = String((e as any).error?.message ?? '');
  if (!degraded && /pmtiles|tile|source|range|fetch|basemap/i.test(msg)) {
    degraded = true;
    map.setStyle(BLANK_STYLE);   // pins (DOM Markers) persist across the swap
  }
});
```
**Interim (Leaflet/OSM):** already degrades safely — dead tiles render as gray; no crash. No change needed until the MapLibre migration lands.

### 6.2 Reads failing → cached data or a real retry — F1/F3/F6

**Today (no TanStack Query):** the app already does the right *minimum* — a real error state with a retry button in each data page (`src/pages/Home.tsx:108`, `MapPage.tsx:55`, `BathroomDetail.tsx:102`). No silent spinner-forever.

**Upgrade (when TanStack Query is adopted — `docs/TECH_EVALUATION.md` §2):** persist the query cache to `localStorage` so a paused/So-down project still shows the **last-seen** bathrooms instead of an empty error:
```ts
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, gcTime: 24 * 60 * 60_000, retry: 2 } },
});
persistQueryClient({
  queryClient,
  persister: createSyncStoragePersister({ storage: window.localStorage }),
  maxAge: 24 * 60 * 60_000,   // show yesterday's list if the API is down today
});
```
Now a Supabase outage degrades to "slightly stale directory" instead of "blank error."

### 6.3 Writes failing → never lose the user's typed review — F2 (and offline)

Persist the in-progress review to `localStorage`, keyed by bathroom id; restore on reload; clear on successful save. This turns a failed write from "you lost your paragraph" into "your text is still here, hit Post again."
```ts
// src/lib/draft.ts  (sketch for FEATURES agent)
const key = (bathroomId: string) => `watrloo:review-draft:${bathroomId}`;
export interface ReviewDraft {
  rating: number | null; cleanliness: number | null; privacy: number | null;
  accessibility: number | null; body: string; savedAt: number;
}
export function loadDraft(id: string): ReviewDraft | null {
  try { const r = localStorage.getItem(key(id)); return r ? JSON.parse(r) as ReviewDraft : null; }
  catch { return null; }
}
export function saveDraft(id: string, d: Omit<ReviewDraft, 'savedAt'>): void {
  try { localStorage.setItem(key(id), JSON.stringify({ ...d, savedAt: Date.now() })); }
  catch { /* quota / Safari private mode: best-effort, ignore */ }
}
export function clearDraft(id: string): void {
  try { localStorage.removeItem(key(id)); } catch { /* ignore */ }
}
```
Wiring into `ReviewForm` (`src/components/review/ReviewForm.tsx`):
- **On mount**, after `getMyReview` returns *no* server review, hydrate state from `loadDraft(bathroomId)` (don't clobber an existing server review).
- **On any field change** (debounced ~500 ms), call `saveDraft` when there's anything worth keeping (`rating != null || body.trim()`).
- **On successful `upsertReview`**, call `clearDraft(bathroomId)` right before `onSaved()`.

The same pattern applies to `NewBathroom`/`BathroomForm` (key it by a stable string like `watrloo:bathroom-draft:new`). Because it's `localStorage`, the draft also survives a full page crash, a signal drop, and a browser restart.

### 6.4 Offline PWA — re-argued for the actual use case

The PWA was deferred (`docs/TECH_EVALUATION.md` §8). **Re-argue to adopt it (phase 2, read-only):** the canonical Watrloo moment is *"I'm in a basement / parking garage / unfamiliar building with one bar and I need a bathroom right now."* That is **exactly when the network fails** — the app is least available precisely when it's most needed. A service worker makes it degrade gracefully there:

- **Precache the app shell** → installable ("Add to Home Screen"), opens instantly with no network.
- **Runtime-cache Supabase `GET` (list/detail) `stale-while-revalidate`** → the last-seen nearby bathrooms render offline. Pairs with 6.2's persisted cache.
- **Cache PMTiles byte-ranges** → the map paints on a cold connection from previously-viewed tiles.

Keep it read-only: **no offline write queue** (sync/conflict cost isn't worth it). Offline write attempts fall through to the §6.3 draft — the review is safe in `localStorage` and posts when signal returns. This is polish that directly serves the core use case; recommend re-prioritizing it above nice-to-haves.

---

## 7. Deliberately accepted risks

These are conscious trade-offs for a free-tier hobby app, not oversights:

1. **No PITR; RPO up to the dump interval (≤24 h).** A total loss rewinds to the last daily dump. Fixing this means the Pro plan + PITR add-on (paid) — rejected by the constraint. Mitigation: dump more often (4×/day is still trivially within Actions minutes).
2. **Photos are not in `pg_dump`.** Unless the optional §3.6 storage sync runs, a restore leaves `review_photos` rows pointing at 404s. Accepted until the `rclone` sync is set up (free to add).
3. **Single region, single project — no HA.** A Supabase regional/platform outage takes reads **and** writes down; there is no failover on free tier. RTO is bounded entirely by Supabase. Accepted.
4. **`auth.users` restore is best-effort/cross-version-fragile.** App content (`public.*`) is the durable, always-recoverable tier; user accounts may not survive a cross-version restore. Accepted; documented in the drill.
5. **90-day pause-deletion cliff.** After 90 days paused, the project (and its live data) may be permanently deleted. Mitigated by the anti-pause cron (prevents pausing) **and** external dumps (survive deletion). ([free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing))
6. **Account-deletion cascade destroys reviews** (F8). Accepted **only because there is no in-app deletion path today.** Must be resolved (soft-delete/tombstone) *before* shipping any "delete my account" feature.
7. **Orphaned storage objects accumulate** (F9) until the reaper trigger/sweep lands. Slow burn against the 1 GB cap; accepted short-term, fix is cheap.
8. **No CDN in front of the Supabase REST API.** Public reads hit PostgREST directly; a scrape or viral spike can trip the egress/Fair-Use limit (F3). Accepted; the basemap (the big bytes) is already off Supabase on R2.
9. **GitHub Actions is a soft dependency for backups/health.** If it were unavailable, the app keeps running but backups/health/anti-pause stop silently. Mitigation: it emails on failure; keep an eye on the workflow runs.

---

## Sources (platform claims)

- Supabase project pausing (7-day inactivity, warning + confirmation emails, 90-day restore window, Resume flow): https://supabase.com/docs/guides/platform/free-project-pausing
- Supabase free-tier backups (none automatic; PITR paid; Pro 7 / Team 14 / Enterprise 30 days; "export via `db dump`, keep off-site"): https://supabase.com/docs/guides/platform/backups
- Supabase PITR (paid add-on, needs compute add-on, disables daily backups): https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- Supabase DB size 500 MB → read-only; recovery SQL; org Fair-Use 402: https://supabase.com/docs/guides/platform/database-size
- Supabase 0.5 GB free DB size (changelog): https://supabase.com/changelog/33121-relaxing-database-size-limit-on-free-plan-0-5-gb-database-size-per-project
- Supabase pricing / free-tier limits (500 MB DB, 1 GB storage, 5 GB egress, 50k MAU, 2 projects): https://supabase.com/pricing
- Supabase billing (no free-plan overage billing / restriction model): https://supabase.com/docs/guides/platform/billing-on-supabase
- Cloudflare R2 free tier (10 GB storage, 1M Class A, 10M Class B, $0 egress, permanent): https://developers.cloudflare.com/r2/pricing/
- GitHub Actions billing (public: free; private Free plan: 2,000 Linux min + 500 MB artifacts): https://docs.github.com/en/actions/concepts/billing-and-usage , https://github.com/pricing

**Unverified items (with tests) flagged inline:** exact HTTP status of a *paused* project (F1 test given); whether deleting a `storage.objects` row reclaims bytes synchronously (F9 test given); PostgREST behavior on a stale JWT vs. anon fallback (F6 test given); current egress split (5 GB DB vs. cached — check the pricing page).
