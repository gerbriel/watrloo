#!/usr/bin/env bash
# Verify a hosted basemap the way MapLibre + the pmtiles client actually use it.
# Run this AFTER uploading, against your public host. Every failure here is a
# failure the map would hit at runtime — Range, CORS, glyphs, sprites, types.
#
#   ./scripts/verify-basemap.sh https://basemap.example.com
#   ./scripts/verify-basemap.sh https://<acct>.r2.dev us-z13.pmtiles
#
# Optional env:
#   ORIGIN   the browser origin to test CORS against (default http://localhost:5173)
#            Use your deployed app origin to confirm production CORS.
set -euo pipefail

BASE="${1:-}"
PMTILES_FILE="${2:-us-z13.pmtiles}"
ORIGIN="${ORIGIN:-http://localhost:5173}"
[[ -n "$BASE" ]] || { echo "usage: $0 <base-url> [pmtiles-filename]" >&2; exit 2; }
BASE="${BASE%/}"                       # strip trailing slash
PMTILES_URL="${BASE}/${PMTILES_FILE}"
ASSETS_URL="${BASE}/assets"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
# check "label" "actual" "expected-substring"
check() { if [[ "$2" == *"$3"* ]]; then ok "$1 ($2)"; else bad "$1 — got: ${2:-<empty>}, want: *$3*"; fi; }

# Fetch response headers (following redirects) for a URL, optionally with extra args.
hdrs() { curl -sS -L -D - -o /dev/null "$@" 2>/dev/null; }
code() { curl -sS -L -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }
ctype(){ curl -sS -L -o /dev/null -w '%{content_type}' "$@" 2>/dev/null; }

echo "Verifying basemap at: $BASE"
echo "  archive: $PMTILES_URL"
echo "  assets:  $ASSETS_URL"
echo "  CORS origin under test: $ORIGIN"

echo
echo "== archive: Range + type =="
H="$(hdrs "$PMTILES_URL")"
check "HEAD advertises byte ranges" "$(printf '%s' "$H" | tr -d '\r' | awk -F': ' 'tolower($1)=="accept-ranges"{print tolower($2)}' | head -1)" "bytes"
check "archive Content-Type"        "$(ctype "$PMTILES_URL")" "application/octet-stream"

# A real range read: first 16 bytes must come back 206 with exactly 16 bytes,
# and those bytes are the "PMTiles" v3 magic.
R="$(curl -sS -L -D - -o /tmp/.basemap_probe.$$ -r 0-15 "$PMTILES_URL" 2>/dev/null)"
rc="$(printf '%s' "$R" | tr -d '\r' | awk 'toupper($1)=="HTTP/1.1"||$1 ~ /^HTTP/{c=$2} END{print c}')"
n="$(wc -c < /tmp/.basemap_probe.$$ | tr -d ' ')"
magic="$(head -c 7 /tmp/.basemap_probe.$$ 2>/dev/null || true)"
rm -f /tmp/.basemap_probe.$$
check "Range GET returns 206"        "$rc" "206"
check "Range GET returns 16 bytes"   "$n"  "16"
check "first bytes are PMTiles magic" "$magic" "PMTiles"

echo
echo "== glyphs (fonts) =="
for stack in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  enc="${stack// /%20}"
  u="${ASSETS_URL}/fonts/${enc}/0-255.pbf"
  check "glyph 200: $stack"        "$(code "$u")" "200"
  check "glyph type: $stack"       "$(ctype "$u")" "application/x-protobuf"
done

echo
echo "== sprites =="
for f in light.json light.png light@2x.json light@2x.png dark.json dark.png dark@2x.json dark@2x.png; do
  u="${ASSETS_URL}/sprites/v4/${f}"
  check "sprite 200: $f" "$(code "$u")" "200"
done
check "sprite type: light.json" "$(ctype "${ASSETS_URL}/sprites/v4/light.json")" "application/json"
check "sprite type: light.png"  "$(ctype "${ASSETS_URL}/sprites/v4/light.png")"  "image/png"

echo
echo "== CORS (as the browser sees it) =="
# Actual GET with an Origin: R2 echoes ACAO and exposes headers only when the
# Origin matches the bucket's CORS policy.
CH="$(hdrs -H "Origin: ${ORIGIN}" -r 0-15 "$PMTILES_URL" | tr -d '\r')"
acao="$(printf '%s' "$CH" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | head -1)"
aceh="$(printf '%s' "$CH" | awk -F': ' 'tolower($1)=="access-control-expose-headers"{print tolower($2)}' | head -1)"
if [[ "$acao" == "$ORIGIN" || "$acao" == "*" ]]; then ok "Access-Control-Allow-Origin ($acao)"; else bad "Access-Control-Allow-Origin — got: ${acao:-<none>}, want: $ORIGIN or *"; fi
# The pmtiles client reads content-range + etag off the response; they must be
# exposed to script or range reads fail even though the network succeeded.
check "expose content-range" "$aceh" "content-range"
check "expose etag"          "$aceh" "etag"

# CORS preflight (OPTIONS) — MapLibre issues one before a ranged GET.
PH="$(curl -sS -L -D - -o /dev/null -X OPTIONS \
  -H "Origin: ${ORIGIN}" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: range" "$PMTILES_URL" 2>/dev/null | tr -d '\r')"
pacao="$(printf '%s' "$PH" | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | head -1)"
if [[ "$pacao" == "$ORIGIN" || "$pacao" == "*" ]]; then ok "preflight Access-Control-Allow-Origin ($pacao)"; else bad "preflight ACAO — got: ${pacao:-<none>}, want: $ORIGIN or *"; fi

echo
echo "----------------------------------------"
if ((fail == 0)); then
  printf '\033[32mALL %d CHECKS PASSED\033[0m — the map has everything it needs.\n' "$pass"
  exit 0
else
  printf '\033[31m%d CHECK(S) FAILED\033[0m (%d passed). The map will not render correctly until these pass.\n' "$fail" "$pass"
  exit 1
fi
