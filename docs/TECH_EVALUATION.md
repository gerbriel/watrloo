# Watrloo — Tech / dependency evaluation

**Author:** RESEARCH agent · **Date:** 2026-07-09
**Constraint being honored:** *"as self-sufficient as possible — NOT reliant on APIs or third-party services unless they are 100% free. Supabase is the one exception."*

Tiers used throughout:

- **A — Self-contained.** Runs in our bundle or our Supabase Postgres. No outbound calls to anyone.
- **B — Free + self-hostable.** Permissive OSS we can host ourselves; a hosted convenience endpoint may exist but we are not locked to it.
- **C — Third-party on the hot path.** An external service must be up for the feature to work. Rejected unless unavoidable and genuinely free.

"Free tier that can rate-limit or bill later" is treated as **C**, not free.

---

## 1. Verdict up front

| # | Thing | Recommendation | Tier | License | Adopt / Skip |
|---|-------|----------------|------|---------|--------------|
| 0 | **OSM public tile server** (`tile.openstreetmap.org`) | **Remove.** Policy forbids our use; no SLA; blocks heavy consumers | C | — | **REJECT** |
| 0 | **MapLibre GL + PMTiles basemap on Supabase Storage** | **Adopt.** Replaces both Leaflet + OSM tiles | A/B | BSD-3 | **ADOPT** |
| 0 | **maplibre-gl** | Adopt (replaces leaflet + react-leaflet) | A | BSD-3-Clause | **ADOPT** |
| 0 | **pmtiles** (protocol) | Adopt | A | BSD-3-Clause | **ADOPT** |
| 0 | **@protomaps/basemaps** (style helper) | Adopt (or inline a style JSON) | A | BSD-3-Clause | **ADOPT** |
| 1 | **Geocoding** (address → lat/lng autocomplete) | **Not achievable for free.** Require a map click + typed address | A | — | **SKIP feature** |
| 2 | **TanStack Query** | Adopt — real cache reuse + map-pan dedup | A | MIT | **ADOPT** |
| 3a | **zod** | Adopt — cheap guard at the write boundary | A | MIT | **ADOPT** |
| 3b | **react-hook-form** | Skip — only two forms; `Field` primitives already carry `error`/`hint` | A | MIT | **SKIP** |
| 4 | **lucide-react** | Skip — hand-draw a tiny inline-SVG set instead | A | ISC | **SKIP** |
| 5 | **Image compression** | Adopt — but **hand-rolled canvas**, not the library | A | — | **ADOPT (DIY)** |
| 6 | **Relative timestamps** | Native `Intl.RelativeTimeFormat` | A | — | **ADOPT (native)** |
| 7 | **Fuzzy search** — `pg_trgm` + GIN | Adopt — current `ilike` can't use an index | A | — | **ADOPT (SQL)** |
| 8 | **PWA** (vite-plugin-pwa) | Adopt in phase 2 — genuinely on-mission | A | MIT | **ADOPT (later)** |
| 9 | **PostGIS** — dup detection + spatial index | Adopt — for duplicate detection primarily | A | — | **ADOPT (SQL)** |
| — | date-fns / dayjs | Skip — native `Intl` covers it | A | MIT | **SKIP** |
| — | Nominatim / Photon public endpoints | Reject — usage policies + no SLA | C | — | **REJECT** |

All licenses evaluated are permissive (MIT / BSD / ISC). **No copyleft, no SSPL** appears in any recommendation.

Package facts (npm registry + Bundlephobia, fetched 2026-07-09):

| Package | Latest | Released | Weekly dl | min / gzip | License |
|---|---|---|---|---|---|
| maplibre-gl | 5.24.0 | 2026-04-23 | 3.06M | 1008 / **267.7 KB** | BSD-3-Clause |
| pmtiles | 4.4.1 | 2026-04-08 | 437K | 18.3 / 7.2 KB | BSD-3-Clause |
| @protomaps/basemaps | current | — | — | 37.5 / 6.7 KB | BSD-3-Clause |
| @tanstack/react-query | 5.101.2 | 2026-06-27 | 59.4M | 45.2 / 13.3 KB | MIT |
| zod | 4.4.3 | 2026-05-04 | 215.7M | 274.7 / 60.3 KB (tree-shakes) | MIT |
| react-hook-form | 7.81.0 | 2026-07-05 | 55.9M | 36.2 / 12.6 KB | MIT |
| lucide-react | 1.24.0 | 2026-07-09 | 84.3M | barrel 616 / 154 KB (≈0.5–1 KB/icon shaken) | ISC |
| browser-image-compression | 2.0.2 | **2023-03-06 ⚠ stale (3.3 yr)** | 1.22M | 50.5 / 19.2 KB | MIT |
| date-fns | 4.4.0 | 2026-05-29 | 90.2M | 69.1 / 17.1 KB | MIT |
| dayjs | 1.11.21 | 2026-05-26 | 56.7M | 7.0 / 3.0 KB | MIT |
| vite-plugin-pwa | 1.3.0 | 2026-05-05 | 3.52M | build-time only | MIT |
| leaflet *(current, remove)* | 1.9.4 | — | — | 145 / 41.7 KB | BSD-2-Clause |
| react-leaflet *(current, remove)* | 5.0.0 | — | — | 10.8 / 3.4 KB | — |

Only staleness flag: **browser-image-compression** (last release 2023-03-06) — and it's the one library I recommend *against* anyway.

---

## 2. The tile-server problem

### 2.1 Findings — the owner's read is correct

The app currently renders `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` in `src/components/map/BathroomMap.tsx` (line 147). The **OSMF Tile Usage Policy** (https://operations.osmfoundation.org/policies/tiles/) says, verbatim in current form:

- Availability is **best-effort — "no SLA or guarantee."**
- **"We may block access, without notice, if your usage degrades the service."**
- Requires a **unique, identifying `User-Agent`** naming your app + contact. *A browser can't set `User-Agent`* — every request from our SPA sends the browser default, which the policy says **"will be blocked because we cannot identify or contact the actual application."**
- Forbids **bulk/pre-emptive tile fetching** and requires local caching per HTTP headers (or ≥7 days).

Net: an in-browser React app hitting the public tile server is **exactly the pattern the policy is written to stop.** It is against the rules and can be blocked with no notice. This is a *when*, not an *if*, once the app has real traffic. It is also tier **C** — an outside service on the hot path — which violates the self-sufficiency constraint regardless of policy.

Every "free" raster alternative (Carto, Stadia, MapTiler, Thunderforest, OpenFreeMap's raster) is either a metered free tier (→ C) or another shared-cost community server with the same "don't rely on us" posture. **There is no tier-A/B *raster* option that beats what follows.**

### 2.2 Recommendation — MapLibre GL JS + Protomaps PMTiles, hosted on Supabase Storage

This is the one path that is genuinely tier A/B:

- **One static `.pmtiles` file** = the whole basemap (vector). We host it in a **public Supabase Storage bucket** — Supabase is the sanctioned exception, so this stays inside the constraint. If we ever want off-Supabase, the same file drops onto any static host that honors Range (Cloudflare R2, GitHub Pages, S3, our own origin) → tier B, no lock-in.
- **MapLibre GL JS** renders the vector tiles client-side. Pins, popups, click-to-place all move over cleanly.
- **No third party is ever contacted at runtime.** No key, no quota, no "please don't rely on us."

**The make-or-break question — does Supabase Storage honor HTTP Range requests? YES.** Confirmed by two primary sources:

1. Supabase's own engineering blog, *"Self-host Maps with Protomaps and Supabase Storage"* (2024-06-19): *"Supabase Storage supports the required HTTP Range Requests out of the box, allowing you to use the public storage URL directly."* — https://supabase.com/blog/self-host-maps-storage-protomaps
2. Protomaps' cloud-storage docs list **Supabase Storage** among supported Range-request hosts. — https://docs.protomaps.com/pmtiles/cloud-storage

> ⚠ Historical caveat, disclosed for honesty: there were older GitHub issues (`supabase/storage#322`, discussion `#4115`) about the Range header not being parsed. Those pre-date the 2024 storage rewrite and the official blog above. **Verify against our own project once before committing** with a one-liner — do not take it on faith:
> ```bash
> curl -sI -H "Range: bytes=0-99" \
>   "https://<PROJECT_REF>.supabase.co/storage/v1/object/public/basemap/metro.pmtiles" \
>   | grep -iE "206|accept-ranges|content-range"
> ```
> A `206 Partial Content` + `accept-ranges: bytes` means we are good.

**Licensing** (all clear):
- PMTiles format: open spec, **public domain**.
- Protomaps basemap **data**: ODbL (it's OpenStreetMap) → we must show **"© OpenStreetMap"** attribution on the map (we already have that string in `BathroomMap.tsx`).
- Protomaps **styles / npm packages**: **BSD-3-Clause**; visual design is CC0.
- maplibre-gl: **BSD-3-Clause**. pmtiles: **BSD-3-Clause**.
(Sources: https://docs.protomaps.com/basemaps/downloads , https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md)

**Basemap size — the one thing to manage.** The full planet is ~**120 GB** (z0–15). We do **not** ship the planet. We cut a regional extract with the free `pmtiles` CLI:

```bash
# Download the free daily planet build once (or use a prebuilt regional file),
# then cut just our launch area. Each extra zoom ~doubles size.
pmtiles extract https://build.protomaps.com/<latest>.pmtiles metro.pmtiles \
  --region=launch-metro.geojson --maxzoom=14
```

A single metro / small-state extract at z14 is typically **tens of MB**. That matters because **Supabase free-tier Storage is ~1 GB and bandwidth is metered** — so keep the extract scoped to the region we actually serve (grow it as we expand), and only PMTiles' byte-range fetches (a few KB per viewport) hit egress, not whole-file downloads. This keeps us comfortably inside the free tier. A nationwide file would blow the free storage cap — don't ship one until we're on a paid plan or move the file to R2 (free egress).

**Is a basemap even needed for v1?** Yes — for a "find the nearest bathroom" app, street context is the core UX, and PMTiles makes it constraint-compliant, so there's no reason to ship pins-on-a-blank-rectangle. (Pins on a plain background remain the zero-effort fallback if the extract pipeline slips a release.)

### 2.3 MapLibre vs. staying on Leaflet

Leaflet **cannot render vector PMTiles** without extra plugins and still needs a raster tile source — i.e. it doesn't solve the actual problem. MapLibre renders PMTiles natively via the `pmtiles` protocol. The map lives in exactly **two places** (read-only `MapPage`, click-to-place picker in `NewBathroom`), both funneled through the single `BathroomMap.tsx` component. So the migration is **one component rewrite**, not a codebase sweep. Do it with plain `maplibre-gl` (imperative, in that one file) — a React wrapper like `react-map-gl` (MIT) is available but is an extra dependency that buys little for a single component.

**Bundle cost, stated honestly:** maplibre-gl is **~268 KB gzip** vs Leaflet's ~42 KB — about **+225 KB gzip**. Mitigate by lazy-loading `BathroomMap` (`React.lazy`) so it only loads on `/map` and `/bathrooms/new`, not the Home list. The vector basemap also *removes* hundreds of raster PNG requests per pan, so runtime network is better, not worse.

### 2.4 Migration steps (concrete)

1. `npm uninstall leaflet react-leaflet @types/leaflet`
2. `npm install maplibre-gl pmtiles @protomaps/basemaps`
3. Remove the Leaflet dark-mode CSS in `src/index.css` (the `.leaflet-tile-pane` filter block, ~lines 99–110). MapLibre restyles via the style JSON instead — Protomaps ships light **and** dark flavors, so wire the flavor to the existing theme toggle.
4. Produce `metro.pmtiles` (above) and upload to a **public** Supabase bucket, e.g. `basemap`.
5. Rewrite `src/components/map/BathroomMap.tsx` (owned by Agent FEATURES) imperatively. Same props, same teardrop SVG pins, same popups. Sketch:

```tsx
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers } from '@protomaps/basemaps';
import { useEffect, useRef } from 'react';

const PMTILES_URL =
  'pmtiles://https://<PROJECT_REF>.supabase.co/storage/v1/object/public/basemap/metro.pmtiles';

// Register the pmtiles:// protocol ONCE for the whole app lifetime.
let registered = false;
function ensureProtocol() {
  if (registered) return;
  maplibregl.addProtocol('pmtiles', new Protocol().tile);
  registered = true;
}

function styleFor(theme: 'light' | 'dark'): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf', // or self-host these
    sources: { protomaps: { type: 'vector', url: PMTILES_URL, attribution: '© OpenStreetMap' } },
    layers: layers('protomaps', theme), // @protomaps/basemaps builds the layer list
  };
}

export function BathroomMap({ bathrooms, selectable, onSelect, selected, fit /* … */ }: BathroomMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>();

  useEffect(() => {
    ensureProtocol();
    const map = new maplibregl.Map({
      container: ref.current!,
      style: styleFor('light'),
      center: [-98.5795, 39.8283], // NOTE: MapLibre is [lng, lat] — the opposite of Leaflet
      zoom: 3,
    });
    mapRef.current = map;

    // Rating pins: reuse the exact same teardrop SVG, wrapped in a maplibre Marker.
    for (const b of bathrooms) {
      const el = document.createElement('div');
      el.innerHTML = teardropSvg(b.stats.avg_rating);   // lift the existing SVG builder
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([b.lng, b.lat])
        .setPopup(new maplibregl.Popup().setHTML(popupHtml(b)))
        .addTo(map);
    }

    if (fit && bathrooms.length) {
      const bounds = new maplibregl.LngLatBounds();
      bathrooms.forEach((b) => bounds.extend([b.lng, b.lat]));
      map.fitBounds(bounds, { padding: 48, maxZoom: 15 });
    }

    if (selectable) {
      map.on('click', (e) => onSelect?.(e.lngLat.lat, e.lngLat.lng)); // click-to-place
    }
    return () => map.remove();
  }, [/* bathrooms, selectable, … */]);

  // Draggable "selected" picker marker → replicate the current dragend handler with a
  // maplibre Marker({ draggable: true }); on 'dragend' read marker.getLngLat().
  return <div ref={ref} className={/* h-full w-full */} />;
}
```

Gotchas to carry across: **MapLibre uses `[lng, lat]`** everywhere (Leaflet used `[lat, lng]` — note the swap in every call), call `map.resize()` on container layout changes (replaces the Leaflet `invalidateSize` `ResizeFix`), and `addProtocol` must run exactly once. Popups take an HTML string, so the current JSX popup becomes a small HTML template (or render into a portal). Everything else — pin colors, `fitBounds`, the picker — maps 1:1. **Estimate: half a day for one experienced pass**, since it's one self-contained file with an unchanged public API.

---

## 3. Numbered evaluations

### 1. Geocoding (address → lat/lng, and reverse) — **SKIP the feature**

**Nominatim public endpoint** policy (https://operations.osmfoundation.org/policies/nominatim/) is hard: **max 1 request/second**, a valid identifying `User-Agent`/`Referer` required, **"Auto-complete search … you must not implement such a service,"** no bulk/systematic queries, no reselling, no SLA. As-you-type address autocomplete is *explicitly forbidden*, and a browser can't set `User-Agent`. → **tier C, rejected.**

**Photon** (komoot, Apache-2.0 — https://github.com/komoot/photon) is the search-as-you-type geocoder, and it's genuinely self-hostable. But the **public** `photon.komoot.io` endpoint says *"Extensive usage will be throttled or completely banned … no guarantees for availability"* → **tier C**. Self-hosting Photon needs a **~95 GB** planet DB plus a running Java/OpenSearch server (their own docs) — that's a standing server we'd operate and pay for, which breaks "self-sufficient, no third-party unless free." Same story for self-hosted Nominatim (heavier still).

**Honest call:** address autocomplete/geocoding **cannot be done inside the constraint for free.** Don't fake it with a policy-violating public endpoint. Instead — and the app is *already built this way* — **`NewBathroom` takes a typed `address` string and a map click for `lat`/`lng`** (the picker in `BathroomMap`). That's tier A, zero deps, and for a bathroom you're physically standing in front of, "tap where it is" is actually a *better* UX than typing an address. **Adopt: map-click + manual address. Skip: all geocoding libraries/services.** (Reverse geocoding to auto-fill the address string is the one nice-to-have we lose; accept it.)

### 2. TanStack Query — **ADOPT**

MIT, 13.3 KB gzip, 59M weekly downloads, released 2026-06-27 (fresh). **Tier A** — it's a pure client cache, it makes no outbound calls of its own; it wraps the existing `@/lib/api/*` functions.

What it concretely buys *this* app: the list→detail navigation reuses cached bathroom rows; the **map refetches on every pan** (`listBathroomsInBounds`) — Query dedupes in-flight requests and cancels stale ones, which is real, annoying-to-hand-roll logic; and it standardizes `isLoading`/`error`/`refetch` across all five data-driven pages instead of a bespoke `useEffect` in each. It earns its 13 KB. Skip it only if the team prefers zero abstraction — but here the map-pan case tips it to adopt.

### 3. Forms + validation — **zod ADOPT, react-hook-form SKIP**

- **zod (MIT, tree-shakes, fresh):** adopt. Define a schema for `NewBathroom` and `NewReview` once and get typed parse + friendly messages *before* the row hits Postgres (nicer than surfacing a raw `check` constraint violation). It also guards genuinely-untrusted input (e.g. anything read back from `localStorage`). Cheap insurance at the write boundary. It's the most droppable of the adopts, but it pays for itself.
- **react-hook-form (MIT, 12.6 KB):** **skip.** There are exactly **two** forms (bathroom, review), and the contract's `Field` primitives (`<Input error hint>`, `<Textarea>`, `<Checkbox>`, `<StarInput>`) already carry error/hint plumbing. Hand-rolled `useState` + a zod `safeParse` on submit is less code than wiring RHF's resolver here. Revisit if forms multiply.

### 4. Icons — **SKIP lucide-react, hand-draw inline SVG**

lucide-react is fine and permissive (**ISC**, tree-shakeable to ~0.5–1 KB/icon), so it's not *wrong*. But this app needs a **tiny, fixed** icon set: the four amenities (wheelchair, gender-neutral, changing-table/baby, key) plus a handful of UI glyphs (star already exists as `Stars`, search, plus, marker). There is **no existing sprite** anymore (`public/icons.svg` is gone; only `favicon.svg` remains), so this is a from-scratch decision — and a dozen inline SVGs is **tier A, zero dep, zero barrel-import risk**, and lets us match the porcelain/flush palette exactly. Note lucide has no clean "gender-neutral" glyph anyway, so we'd be hand-drawing at least one regardless. **Hand-roll a small `Icon` component over an inline `<symbol>` sprite.** (If the UI later needs *dozens* of general glyphs fast, lucide-react is an acceptable tier-A adopt — just import named icons, never the barrel.)

### 5. Image compression before upload — **ADOPT, but hand-rolled canvas (tier A), not the library**

The bucket cap is **5 MB** (`file_size_limit 5242880` in the migration) and allows `jpeg/png/webp/avif`; phone photos routinely exceed 5 MB, so client-side downscale is **required**, not optional — otherwise uploads fail RLS/size checks.

`browser-image-compression` (MIT, 19 KB gzip) would do it and offloads to a Web Worker + handles EXIF orientation — but it **last released 2023-03-06 (~3.3 years ago) → staleness flag**, and it's a dependency for something the platform now does natively. **Recommend hand-rolled canvas** (tier A, zero dep, ~30 lines), which also lets us convert to WebP for smaller uploads:

```ts
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<File> {
  // createImageBitmap applies EXIF orientation natively — the main thing the library did for us.
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res) =>
    canvas.toBlob((b) => res(b!), 'image/webp', quality),
  );
  return new File([blob], file.name.replace(/\.\w+$/, '.webp'), { type: 'image/webp' });
}
```

`{ imageOrientation: 'from-image' }` closes the one real gap (rotated iPhone photos). Run it in `PhotoUploader` before `uploadReviewPhoto`. Only reach for the library if we later need heavy batches off the main thread — and even then, prefer wrapping the above in a Worker over adopting a stale dep.

### 6. Relative timestamps — **ADOPT native `Intl.RelativeTimeFormat` (zero dep)**

Reviews carry `created_at`/`updated_at`. Native `Intl.RelativeTimeFormat` is **baseline-supported in every current browser**, zero bytes, tier A. A ~15-line helper (pick the largest unit that fits, format it) covers "3 days ago" / "in 2 hours." **Skip date-fns (17 KB) and dayjs (3 KB)** — neither earns its keep for one formatting need.

```ts
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const DIV: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 3.15e10], ['month', 2.63e9], ['day', 8.64e7],
  ['hour', 3.6e6], ['minute', 6e4], ['second', 1e3],
];
export function timeAgo(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  for (const [unit, ms] of DIV)
    if (Math.abs(diff) >= ms || unit === 'second')
      return rtf.format(Math.round(diff / ms), unit);
  return 'just now';
}
```

### 7. Full-text / fuzzy search — **ADOPT `pg_trgm` + GIN (tier A, in our DB)**

Current search (`src/lib/api/bathrooms.ts` lines 96–98) does:
```ts
query.or(`name.ilike.${value},address.ilike.${value}`)  // value = "%term%"
```
A leading-`%` `ILIKE` pattern **cannot use the existing btree** — it's a sequential scan on every keystroke, and it's typo-*intolerant*. `pg_trgm` is confirmed available on Supabase (https://supabase.com/docs/guides/database/extensions) and fixes both: a **GIN trigram index** accelerates `%term%` *and* enables similarity ranking. Tier A — it's all inside our Postgres. Migration SQL (for the schema/DATA agent to apply — not editing here):

```sql
create extension if not exists pg_trgm;

create index bathrooms_name_trgm    on public.bathrooms using gin (name    gin_trgm_ops);
create index bathrooms_address_trgm on public.bathrooms using gin (address gin_trgm_ops);

-- Typo-tolerant, ranked search behind one RPC. The GIN index serves both the
-- `%` (similarity) predicate and the ILIKE fallback for short/partial terms.
create or replace function public.search_bathrooms(q text)
returns setof public.bathrooms
language sql stable
as $$
  select b.*
  from public.bathrooms b
  where b.name % q or b.address % q
     or b.name ilike '%' || q || '%' or b.address ilike '%' || q || '%'
  order by greatest(similarity(b.name, q), similarity(b.address, q)) desc,
           b.created_at desc
  limit 50;
$$;
```
Then `listBathrooms` calls `supabase.rpc('search_bathrooms', { q: term })` when a term is present (keeping the current attach-stats merge). `tsvector`/`websearch_to_tsquery` is the alternative, but for short names/addresses with typos, **trigram similarity is the better fit** than full-text stemming. Consider lowering `pg_trgm.similarity_threshold` (e.g. `0.2`) for short queries.

### 8. Offline / installable PWA — **ADOPT, phase 2**

vite-plugin-pwa (MIT, build-time only, fresh). **Tier A** — it generates a service worker; no external service. For *this* app the offline story is unusually on-mission: **"I need a bathroom right now and I have one bar of signal."** Scope it deliberately so it's polish, not a rabbit hole:

- Precache the app shell (installable "Add to Home Screen").
- Runtime-cache `GET` responses from Supabase REST (list/detail) `stale-while-revalidate`, so the last-seen bathrooms render instantly and offline.
- The PMTiles basemap is a static file → the SW can cache viewed byte-ranges too, so the map paints on a cold connection.

Don't attempt offline *writes* (queued reviews/photos) — that's genuine scope creep with sync/conflict cost. **Adopt read-only offline + installability after core features land.**

### 9. Also found

- **Duplicate-bathroom detection + spatial index → PostGIS: see §4.** This is the highest-value "extra" — it stops five pins for the same Starbucks.
- **Moderation / spam:** the RLS already scopes writes to the owning user and the `unique (bathroom_id, author_id)` constraint caps review spam at one-per-user-per-bathroom. Add tier-A guards in Postgres rather than a service: a `char_length`/regex `check` on bodies (already present), and optionally a simple per-user insert-rate guard via a `before insert` trigger counting recent rows. No third-party anti-spam (hCaptcha/Akismet = tier C) needed at this scale.
- **Rate-limiting writes:** do it in Postgres (trigger counting the user's inserts in the last minute) — tier A. Supabase Edge Functions could do token buckets but add surface; skip until abuse is real.
- **Accessibility tooling:** not a runtime dep. Add `eslint-plugin-jsx-a11y` **as a dev dependency** (or lean on `oxlint`, already present, which has a11y rules) to catch missing labels/`aria-*` at build time — matches the contract's "accessibility is not optional." Dev-only, tier A.

---

## PostGIS on Supabase — availability + does it beat the naive bbox?

**Available? Yes.** PostGIS is a first-class Supabase extension — enable it from the dashboard or SQL; Supabase installs it into a dedicated schema (commonly `extensions` or a `gis` schema), so functions/types are referenced schema-qualified (e.g. `extensions.st_makepoint`). Source: https://supabase.com/docs/guides/database/extensions/postgis .

**Does `geography(Point)` + GiST beat the current `lat/lng BETWEEN` bbox?** Two honest halves:

- **For the map bounds query** (`listBathroomsInBounds`, lines 123–134): the existing `bathrooms_lat_lng_idx` btree on `(lat, lng)` already serves the four `>=/<=` comparisons fine. **At this app's data volume PostGIS is a marginal win here** — nice, not necessary.
- **For duplicate detection and "nearest to me" it's a clear win**, because "within 30 m of this point" and "order by distance" are awkward and wrong-near-the-poles with raw lat/lng, and exactly what `ST_DWithin` / `<->` on a `geography` GiST index do correctly and fast.

**So: adopt PostGIS primarily to power duplicate detection; treat the bounds-query rewrite as optional.** Migration SQL:

```sql
create extension if not exists postgis with schema extensions;

-- A generated geography column kept in sync with lat/lng automatically (all funcs immutable).
alter table public.bathrooms
  add column geog geography(Point, 4326)
  generated always as (
    extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::geography
  ) stored;

create index bathrooms_geog_gix on public.bathrooms using gist (geog);

-- Duplicate-detection pre-check: call before createBathroom to warn the user.
create or replace function public.nearby_bathrooms(
  in_lat double precision, in_lng double precision, radius_m double precision default 30
) returns setof public.bathrooms language sql stable as $$
  select b.* from public.bathrooms b
  where extensions.st_dwithin(
    b.geog,
    extensions.st_setsrid(extensions.st_makepoint(in_lng, in_lat), 4326)::geography,
    radius_m
  )
  order by b.geog <-> extensions.st_setsrid(extensions.st_makepoint(in_lng, in_lat), 4326)::geography;
$$;

-- Optional: replace the bbox query with a spatial one.
create or replace function public.bathrooms_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
) returns setof public.bathrooms language sql stable as $$
  select b.* from public.bathrooms b
  where b.geog && extensions.st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
$$;
```
Then `NewBathroom` calls `supabase.rpc('nearby_bathrooms', { in_lat, in_lng })` after the map click and, if it returns rows, shows "There may already be a bathroom here → [existing]" before letting the user submit. **Caveat:** the generated-column expression must reference PostGIS functions with their real schema (`extensions.`) or creation fails depending on `search_path`; verify the schema name in the actual project (`\dx postgis`) before applying.

---

## 4. Recommended v2 dependency set

```bash
# Add — map stack (replaces Leaflet) + the two lightweight winners
npm install maplibre-gl pmtiles @protomaps/basemaps @tanstack/react-query zod

# Remove — the OSM/Leaflet path we're retiring
npm uninstall leaflet react-leaflet @types/leaflet

# Dev-only, phase 2 / quality
npm install -D vite-plugin-pwa
npm install -D eslint-plugin-jsx-a11y   # optional; oxlint already covers some a11y
```

Everything else on the "buys us something" list is **native or SQL, no npm dependency**:
- Relative timestamps → `Intl.RelativeTimeFormat` (helper in `src/lib`).
- Image compression → hand-rolled canvas helper (`src/lib`).
- Icons → inline-SVG `<symbol>` sprite + small `Icon` component.
- Fuzzy search → `pg_trgm` migration + `search_bathrooms` RPC.
- Duplicate detection / spatial → PostGIS migration + `nearby_bathrooms` RPC.

*(The migrations/RPCs above are for the schema/DATA agent to add — this RESEARCH pass documents them only; it edits no SQL, config, or source.)*

---

## 5. Explicitly rejected — and why

| Rejected | Tier | Reason |
|---|---|---|
| **`tile.openstreetmap.org` public tiles** | C | Usage policy forbids exactly our in-browser pattern (can't set `User-Agent`), no SLA, blocks heavy users without notice. Replaced by PMTiles. |
| **Nominatim public endpoint** | C | 1 req/s cap, **autocomplete explicitly forbidden**, no SLA, no browser `User-Agent`. Violates the constraint. |
| **Photon public endpoint** (`photon.komoot.io`) | C | "Extensive usage will be throttled or banned … no availability guarantee." |
| **Self-hosted Photon / Nominatim** | B-ish | Technically OSS + self-hostable, but ~95 GB DB + a standing server we run and pay for. Breaks "self-sufficient, nothing but Supabase." Not worth it for v1/v2. |
| **Any metered "free tier" tile/geocode API** (MapTiler, Stadia, Carto, Google, Mapbox…) | C | Free *tier* ≠ free; rate-limits or bills at scale. The whole point of the constraint. |
| **react-hook-form** | A | Fine library, just unneeded for two forms given the existing `Field` primitives. |
| **lucide-react** | A | Permissive and okay, but a dozen inline SVGs is leaner and palette-matched; no existing sprite to justify the barrel. |
| **browser-image-compression** | A | Does the job but **stale (2023)**; native canvas + `createImageBitmap` covers it with zero deps. |
| **date-fns / dayjs** | A | `Intl.RelativeTimeFormat` is native and sufficient. |

**Bottom line:** the self-sufficiency constraint is *fully satisfiable* for everything this app actually needs — the only casualty is **address-autocomplete geocoding**, which genuinely cannot be done for free and is well-replaced by a map click. The urgent action is retiring the OSM tile server for MapLibre + PMTiles on Supabase Storage before real traffic arrives.
