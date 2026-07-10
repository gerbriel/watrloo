#!/usr/bin/env bash
# Build Watrloo's self-hosted basemap.
#
# Produces, under ./basemap/:
#   us-z13.pmtiles   a ~4 GB vector basemap of the contiguous US, zoom 0-13
#   assets/fonts     the three Noto Sans stacks the Protomaps style references
#   assets/sprites   the v4 sprite sheets (light/dark/etc.)
#
# Upload all of it to object storage that supports HTTP Range requests, then
# point VITE_BASEMAP_URL and VITE_BASEMAP_ASSETS_URL at it. See docs/BASEMAP.md.
#
# Requires: pmtiles (brew install pmtiles), git, curl.

set -euo pipefail

BUILD_DATE="${BUILD_DATE:-}"          # e.g. 20260706; empty = auto-detect latest
MAXZOOM="${MAXZOOM:-13}"
BBOX="${BBOX:--125.0,24.4,-66.9,49.4}" # contiguous US. Excludes AK/HI (see docs).
OUT_DIR="${OUT_DIR:-basemap}"
ASSETS_REPO="https://github.com/protomaps/basemaps-assets.git"

# The style only ever asks for these three stacks. Shipping all of Noto would
# be ~1 GB of glyphs nobody fetches.
FONT_STACKS=("Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic")

command -v pmtiles >/dev/null || { echo "error: pmtiles not found. brew install pmtiles" >&2; exit 1; }

# Protomaps publishes a daily build. Walk back from today to find one that exists.
if [[ -z "$BUILD_DATE" ]]; then
  for i in $(seq 0 14); do
    d=$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "-${i} days" +%Y%m%d)
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://build.protomaps.com/${d}.pmtiles")" == "206" ]]; then
      BUILD_DATE="$d"; break
    fi
  done
fi
[[ -n "$BUILD_DATE" ]] || { echo "error: no recent Protomaps build found" >&2; exit 1; }

SRC="https://build.protomaps.com/${BUILD_DATE}.pmtiles"
echo "==> source:  $SRC"
echo "==> bbox:    $BBOX  (maxzoom $MAXZOOM)"

mkdir -p "$OUT_DIR"

echo "==> estimating size (no download)"
pmtiles extract "$SRC" /dev/null --bbox="$BBOX" --maxzoom="$MAXZOOM" --dry-run 2>&1 \
  | grep -oE 'archive size of .*' || true

echo "==> extracting -> $OUT_DIR/us-z${MAXZOOM}.pmtiles"
# Only the byte ranges covering the bbox are fetched, not the whole 127 GB world.
pmtiles extract "$SRC" "$OUT_DIR/us-z${MAXZOOM}.pmtiles" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=8

echo "==> fetching fonts + sprites"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 -q "$ASSETS_REPO" "$tmp/assets"

mkdir -p "$OUT_DIR/assets/fonts" "$OUT_DIR/assets/sprites"
for stack in "${FONT_STACKS[@]}"; do
  cp -R "$tmp/assets/fonts/$stack" "$OUT_DIR/assets/fonts/"
done
cp "$tmp/assets/fonts/OFL.txt" "$OUT_DIR/assets/fonts/" 2>/dev/null || true
cp -R "$tmp/assets/sprites/v4" "$OUT_DIR/assets/sprites/"

echo
echo "==> done"
du -sh "$OUT_DIR/us-z${MAXZOOM}.pmtiles" "$OUT_DIR/assets"
echo
echo "Next: upload to R2 and set VITE_BASEMAP_URL / VITE_BASEMAP_ASSETS_URL."
echo "See docs/BASEMAP.md — CORS and Range support are both required."
