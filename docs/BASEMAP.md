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
| `assets/sprites/v4/` | Icon sprite sheets | ~260 KB |

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

## Host it on Cloudflare R2

R2's free tier includes 10 GB of storage and **zero egress fees**, which is what
makes this affordable. Supabase Storage also works and supports Range (verified),
but its free tier caps at 1 GB — enough for a metro extract, not for the US.

### 1. Create the bucket

Cloudflare dashboard → R2 → *Create bucket* → name it `watrloo-basemap`.

### 2. Upload

R2 is S3-compatible. With `rclone` or the AWS CLI configured against your R2
endpoint (`https://<account-id>.r2.cloudflarestorage.com`):

```bash
# The archive. This is a ~4 GB upload; do it once.
aws s3 cp basemap/us-z13.pmtiles s3://watrloo-basemap/us-z13.pmtiles \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type application/octet-stream

# Fonts and sprites. Content types matter: MapLibre parses these by type.
aws s3 cp basemap/assets s3://watrloo-basemap/assets --recursive \
  --endpoint-url "$R2_ENDPOINT" \
  --exclude "*" --include "*.pbf" --content-type application/x-protobuf

aws s3 cp basemap/assets s3://watrloo-basemap/assets --recursive \
  --endpoint-url "$R2_ENDPOINT" \
  --exclude "*" --include "*.json" --content-type application/json

aws s3 cp basemap/assets s3://watrloo-basemap/assets --recursive \
  --endpoint-url "$R2_ENDPOINT" \
  --exclude "*" --include "*.png" --content-type image/png
```

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

`ExposeHeaders` is the part people miss. The `pmtiles` client reads
`content-range` and `etag` off the response; if they aren't exposed to script,
range reads fail even though the network request succeeded.

### 5. Point the app at it

```bash
# .env.local
VITE_BASEMAP_URL=https://basemap.example.com/us-z13.pmtiles
VITE_BASEMAP_ASSETS_URL=https://basemap.example.com/assets
```

### 6. Verify before trusting it

```bash
# Must print 206 and 'accept-ranges: bytes'.
curl -s -o /dev/null -D - -r 0-15 "$VITE_BASEMAP_URL" | head -1
curl -sI "$VITE_BASEMAP_URL" | grep -i accept-ranges

# Must print 200.
curl -s -o /dev/null -w '%{http_code}\n' \
  "$VITE_BASEMAP_ASSETS_URL/fonts/Noto%20Sans%20Regular/0-255.pbf"
curl -s -o /dev/null -w '%{http_code}\n' \
  "$VITE_BASEMAP_ASSETS_URL/sprites/v4/light.json"

# Must echo back your origin.
curl -sI -H "Origin: http://localhost:5173" "$VITE_BASEMAP_URL" \
  | grep -i access-control-allow-origin
```

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
