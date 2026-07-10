# Watrloo — Scaling & Performance

**Author:** SCALING & PERFORMANCE agent · **Date:** 2026-07-09
**Constraint honored:** self-sufficient, no paid third-party services. Supabase is the backend (Postgres/Auth/Storage + PostgREST). The `.pmtiles` basemap goes on Cloudflare R2's free tier; the SPA is static and can go on any free static host/CDN.

> **First, the honest framing.** "Load balancing" in the classic sense — an nginx/HAProxy in front of app servers — **is not a knob this architecture exposes and there is nothing to build here.** Supabase runs the Postgres instance and PostgREST behind its own edge/API gateway; you do not get to place a proxy in front of Postgres, and you should not try. The SPA is a bag of static files, so "load balancing" it just means "serve it from a CDN," which is a *caching* problem, not a proxy problem. Read replicas / horizontal DB scaling are a **paid** Supabase feature you configure in their dashboard, not something you stand up. So this document spends **zero** effort on a load balancer and redirects all of it to where the wins actually are: **query shape, indexes, payload size, and moving bytes off Supabase's metered egress onto free-egress hosts.** See §5 for the load-balancer non-problem stated in full.

---

## 1. Where this actually breaks first

All limits below are the **Supabase Free plan** and **Cloudflare R2 Free** limits, verified against the vendors' own pages (URLs cited in §4). Arithmetic assumptions (KB/photo, photos/page) are labeled as **modeled**; the limits themselves are **verified**.

| # | Limit that bites | Verified cap | Rough break point | Primary fix |
|---|---|---|---|---|
| **1** | **Storage, uncompressed photos** | 1 GB file storage | **~200 photos** at the 5 MB bucket cap (`1 GB / 5 MB`). Breaks almost immediately. | **Mandatory client-side compression before upload** → ~200 KB WebP → **~5,000 photos**. |
| **2** | **Egress / bandwidth** | 5 GB/mo (+5 GB cached, separate) | **~55 photo-viewing DAU** with full images; **~280 DAU** with thumbnails (modeled below). | Compress + generate thumbnails; **move basemap to R2** (free egress); **serve SPA from a CDN** so app JS/CSS egress never touches Supabase's 5 GB. |
| **3** | **Database size** | 500 MB | **~0.5–1M reviews** (rows are tiny; see math). Distant. | Denormalized counters keep rows lean; nothing to prune yet. |
| **4** | **Auth MAU** | 50,000 MAU | Never binds first — egress/storage break 100× sooner. | None needed. |
| **5** | **DB connections** | 60 direct / 200 pooler (Nano) | **Effectively never** for browser clients (they speak HTTP to PostgREST, not Postgres). | Non-issue for the SPA. Pooler only matters for migrations/server jobs (§ Connections). |
| **6** | **Inactivity pause** | Paused after **1 week** idle | Operational, not capacity: first request after a pause is slow/fails until the project wakes. | Accept it, or a cheap keep-warm ping. Not a scaling wall. |

**Headline:** for a photo-centric app, **Storage (1 GB) and Egress (5 GB/mo) are the walls, and both are dominated by image bytes.** Client-side compression is not a nice-to-have — it is the difference between "breaks at 200 photos" and "breaks at 5,000," and between "~55 DAU" and "~280 DAU." Everything else (the DB, connections, MAU) has an order of magnitude more headroom.

---

## 2. Database

### 2.1 `bathroom_stats` — a `GROUP BY` recomputed on every request

**What the code does today.** `src/lib/api/bathrooms.ts` fetches rows with `select *`, then `attachStats()` issues a **second** query to the `bathroom_stats` **view** and merges in JS:

```ts
// bathrooms.ts — attachStats()
await supabase.from('bathroom_stats').select('*').in('bathroom_id', ids);
```

The view (`20260710000000_init.sql`) is a `LEFT JOIN … GROUP BY` over the whole `reviews` table:

```sql
create view public.bathroom_stats with (security_invoker = on) as
select b.id as bathroom_id, count(r.id)::int as review_count,
       round(avg(r.rating)::numeric, 2) as avg_rating, /* …avg cleanliness/privacy/accessibility… */
from public.bathrooms b
left join public.reviews r on r.bathroom_id = b.id
group by b.id;
```

**How expensive is it, honestly?** The naive fear is "it re-aggregates the entire `reviews` table on every call." In practice it is *better* than that but still wasteful:

- Because the outer filter (`bathroom_id IN (...)`) is on the view's **GROUP BY key**, Postgres can push that predicate **below** the aggregation and scan only the selected bathrooms' reviews via `reviews_bathroom_id_idx`. So the list path (50 ids) and detail path (1 id) touch only *those* bathrooms' reviews, not all of them. **Confirm this with `EXPLAIN` on the real instance** — the plan should show the id filter on the `bathrooms` scan, not a full aggregate.
- **But there is no memoization.** `count`/`avg` are recomputed from raw review rows on **every** request. Cost scales with **reviews-per-bathroom × bathrooms-per-page**, and is *unbounded* for a hot bathroom. A bathroom with 10k reviews re-aggregates 10k rows on every single detail-page load; a 50-card list over a 1M-review / 10k-bathroom dataset (~100 reviews each) re-aggregates ~5,000 rows per request via index scans, forever, for a number that barely changes.
- The design also forces the **two-query** pattern: PostgREST cannot embed a view with no FK relationship (`PGRST200`), so every list/map load is 2 round-trips.

**Fix: denormalized counter columns on `bathrooms`, maintained by triggers.** This is the right call over a materialized view for *this* workload:

| | Trigger-maintained counters | Materialized view + `pg_cron` |
|---|---|---|
| Read cost | **O(1)** — plain column read, no join, no aggregate | O(1) read, but… |
| Write cost | **O(1)** per review insert/update/delete | zero on write, but… |
| Refresh cost | none — updated in the same txn | **O(all reviews)** every refresh, whether or not anything changed |
| Freshness | **always consistent** (same transaction) | stale up to the refresh interval |
| Extra moving parts | one trigger fn | a matview + a `pg_cron` job to babysit |

Reads vastly outnumber writes here (a review is written once, shown on every card/pin/detail). **Triggers win on every axis that matters:** reads become trivial, writes pay a tiny bounded cost, the value is always fresh, and — crucially — it **eliminates the second `attachStats` query** because the stats live on the `bathrooms` row itself. The UI's staleness tolerance is generous (nobody cares if a review count lags a minute), so even a matview would be *acceptable*; triggers are simply strictly better and simpler here.

**SQL** (for the schema/DATA agent to apply — this doc documents it; it edits no migration):

```sql
-- 1. Counter columns. Store SUMs + COUNTs so averages are exact and cheap.
alter table public.bathrooms
  add column review_count        integer not null default 0,
  add column rating_sum          integer not null default 0,
  add column cleanliness_sum     integer not null default 0,
  add column cleanliness_count   integer not null default 0,
  add column privacy_sum         integer not null default 0,
  add column privacy_count       integer not null default 0,
  add column accessibility_sum   integer not null default 0,
  add column accessibility_count integer not null default 0;

-- 2. One trigger fn handles INSERT / UPDATE / DELETE via signed deltas.
create or replace function public.apply_review_delta()
returns trigger language plpgsql as $$
declare s int; -- sign
begin
  if tg_op = 'INSERT' then
    update public.bathrooms b set
      review_count        = b.review_count + 1,
      rating_sum          = b.rating_sum + new.rating,
      cleanliness_sum     = b.cleanliness_sum + coalesce(new.cleanliness,0),
      cleanliness_count   = b.cleanliness_count + (new.cleanliness is not null)::int,
      privacy_sum         = b.privacy_sum + coalesce(new.privacy,0),
      privacy_count       = b.privacy_count + (new.privacy is not null)::int,
      accessibility_sum   = b.accessibility_sum + coalesce(new.accessibility,0),
      accessibility_count = b.accessibility_count + (new.accessibility is not null)::int
    where b.id = new.bathroom_id;

  elsif tg_op = 'DELETE' then
    update public.bathrooms b set
      review_count        = b.review_count - 1,
      rating_sum          = b.rating_sum - old.rating,
      cleanliness_sum     = b.cleanliness_sum - coalesce(old.cleanliness,0),
      cleanliness_count   = b.cleanliness_count - (old.cleanliness is not null)::int,
      privacy_sum         = b.privacy_sum - coalesce(old.privacy,0),
      privacy_count       = b.privacy_count - (old.privacy is not null)::int,
      accessibility_sum   = b.accessibility_sum - coalesce(old.accessibility,0),
      accessibility_count = b.accessibility_count - (old.accessibility is not null)::int
    where b.id = old.bathroom_id;

  elsif tg_op = 'UPDATE' then
    -- Edits stay on the same bathroom (unique (bathroom_id, author_id) + upsert).
    -- Guard the rare bathroom_id change by treating it as delete-old + insert-new.
    if new.bathroom_id <> old.bathroom_id then
      update public.bathrooms b set  -- remove from old
        review_count = b.review_count - 1, rating_sum = b.rating_sum - old.rating,
        cleanliness_sum = b.cleanliness_sum - coalesce(old.cleanliness,0),
        cleanliness_count = b.cleanliness_count - (old.cleanliness is not null)::int,
        privacy_sum = b.privacy_sum - coalesce(old.privacy,0),
        privacy_count = b.privacy_count - (old.privacy is not null)::int,
        accessibility_sum = b.accessibility_sum - coalesce(old.accessibility,0),
        accessibility_count = b.accessibility_count - (old.accessibility is not null)::int
      where b.id = old.bathroom_id;
      update public.bathrooms b set  -- add to new
        review_count = b.review_count + 1, rating_sum = b.rating_sum + new.rating,
        cleanliness_sum = b.cleanliness_sum + coalesce(new.cleanliness,0),
        cleanliness_count = b.cleanliness_count + (new.cleanliness is not null)::int,
        privacy_sum = b.privacy_sum + coalesce(new.privacy,0),
        privacy_count = b.privacy_count + (new.privacy is not null)::int,
        accessibility_sum = b.accessibility_sum + coalesce(new.accessibility,0),
        accessibility_count = b.accessibility_count + (new.accessibility is not null)::int
      where b.id = new.bathroom_id;
    else
      update public.bathrooms b set
        rating_sum          = b.rating_sum - old.rating + new.rating,
        cleanliness_sum     = b.cleanliness_sum - coalesce(old.cleanliness,0) + coalesce(new.cleanliness,0),
        cleanliness_count   = b.cleanliness_count - (old.cleanliness is not null)::int + (new.cleanliness is not null)::int,
        privacy_sum         = b.privacy_sum - coalesce(old.privacy,0) + coalesce(new.privacy,0),
        privacy_count       = b.privacy_count - (old.privacy is not null)::int + (new.privacy is not null)::int,
        accessibility_sum   = b.accessibility_sum - coalesce(old.accessibility,0) + coalesce(new.accessibility,0),
        accessibility_count = b.accessibility_count - (old.accessibility is not null)::int + (new.accessibility is not null)::int
      where b.id = new.bathroom_id;
    end if;
  end if;
  return null;
end $$;

create trigger reviews_maintain_stats
  after insert or update or delete on public.reviews
  for each row execute function public.apply_review_delta();

-- 3. One-time backfill for any existing reviews (O(all reviews), run once).
update public.bathrooms b set
  review_count = s.c, rating_sum = s.rs,
  cleanliness_sum = s.cs, cleanliness_count = s.cc,
  privacy_sum = s.ps, privacy_count = s.pc,
  accessibility_sum = s.as_, accessibility_count = s.ac
from (
  select bathroom_id,
         count(*) c, coalesce(sum(rating),0) rs,
         coalesce(sum(cleanliness),0) cs, count(cleanliness) cc,
         coalesce(sum(privacy),0) ps, count(privacy) pc,
         coalesce(sum(accessibility),0) as_, count(accessibility) ac
  from public.reviews group by bathroom_id
) s where b.id = s.bathroom_id;

-- 4. Redefine bathroom_stats as a SLIM, NON-aggregating view (per-row division).
--    Keeps the client's existing `.from('bathroom_stats')` call working verbatim,
--    but now it's an index lookup on bathrooms' PK — no join, no GROUP BY.
create or replace view public.bathroom_stats with (security_invoker = on) as
select b.id as bathroom_id, b.review_count,
  case when b.review_count > 0        then round(b.rating_sum::numeric        / b.review_count, 2)        end as avg_rating,
  case when b.cleanliness_count > 0   then round(b.cleanliness_sum::numeric   / b.cleanliness_count, 2)   end as avg_cleanliness,
  case when b.privacy_count > 0       then round(b.privacy_sum::numeric       / b.privacy_count, 2)       end as avg_privacy,
  case when b.accessibility_count > 0 then round(b.accessibility_sum::numeric / b.accessibility_count, 2) end as avg_accessibility
from public.bathrooms b;
```

**Expected `EXPLAIN` change** (the `.in(ids)` stats query):

```
-- BEFORE (aggregating view): recomputes avg/count from raw rows every call
HashAggregate  (group by b.id)
  ->  Nested Loop
        ->  Index Scan using bathrooms_pkey on bathrooms  (Index Cond: id = ANY (...))
        ->  Index Scan using reviews_bathroom_id_idx on reviews   -- O(reviews per bathroom)

-- AFTER (slim view over counters): no aggregate, no join
Index Scan using bathrooms_pkey on bathrooms  (Index Cond: id = ANY ('{...}'))
```

**Follow-on win (optional, later):** once the counters are on `bathrooms`, `listBathrooms`/`listBathroomsInBounds` can drop `attachStats` entirely and `select` the counter columns in the *same* query — collapsing every list/map load from **2 round-trips to 1**. Keeping the slim `bathroom_stats` view means you can do this incrementally with zero risk.

> **If you ever prefer the matview route** (e.g., aggregation grows more complex than sums): `create materialized view … ; create unique index … on (bathroom_id); select cron.schedule('refresh-stats','*/5 * * * *', $$refresh materialized view concurrently public.bathroom_stats_mv$$);`. Cost: each refresh re-runs the full `GROUP BY` over all reviews regardless of change; ≤5 min staleness. Acceptable UX, worse scaling. `pg_cron` is available on Supabase. Not recommended here.

### 2.2 `listBathroomsInBounds` — a composite btree is weak for 2-D range

**What the code does.** `listBathroomsInBounds` (called on **every map pan** once the MapLibre rewrite wires `moveend → bounds`) runs four independent range comparisons against `bathrooms_lat_lng_idx on (lat, lng)`:

```ts
.gte('lat', minLat).lte('lat', maxLat).gte('lng', minLng).lte('lng', maxLng)
```

**Why the composite btree is weak here — honestly.** A btree on `(lat, lng)` orders rows by `lat` first, then `lng` only *within a single lat value*. Because `lat` is `double precision` (effectively continuous), there is no "equal-lat" grouping to make the second column useful. So the index can range-scan the **leading** column (`lat BETWEEN`) — seek to `minLat`, scan to `maxLat` — but `lng BETWEEN` is **not globally sorted** across that band and can only be applied as a **filter**, not an index skip. Net: the plan reads **every bathroom in the latitude strip** and throws away the ones outside the longitude range. A viewport over NYC (`lat 40.4–40.9`) index-scans every bathroom on Earth in that latitude band. Only the leading column narrows; the second does not.

**Options, compared:**

| Option | Verdict |
|---|---|
| **Keep the `(lat,lng)` btree** | Fine at launch scale and *especially* fine if you serve one metro (all rows sit in a narrow lat/lng box, so no index helps or hurts much). Zero deps. It degrades only when the table is large **and** geographically spread. |
| **PostGIS `geography(Point,4326)` + GiST** | The correct 2-D index (R-tree-like): indexes both dimensions together, so `geog && ST_MakeEnvelope(...)` is a true 2-D probe returning ~only the points in the box. **PostGIS is already being adopted** for duplicate detection (`TECH_EVALUATION.md` §PostGIS), and a generated `geog` column + GiST index is already specified there — so routing bounds through it is nearly free. **Recommended once PostGIS lands.** |
| **SP-GiST (quadtree)** | Marginally better than GiST for uniformly distributed points; either is fine. GiST is the default and is what the dup-detection index already uses — reuse it. |
| **`earthdistance` + `cube` GiST** | "PostGIS-lite": a `cube` GiST index on `ll_to_earth(lat,lng)` supports `earth_box` bbox queries. Works, but clunkier, less maintained, and pointless when PostGIS is already coming in. **Reject** to avoid two spatial stacks. |

**Recommendation:** since the `geog` column + GiST index arrive anyway for dup detection, route `listBathroomsInBounds` through a spatial RPC. SQL (documented here; DATA agent applies):

```sql
-- (geog column + GiST index come from the PostGIS migration in TECH_EVALUATION.md §PostGIS)
create or replace function public.bathrooms_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
) returns setof public.bathrooms language sql stable as $$
  select b.* from public.bathrooms b
  where b.geog && extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
$$;
```

**Expected `EXPLAIN` change:**

```
-- BEFORE: leading-column range scan + longitude filter (Rows Removed grows with lng spread)
Bitmap Heap Scan on bathrooms   (Recheck / Filter: lng >= min AND lng <= max)
  ->  Bitmap Index Scan on bathrooms_lat_lng_idx   (Index Cond: lat >= min AND lat <= max)
        Rows Removed by Filter: <large as data spreads>
-- (or a plain Seq Scan while the table is tiny)

-- AFTER: true 2-D index probe
Index Scan using bathrooms_geog_gix on bathrooms
  (Index Cond: geog && '0103...'::geography)   -- Rows Removed by Filter: ~0
```

**Priority: medium.** As `TECH_EVALUATION.md` already notes, at launch data volume this is a *marginal* win — but the map calls it on every pan, so index quality compounds with request frequency, and it's essentially free once PostGIS is in. Do it, but after the counter columns (§2.1) and image compression (§3.3).

### 2.3 Search — `ilike '%term%'` is unindexable; `pg_trgm` GIN is the fix

`listBathrooms` builds a leading-wildcard `ILIKE` via `.or()`:

```ts
query.or(`name.ilike.${value},address.ilike.${value}`);  // value = "%term%"
```

A leading `%` **cannot use a btree** — it's a `Seq Scan` on every keystroke and it's typo-*intolerant*. The `pg_trgm` GIN plan already in `TECH_EVALUATION.md` §7 is exactly right; **it fits at the Home search path**, wrapped in the `search_bathrooms` RPC. `EXPLAIN` change:

```
-- BEFORE:  Seq Scan on bathrooms  (Filter: name ~~* '%term%' OR address ~~* '%term%')
-- AFTER:   Bitmap Heap Scan on bathrooms
--            ->  BitmapOr
--                  ->  Bitmap Index Scan on bathrooms_name_trgm    (Index Cond: name ~~* '%term%')
--                  ->  Bitmap Index Scan on bathrooms_address_trgm (Index Cond: address ~~* '%term%')
```

Caveat: trigram GIN needs ≥3-char trigrams; 1–2 char queries still fall back to a scan (fine — those match everything anyway). **Priority: medium** — search is only slow once the table is large.

### 2.4 `listReviewsForBathroom` — no N+1, and the indexes are already correct

```ts
.from('reviews')
.select('*, author:profiles(id, username, avatar_url), photos:review_photos(*)')
.eq('bathroom_id', bathroomId).order('created_at', { ascending: false });
```

- **N+1? No.** PostgREST resolves both embeds in **one** SQL round-trip using the FK relationships (`reviews.author_id → profiles.id` many-to-one; `review_photos.review_id → reviews.id` one-to-many, json-aggregated via a LATERAL). One HTTP call, one query. Nothing to fix.
- **`review_photos(review_id)` index — verified present:** `review_photos_review_id_idx` (init.sql line 73). Serves the photos embed join.
- **`reviews(bathroom_id, created_at desc)` index — verified present:** `reviews_bathroom_id_idx` (init.sql line 60). Serves `.eq(bathroom_id).order(created_at desc)` as an index-ordered scan (no sort).
- **Author join** is on `profiles` PK — indexed by definition.

So this path is **already well-indexed**; no missing index. The one *latent* scaling issue is unrelated to indexes: `listReviewsForBathroom` fetches **all** reviews for a bathroom with **no `LIMIT`**. A hot bathroom with thousands of reviews returns thousands of rows + embeds in one payload and renders them all. **Recommend paginating reviews** with `.range()` (as the list already does) and a "load more" control. Priority: low, until a bathroom gets popular.

---

## 3. Frontend performance

### 3.1 Code-splitting: keep MapLibre off the landing bundle

**Current state:** prod bundle is **690 KB raw / 200 KB gzip in a single chunk**, and Vite warns about it. `router.tsx` **statically imports every page**, so one chunk contains Home, Map, Detail, forms, auth, everything. MapLibre GL (**~268 KB gzip**, a **~+225 KB gzip net add** over the Leaflet it replaces — figures from `TECH_EVALUATION.md`; the min-vs-gzip labeling there is fuzzy, but the load-bearing fact is *~225 KB gzip that must not sit in the initial chunk*) is about to be added. If it lands in the single chunk, the **landing page** (Home — the most-visited route, which shows *no map*) pays for the map on first paint. Unacceptable.

**Design:**

1. **Route-level `React.lazy`** — each route becomes its own chunk; the map-bearing routes (`/map`, `/bathrooms/new`) never load on Home. This alone does the heavy lifting because a dynamic `import()` *is* a chunk boundary.
2. **Lazy-load `BathroomMap` itself**, so both map routes share **one** map chunk and MapLibre downloads only when a map actually mounts. Register the `pmtiles://` protocol *inside* that dynamic module.
3. **Vendor chunk split** (secondary) so `react`, `supabase-js`, and `maplibre-gl` cache independently of frequently-changing app code.

**Why the map *must* be dynamically imported:** it is the single largest dependency, it is used on **2 of ~8 routes**, and the highest-traffic route (Home) doesn't use it. Static-importing it forces every first-time visitor to download ~225 KB gzip they may never need. A dynamic import defers those bytes to the moment a map mounts.

**Router — real code** (`src/router.tsx`; FEATURES/orchestrator owns the edit — shown as the target shape):

```tsx
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Link } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/auth/RequireAuth';

// Eager: the landing route, so first paint isn't gated on a second chunk.
import { Home } from '@/pages/Home';

// Lazy: everything else. React.lazy needs a default export, so re-export at the
// page boundary (e.g. `export default MapPage`) or wrap: () => import(...).then(m => ({ default: m.MapPage })).
const MapPage        = lazy(() => import('@/pages/MapPage').then(m => ({ default: m.MapPage })));
const NewBathroom    = lazy(() => import('@/pages/NewBathroom').then(m => ({ default: m.NewBathroomPage })));
const BathroomDetail = lazy(() => import('@/pages/BathroomDetail').then(m => ({ default: m.BathroomDetail })));
const SignIn         = lazy(() => import('@/pages/SignIn').then(m => ({ default: m.SignIn })));
const SignUp         = lazy(() => import('@/pages/SignUp').then(m => ({ default: m.SignUp })));
const ProfilePage    = lazy(() => import('@/pages/Profile').then(m => ({ default: m.ProfilePage })));

const withSuspense = (el: React.ReactNode) => (
  <Suspense fallback={<div className="grid min-h-[50vh] place-items-center">
    <span className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent" />
  </div>}>{el}</Suspense>
);

export const router = createBrowserRouter([{
  element: <Layout />,
  children: [
    { path: '/',               element: <Home /> },                              // eager
    { path: '/map',            element: withSuspense(<MapPage />) },             // map chunk on demand
    { path: '/bathrooms/new',  element: <RequireAuth>{withSuspense(<NewBathroom />)}</RequireAuth> },
    { path: '/bathrooms/:id',  element: withSuspense(<BathroomDetail />) },
    { path: '/signin',         element: withSuspense(<SignIn />) },
    { path: '/signup',         element: withSuspense(<SignUp />) },
    { path: '/profile',        element: <RequireAuth>{withSuspense(<ProfilePage />)}</RequireAuth> },
    { path: '*',               element: /* NotFound */ null },
  ],
}]);
```

**`BathroomMap` — lazy the heavy component so both map routes share the chunk** (`src/components/map/BathroomMap.tsx` is the wrapper; consumers import the lazy shell):

```tsx
// src/components/map/LazyBathroomMap.tsx
import { lazy, Suspense } from 'react';
import type { BathroomMapProps } from './BathroomMap';
const BathroomMap = lazy(() => import('./BathroomMap').then(m => ({ default: m.BathroomMap })));
export function LazyBathroomMap(props: BathroomMapProps) {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center">
      <span className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent" />
    </div>}>
      <BathroomMap {...props} />
    </Suspense>
  );
}
// MapPage / NewBathroom import LazyBathroomMap instead of BathroomMap → maplibre-gl
// downloads only when a map mounts, and once for both routes.
```

**Vendor chunk split** (`vite.config.ts`). **Note on Vite 8:** it defaults to the **Rolldown** bundler. The Rollup-compatible `build.rollupOptions.output.manualChunks` is still honored by rolldown-vite; Rolldown's *native* equivalent is `build.rollupOptions.output.advancedChunks.groups`. **Verify the exact field against your installed Vite 8 version** — the route-level `React.lazy` above already does the critical map-splitting with *no* config, so this block is a caching optimization, not a correctness requirement.

```ts
// vite.config.ts (config agent owns the edit)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    rollupOptions: {
      output: {
        // Rollup-compat form (honored by rolldown-vite):
        manualChunks(id) {
          if (id.includes('maplibre-gl') || id.includes('/pmtiles/') || id.includes('@protomaps')) return 'map';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) return 'react';
          if (id.includes('@supabase') || id.includes('@tanstack')) return 'data';
        },
        // Rolldown-native equivalent (Vite 8), if you prefer it:
        // advancedChunks: { groups: [
        //   { name: 'map',   test: /maplibre-gl|[\\/]pmtiles[\\/]|@protomaps/ },
        //   { name: 'react', test: /react-dom|[\\/]react[\\/]|react-router/ },
        //   { name: 'data',  test: /@supabase|@tanstack/ },
        // ]},
      },
    },
  },
});
```

Result: Home's first paint ships React + app shell + `data` chunk; the `map` chunk (~225 KB gzip) loads only on `/map` and `/bathrooms/new`; vendor chunks stay cached across app-code deploys.

### 3.2 The map fetches on every pan — debounce + bbox-quantize + cancel + cache

Today `MapPage` fetches **once** (`listBathrooms({ limit: 500 })`) and fits bounds — it does **not** yet fetch per pan. The per-pan behavior is the *target* after the MapLibre rewrite wires `map.on('moveend')` to `listBathroomsInBounds`. Design it correctly from the start so it doesn't become a request storm:

1. **Debounce** `moveend` ~300 ms so a drag fires one request, not fifty.
2. **Quantize the bbox** to a grid so small pans map to the **same** query key (cache hit) — and fetch a **padded** area larger than the viewport so small pans stay inside already-fetched data.
3. **Cancel in-flight** requests with `AbortController` (supabase-js exposes `.abortSignal(signal)`; TanStack Query hands the `signal` to `queryFn`).
4. **Key the TanStack Query by the quantized bbox** so identical/overlapping pans reuse cache instead of refetching.

```ts
// Snap bounds to a coarse grid + pad, so nearby viewports share one cache key.
function quantizeBounds(b: Bounds, step = 0.05, pad = 0.05): Bounds {
  const q = (v: number, dir: -1 | 1) =>
    (dir < 0 ? Math.floor((v - pad) / step) : Math.ceil((v + pad) / step)) * step;
  return {
    minLat: q(b.minLat, -1), maxLat: q(b.maxLat, 1),
    minLng: q(b.minLng, -1), maxLng: q(b.maxLng, 1),
  };
}

// listBathroomsInBounds should accept an AbortSignal and pass it through:
//   supabase.from('bathrooms').select('*').gte(...).abortSignal(signal)

function useBathroomsInBounds(raw: Bounds | null) {
  const box = raw ? quantizeBounds(raw) : null;
  return useQuery({
    queryKey: ['bathrooms', 'bounds', box],           // pans within a cell reuse cache
    queryFn: ({ signal }) => listBathroomsInBounds(box!, signal),
    enabled: !!box,
    staleTime: 60_000,                                // a pin's rating doesn't change minute-to-minute
    placeholderData: (prev) => prev,                  // keep old pins visible during a pan (no flash)
  });
}

// In the map component: debounce moveend → setRawBounds; the hook does the rest.
map.on('moveend', debounce(() => setRawBounds(toBounds(map.getBounds())), 300));
```

This turns "N pans = N uncontrolled requests" into "one debounced, cancelable request per *distinct* grid cell, cached for a minute." Combined with the GiST index (§2.2), per-pan DB cost is negligible.

### 3.3 Image delivery — compression is the whole game on the free tier

Photos are the app's heaviest bytes and its tightest free-tier constraint (§1). Three levers, ranked by honesty about what's actually free:

1. **Supabase Storage image transformation — NOT free. Do not rely on it.** Image resizing/optimization is **Pro plan and above** (`"Image Resizing is currently enabled for Pro Plan and above"` — Supabase docs, cited §4). On the free plan it does not exist. So the "just add `?width=400` to the URL" approach is **off the table** under the constraint.

2. **Client-side compression before upload — REQUIRED, and the single biggest free-tier lever.** `TECH_EVALUATION.md` §5 already specifies a hand-rolled canvas → WebP compressor (`maxDim 1600`, `quality 0.8`, `createImageBitmap({imageOrientation:'from-image'})` for EXIF rotation). **Make it mandatory in `PhotoUploader` before `uploadReviewPhoto`.** It shrinks 5 MB phone photos to ~100–300 KB before they ever touch Storage — a **10–50× cut in both stored bytes and egress bytes**. This is what moves Storage from "breaks at ~200 photos" to "~5,000 photos," and it directly multiplies the egress-DAU ceiling in §4.

3. **Generate a thumbnail variant at upload (next step) + `<img>` hints (cheap now).** The review grid renders **96 px** thumbnails (`ReviewCard.tsx`) but currently serves the *full* image into that box — wasteful on the hottest surface. Since server transforms aren't free, do it client-side: at upload, produce **two** WebP objects — a `full` (~1600 px) for the lightbox and a `thumb` (~400 px) for the grid — and render `srcset`. Serving a ~40 KB thumb instead of a ~200 KB full on the grid is another ~5× egress cut where it's viewed most. Tradeoff: doubles object *count* (still tiny bytes) and a little storage; the egress win dominates. Cheap wins available **today**: `ReviewCard` already has `loading="lazy"`; add `decoding="async"`, and `srcset`/`sizes` once thumbs exist:

```tsx
<img
  src={publicPhotoUrl(photo.thumb_path)}
  srcSet={`${publicPhotoUrl(photo.thumb_path)} 400w, ${publicPhotoUrl(photo.storage_path)} 1600w`}
  sizes="96px"
  loading="lazy" decoding="async"
  alt={`Photo from @${review.author.username}'s review`}
/>
```

**Bottom line on images:** free-tier survival = **compress on upload (required now) → thumbnail variant (next) → `srcset`/`decoding` (free polish).** No Supabase transform, ever, on this plan.

---

## 4. Free-tier capacity math

**Verified limits** (vendor pages, fetched 2026-07-09):

- **Supabase Free:** 500 MB database · 1 GB file storage · **5 GB egress/mo** (+5 GB *cached* egress, counted separately) · 50,000 MAU · projects **paused after 1 week** of inactivity · limit of 2 active projects. — https://supabase.com/pricing
- **Supabase Free compute (Nano):** **60** direct Postgres connections · **200** Supavisor pooler clients. — https://supabase.com/docs/guides/platform/compute-and-disk
- **Supabase image transformation:** Pro plan and above only (not free). — https://supabase.com/docs/guides/storage/serving/image-transformations
- **Cloudflare R2 Free:** 10 GB-month storage · **1,000,000 Class A ops/mo** (writes: PUT/POST/LIST) · **10,000,000 Class B ops/mo** (reads: GET/HEAD) · **egress free** (zero egress fees). — https://developers.cloudflare.com/r2/pricing/ and https://www.cloudflare.com/developer-platform/products/r2/

### DB size — 500 MB → ~0.5–1M reviews (distant)

Row sizes (modeled, incl. index/tuple overhead): `bathrooms` ~1 KB/row (add geog + GiST + trgm indexes), `reviews` ~0.3–0.5 KB/row, `review_photos` ~0.15 KB/row. Reviews dominate.

- `500 MB / 0.5 KB per review ≈ 1,000,000 reviews` (ignoring other tables). Halve for indexes/bloat/WAL headroom → **~500k reviews realistically.** Bathrooms and photo *rows* are negligible next to this. **DB size is not the first wall.**

### Storage — 1 GB → the first wall, and it's all about compression

- **Uncompressed** at the 5 MB bucket cap: `1 GB / 5 MB = 200 photos`. **Breaks almost immediately.**
- **Compressed** ~200 KB WebP: `1 GB / 200 KB ≈ 5,000 photos`. With a `thumb + full` pair (~250 KB combined): **~4,000 photo-bearing reviews.**
- Keep the **PMTiles basemap OFF Supabase Storage** — a 30–60 MB extract would eat 3–6% of the 1 GB. Put it on R2 (free egress, §5) so the full 1 GB stays for user photos.

### Egress — 5 GB/mo → the throttle at traffic (compression multiplies DAU)

- **API JSON egress:** a 50-row list page ≈ 20–50 KB. `5 GB / 40 KB ≈ 125,000 list loads/mo ≈ ~4,000/day`. Fine for a small app; a viral spike blows it.
- **Photo egress dominates.** Modeled: a detail view with 3 photos at 200 KB full = **600 KB/view**; with 400 KB → grid thumbs at ~40 KB each = **~120 KB/view**.
  - `5 GB / 600 KB ≈ 8,700` full-photo detail views/mo; `5 GB / 120 KB ≈ 43,000` thumbnail views/mo.
- **DAU ceiling** (modeled: each daily user loads ~5 photo pages/day, 30 days): solve `5 GB = DAU × 30 × 5 × bytes/page`.
  - Full images (0.6 MB/page): `DAU ≈ 5000 MB / (150 × 0.6) ≈ **~55 DAU**.`
  - Thumbnails (0.12 MB/page): `DAU ≈ 5000 / (150 × 0.12) ≈ **~280 DAU**.`

So on the free tier, egress supports **dozens to low-hundreds of photo-viewing DAU**, and **compression + thumbnails multiply that ceiling ~5×.** Two more multipliers, both free:
- **Move the basemap to R2** → map byte-range egress (viewed constantly) leaves Supabase's 5 GB entirely (R2 egress is free).
- **Serve the SPA from a static CDN** (Cloudflare Pages/R2, GitHub Pages, Netlify — all free egress), so 200 KB gzip × every visitor's cold load never touches Supabase's 5 GB. `5 GB / 200 KB = 25,000` cold app loads is a lot of headroom to *not* waste on Supabase.

### Connections — 60/200 → effectively never binds (see §5b)

### MAU — 50,000 → never binds first; egress/storage break ~100× sooner.

### Inactivity pause — 1 week

A low-traffic hobby deployment risks being **paused after a week idle**; the first request afterward is slow or errors until the project wakes. Options: accept it (fine pre-launch), or a cheap external cron that pings a REST endpoint a few times a week to keep it warm (a negligible egress cost). **Operational gotcha, not a capacity limit.**

---

## 5. What NOT to do — premature optimization & the load-balancer non-problem

### 5a. The load-balancer non-problem (stated plainly)

**There is no load balancer to configure, and writing an nginx/HAProxy config would be theater.**

- **Postgres + PostgREST sit behind Supabase's own edge/API gateway.** You cannot place a proxy in front of the managed Postgres, and you shouldn't want to. Supabase handles that layer.
- **The SPA is static files.** "Scaling" it = putting it on a CDN with correct cache headers (below). That's a *caching* config, not a load-balancer config.
- **Horizontal DB scaling (read replicas) is a paid Supabase feature** toggled in their dashboard — not infrastructure you stand up.

Every real scaling win for this app is in: **query shape** (§2.1 counters), **indexes** (§2.2 GiST, §2.3 trgm), **payload size** (§3.3 compression), **request coalescing** (§3.2 debounce/cache), and **moving bytes onto free-egress hosts** (below). Not one of them is a proxy.

### 5b. Connection handling — a non-problem for the browser

The browser talks to **PostgREST over HTTP**, not to Postgres. PostgREST maintains its **own** server-side pool to Postgres and multiplexes all HTTP callers over it, so **thousands of concurrent browser users do not consume the 60 direct / 200 pooler connections** — a browser never opens a Postgres connection. **Client-side connection pooling is not our problem; verified and stated.**

Where Supavisor/the pooler **does** matter: **running migrations** (use the pooler or direct connection string), and **any future server-side job or Edge Function** using a Postgres client (use **Supavisor transaction mode** — it's literally built to let many short-lived/serverless clients share few Postgres connections). None of that is on this static SPA's hot path today. (Supabase's own guidance: frontends use the Data API; servers use the pooler — https://supabase.com/docs/guides/database/connecting-to-postgres.)

### 5c. Static hosting + caching

**SPA assets:**
- **Hashed assets** (`assets/*.[hash].js` / `.css`): `Cache-Control: public, max-age=31536000, immutable` — content-hashed, safe to cache forever.
- **`index.html`**: `Cache-Control: no-cache` (i.e. `max-age=0, must-revalidate`) — it's the un-hashed entry pointing at hashed assets, so it must revalidate for each deploy to be picked up immediately.
- **SPA fallback:** rewrite unknown paths to `index.html` (client-side routing) via the host's redirects config (`_redirects` / `404.html` / etc.).

**PMTiles on R2** (fetched via HTTP **Range**):
- **Egress: free.** R2 has **zero egress fees** (verified, §4) — this is the whole reason the basemap belongs on R2, not on Supabase's metered 5 GB.
- **Cache-Control:** the file changes rarely. Either `Cache-Control: public, max-age=86400` (a day) **or** version the filename (`metro.v3.pmtiles`) + `public, max-age=31536000, immutable`. Long caching matters because **each viewport issues several range GETs**; caching the header/directory byte-ranges at the browser/edge avoids re-fetching them.
- **CORS (required — the SPA is a different origin):** the `Range` request header is **not** CORS-safelisted, so the browser sends a **preflight `OPTIONS`**. R2's bucket CORS policy must allow it. Minimal policy:

```json
[{
  "AllowedOrigins": ["https://your-app-origin.example"],
  "AllowedMethods": ["GET", "HEAD"],
  "AllowedHeaders": ["Range"],
  "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]
}]
```

R2 honors Range natively (returns `206 Partial Content` + `Accept-Ranges: bytes`), which PMTiles depends on.
- **Operation counts vs R2 free limits:** range GETs are **Class B** (GetObject). Each *cold* viewport issues roughly a **handful to ~10** range GETs (header + root dir + leaf dirs + tile data), dropping sharply as `pmtiles.js`'s in-memory cache and HTTP caching warm up. *(Exact per-viewport count is **unverified** — order-of-magnitude ~10.)* Against the **10,000,000 Class B/mo** free limit: `10M / 10 ≈ 1,000,000 cold viewport-loads/mo` before it bites — effectively unreachable for this app, and caching cuts it further. Uploading a rebuilt `.pmtiles` is a **Class A** PutObject — a handful per rebuild, trivially under **1,000,000 Class A/mo**. **Net: basemap on R2 is free in egress and effectively free in ops.**

---

## The three changes that buy the most (in order)

1. **Denormalized rating counters on `bathrooms`, maintained by triggers (§2.1).** Kills both the per-request re-aggregation *and* the second `attachStats` query; makes every list/map/detail read O(1) and always-fresh, and lets list/map collapse to a single query. Biggest database win, and it simplifies the client.

2. **Mandatory client-side image compression before upload, then thumbnails + basemap-on-R2 + SPA-on-CDN (§3.3, §4, §5c).** This is free-tier *survival*: it turns the 1 GB storage wall from **~200 photos into ~5,000**, and lifts the 5 GB egress DAU ceiling from **~55 into ~280+**. Moving basemap bytes to R2 (free egress) and SPA bytes to a CDN keeps Supabase's 5 GB for user data only.

3. **Lazy-load the map + route-level `React.lazy`, and coalesce map-pan fetches with TanStack Query (§3.1, §3.2).** Keeps MapLibre's ~225 KB gzip off the landing bundle, and turns "a request per pan" into "one debounced, cancelable, bbox-cached request per grid cell." Best-perceived-performance win for the least user-visible risk.

*Next tier (real but lower priority):* PostGIS `geog` + GiST for the bounds query (§2.2) and `pg_trgm` GIN for search (§2.3) — both nearly free once the extensions they share are in, but neither binds until the table is large.
