# The basemap

Watrloo renders its map from a **static file you host**, not from a tile API.
There is no per-request call to anyone.

## Why not just use OpenStreetMap's tile server?

Because we would be stealing it. The [OSM Tile Usage
Policy](https://operations.osmfoundation.org/policies/tiles/) is explicit that
`tile.openstreetmap.org` is not a free CDN for applications: it offers no
uptime guarantee, requires a identifying `User-Agent` that a browser cannot
set, and heavy consumers get blocked without notice. It works beautifully in
development and then degrades in production, which is the worst possible
failure shape.

Commercial tile APIs (Mapbox, Google, MapTiler) solve that with a billed API
key. This project is meant to be self-sufficient, so we take the third option.

## How it works

[PMTiles](https://docs.protomaps.com/pmtiles/) is a single-file archive of map
tiles with an embedded index. The browser issues HTTP **Range** requests to pull
just the bytes for the tiles on screen. Any object store that supports Range and
CORS can serve it — no server, no tile process.

So a visitor downloads only the tiles they actually look at. **Archive size costs
you storage, not per-user bandwidth.**

Three pieces:

| Piece | What | Size |
| --- | --- | --- |
| `us-z13.pmtiles` | Vector tiles, contiguous US, zoom 0–13 | ~3.9 GB |
| `assets/fonts/` | Three Noto Sans stacks the style references | ~13 MB |
| `assets/sprites/v4/` | Icon sprite sheets (light/dark/etc., 1x + @2x) | ~180 KB |

The fonts and sprites matter more than they look. Protomaps' default style
points `glyphs` and `sprite` at `protomaps.github.io`. Leaving those defaults in
place would reintroduce exactly the third-party dependency we removed. We host
them ourselves.

## Build it

```bash
./scripts/build-basemap.sh
```

`pmtiles extract` fetches only the byte ranges covering the bounding box, so
building a 3.9 GB US extract from the 127 GB world archive transfers ~4.4 GB,
not 127 GB. Takes about three minutes on a fast connection.

Knobs, via environment variables:

| Var | Default | Notes |
| --- | --- | --- |
| `MAXZOOM` | `13` | Size roughly **4× per zoom level**. See the table below. |
| `BBOX` | contiguous US | `min_lon,min_lat,max_lon,max_lat` |
| `BUILD_DATE` | latest | A Protomaps daily build, e.g. `20260706` |

Measured sizes (Protomaps `20260706` build):

| Region | Max zoom | Archive |
| --- | --- | --- |
| World | 15 | 127.3 GB |
| Contiguous US | 13 | 4.2 GB |
| Contiguous US | 12 | 1.9 GB |
| Contiguous US | 11 | 814 MB |
| Contiguous US | 10 | 376 MB |
| SF Bay Area | 15 | 147 MB |
| NYC | 15 | 127 MB |

Zoom 13 shows individual streets and building footprints. Below ~12 you lose the
street detail that makes the map useful for finding a specific door.

**Alaska and Hawaii are not in the default bbox.** They need separate extracts
(a bbox spanning them would drag in most of Canada and the Pacific). MapLibre can
hold several PMTiles sources; that is left as a follow-up.

## Verify locally before uploading

The archive is ~4 GB. Every way this can fail — a corrupt archive, a missing
glyph range, a font stack the style references but we never vendored, a wrong
Content-Type, absent CORS or Range support — otherwise surfaces only *after* the
upload, as a blank map with no obvious cause. Prove the whole pipeline against a
local server first, so hosting on R2 is a pure swap.

This exact sequence has been run end to end on this build; the numbers below are
what it produced.

**1. The archive is structurally sound.**

```bash
pmtiles show basemap/us-z13.pmtiles   # header, tile type, zoom, bounds, clustered
pmtiles verify basemap/us-z13.pmtiles # structure check (no tile-content decode)
```

Observed: spec v3, tile type **mvt**, zoom **0–13**, bounds
`-125, 24.4, -66.9, 49.4`, `clustered: true`, tile + internal compression
**gzip**, 9 vector layers (`boundaries, buildings, earth, landcover, landuse,
places, pois, roads, water`). `verify` passes.

A single real tile decodes as a non-empty MVT. Dolores Park (37.7596, -122.4269)
is z13 tile `13/1310/3166`:

```bash
pmtiles tile basemap/us-z13.pmtiles 13 1310 3166 | head -c2 | xxd  # 1f 8b => gzip
```

That tile is 90,912 bytes gzipped; decompressed it parses as MVT with the layers
`buildings, earth, landuse, places, pois, roads, water` (218 road, 25 building,
25 place features, etc.).

**2. Serve `basemap/` over HTTP with Range + CORS**, then point the app at it and
run the verifier. The static server must do three things a naive one won't:
support byte **Range** (206 responses), send permissive **CORS**, and **expose**
`content-range` + `etag` to script (see the CORS section below — this is the same
requirement R2 has). With such a server on, say, port 8788:

```bash
VITE_BASEMAP_URL=http://127.0.0.1:8788/us-z13.pmtiles \
VITE_BASEMAP_ASSETS_URL=http://127.0.0.1:8788/assets \
  npm run dev
# In another shell — the same checklist you'll run against R2 later:
./scripts/verify-basemap.sh http://127.0.0.1:8788
```

`verify-basemap.sh` checks, and this build passed, all of: `accept-ranges: bytes`;
a `Range: bytes=0-15` GET returning **206** with exactly 16 bytes whose first 7
are the `PMTiles` magic; each of the three glyph stacks at
`/assets/fonts/<stack>/0-255.pbf` returning **200 + application/x-protobuf**; the
`light`/`dark` sprites (`.json`, `.png`, and `@2x`) returning **200** with
`application/json` / `image/png`; and CORS echoing the origin while exposing
`content-range` and `etag`.

**3. The style references only assets we vendored.** The Protomaps style built by
`layers('protomaps', namedFlavor(theme))` produces 71 layers and asks for exactly
three font stacks — **Noto Sans Regular, Noto Sans Medium, Noto Sans Italic** —
which are the three we ship (256 glyph ranges each). It emits static icon names
`arrow`, `capital`, `townspot`, `train_station`, and the road-shield families
`US:I-`, `NL:S-road-`, `generic_shield-` in the `1char`…`5char` variants — every
one of which is present in the sprite JSON. The `pois` layer sets `icon-image`
from the feature's `kind` at runtime; a value with no matching sprite renders no
icon (a no-op), not a broken map. **No font stack or static icon the style names
is missing.**

**4. It renders.** With the app pointed at the local server, `/map` loads the real
style (source `pmtiles://…`, attribution "Protomaps © OpenStreetMap"), the browser
issues Range reads against the archive (verified: 6 archive reads, 5 glyph fetches,
2 sprite fetches for the default US view), and the dark basemap paints — land and
water fills, state boundaries, and place labels (proving the self-hosted glyphs
work) — with all pins on top.

## Host it on Cloudflare R2

R2's free tier includes 10 GB of storage and **zero egress fees**, which is what
makes this affordable. Supabase Storage also works and supports Range (verified),
but its free tier caps at 1 GB — enough for a metro extract, not for the US.

### 1. Create the bucket

Cloudflare dashboard → R2 → *Create bucket* → name it `watrloo-basemap`.

### 2. Upload

R2 is S3-compatible. Use the upload script — it sets the right Content-Type per
file class (the archive `application/octet-stream`, glyphs
`application/x-protobuf`, sprite JSON `application/json`, sprite PNG `image/png`),
which MapLibre and the pmtiles client dispatch on, and it is idempotent so a
partial upload resumes. It needs `rclone` (preferred) or the AWS CLI already on
PATH — it installs nothing.

```bash
export R2_ACCOUNT_ID=...            # derives the endpoint
export R2_BUCKET=watrloo-basemap
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...

DRY_RUN=1 ./scripts/upload-basemap.sh   # preview exactly what it will do
./scripts/upload-basemap.sh             # the ~4 GB archive + fonts + sprites
```

Set `PMTILES_FILE=us-z13-YYYYMMDD.pmtiles` to publish a versioned archive
alongside the current one (see Refreshing). `R2_ENDPOINT` overrides the derived
`https://<account-id>.r2.cloudflarestorage.com`.

Doing it by hand instead is four `aws s3 cp` / `sync` passes — one per file class
with its `--content-type` — against `--endpoint-url "$R2_ENDPOINT"`; the script is
just those passes with preflight checks.

### 3. Make it publicly readable

Either enable the managed `r2.dev` subdomain (fine to start; rate-limited and
not meant for production), or attach a custom domain. The custom domain also
gets you Cloudflare's cache in front of the range requests, which is the point.

### 4. CORS — required

Without this the browser blocks every range request and the map silently shows
nothing. In the bucket's **Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://your-app-domain", "http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range", "if-match"],
    "ExposeHeaders": ["etag", "content-range", "content-length", "accept-ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

`ExposeHeaders` is the part people miss, and it is exactly right as written:
driving the `pmtiles` client's `FetchSource` against a server that exposes
`etag, content-range, content-length, accept-ranges` was confirmed to satisfy its
range reads (it reads `content-range` to size the archive and `etag` to detect a
changed archive mid-flight; without them exposed to script the reads fail even
though the network request succeeded). `AllowedHeaders` must include `range`;
`if-match` is harmless to keep though this client avoids sending it under CORS.

### 5. Point the app at it

```bash
# .env.local
VITE_BASEMAP_URL=https://basemap.example.com/us-z13.pmtiles
VITE_BASEMAP_ASSETS_URL=https://basemap.example.com/assets
```

### 6. Verify before trusting it

One command runs the whole checklist — Range, Content-Types, all three glyph
stacks, every sprite, and CORS (including the exposed headers) — and prints a
`✓`/`✗` board, exiting nonzero on any failure:

```bash
./scripts/verify-basemap.sh https://basemap.example.com
# custom origin to test production CORS, and a versioned archive name:
ORIGIN=https://your-app-domain ./scripts/verify-basemap.sh \
  https://basemap.example.com us-z13-20261001.pmtiles
```

This is the same script used to gate the local dry-run, so a green board here
means the only thing that changed from the proven-good local setup is the host.

## If you skip all of this

Leave `VITE_BASEMAP_URL` and `VITE_BASEMAP_ASSETS_URL` unset. The app runs, and
the map degrades to pins on a flat background with a note explaining why. A fresh
clone works with no basemap infrastructure at all.

## Licensing

Map data is © OpenStreetMap contributors, licensed
[ODbL](https://openstreetmap.org/copyright). Attribution is a license condition,
not a courtesy — it is wired into the map's `AttributionControl` and must stay.
Fonts are SIL OFL; sprites derive from MIT-licensed
[tangrams/icons](https://github.com/tangrams/icons).

## Refreshing

OSM changes constantly. Re-run the build script and re-upload when the data feels
stale — quarterly is plenty for this app. Upload to a new versioned key
(`us-z13-20261001.pmtiles`) and flip the env var, so a bad build is a one-line
rollback rather than a re-upload.
