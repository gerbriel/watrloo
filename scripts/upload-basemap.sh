#!/usr/bin/env bash
# Upload the self-hosted basemap to Cloudflare R2 (or any S3-compatible store).
#
# This is the ONE command that turns a locally-verified basemap into a hosted
# one. It sets the correct Content-Type per file class, which MapLibre and the
# pmtiles client rely on, and is idempotent: re-running skips bytes that already
# match (with rclone) so a partial upload resumes cleanly.
#
# It does NOT install anything. You need either `rclone` (preferred) or the AWS
# CLI already on PATH. See docs/BASEMAP.md.
#
# Required environment:
#   R2_ACCOUNT_ID          your Cloudflare account id (used to derive the endpoint)
#   R2_BUCKET              target bucket name, e.g. watrloo-basemap
#   R2_ACCESS_KEY_ID       R2 API token access key id
#   R2_SECRET_ACCESS_KEY   R2 API token secret access key
# Optional environment:
#   R2_ENDPOINT           override the derived endpoint URL
#   BASEMAP_DIR           source dir (default: ./basemap)
#   PMTILES_FILE          archive filename (default: us-z13.pmtiles). Set to a
#                         versioned name to upload alongside the old one.
#   DRY_RUN=1             print the plan and exit without transferring anything
set -euo pipefail

BASEMAP_DIR="${BASEMAP_DIR:-basemap}"
PMTILES_FILE="${PMTILES_FILE:-us-z13.pmtiles}"
DRY_RUN="${DRY_RUN:-}"

die() { echo "error: $*" >&2; exit 1; }

# --- Preflight: required env ------------------------------------------------
missing=()
for v in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if ((${#missing[@]})); then
  die "missing required env var(s): ${missing[*]}
  export them first, e.g.:
    export R2_ACCOUNT_ID=...      R2_BUCKET=watrloo-basemap
    export R2_ACCESS_KEY_ID=...   R2_SECRET_ACCESS_KEY=..."
fi

R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"

# --- Preflight: source files exist -----------------------------------------
PMTILES_PATH="${BASEMAP_DIR}/${PMTILES_FILE}"
ASSETS_DIR="${BASEMAP_DIR}/assets"
[[ -f "$PMTILES_PATH" ]]   || die "archive not found: $PMTILES_PATH (run ./scripts/build-basemap.sh first)"
[[ -d "$ASSETS_DIR" ]]     || die "assets dir not found: $ASSETS_DIR"
[[ -d "$ASSETS_DIR/fonts" ]]   || die "fonts dir not found: $ASSETS_DIR/fonts"
[[ -d "$ASSETS_DIR/sprites" ]] || die "sprites dir not found: $ASSETS_DIR/sprites"

# --- Preflight: an uploader tool exists ------------------------------------
# Under DRY_RUN we still print the plan even if no tool is installed yet.
TOOL=""
if command -v rclone >/dev/null 2>&1; then TOOL="rclone"
elif command -v aws >/dev/null 2>&1;  then TOOL="aws"
elif [[ -n "$DRY_RUN" ]]; then TOOL="(none installed — install rclone or aws before a real run)"
else
  die "need 'rclone' (preferred) or the AWS CLI on PATH. This script will not install them.
  rclone: https://rclone.org/downloads/   aws: https://aws.amazon.com/cli/"
fi

# Content-Type per file class. MapLibre and the pmtiles client dispatch on these.
CT_PMTILES="application/octet-stream"
CT_PBF="application/x-protobuf"
CT_JSON="application/json"
CT_PNG="image/png"

archive_size="$(du -h "$PMTILES_PATH" | cut -f1)"

cat <<PLAN
==> plan
  tool:      $TOOL
  endpoint:  $R2_ENDPOINT
  bucket:    $R2_BUCKET
  will upload:
    $PMTILES_PATH  (${archive_size})  ->  s3://$R2_BUCKET/$PMTILES_FILE            Content-Type: $CT_PMTILES
    $ASSETS_DIR/**/*.pbf              ->  s3://$R2_BUCKET/assets/...               Content-Type: $CT_PBF
    $ASSETS_DIR/**/*.json            ->  s3://$R2_BUCKET/assets/...               Content-Type: $CT_JSON
    $ASSETS_DIR/**/*.png             ->  s3://$R2_BUCKET/assets/...               Content-Type: $CT_PNG
PLAN

if [[ -n "$DRY_RUN" ]]; then
  echo "==> DRY_RUN set; nothing uploaded."
  exit 0
fi

if [[ "$TOOL" == "rclone" ]]; then
  # Configure an on-the-fly remote purely through env vars — no config file,
  # no secrets written to disk.
  export RCLONE_CONFIG_R2_TYPE="s3"
  export RCLONE_CONFIG_R2_PROVIDER="Cloudflare"
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  export RCLONE_CONFIG_R2_ACL="private"
  RC=(rclone --s3-no-check-bucket --progress)

  echo "==> uploading archive"
  "${RC[@]}" copyto "$PMTILES_PATH" "r2:${R2_BUCKET}/${PMTILES_FILE}" \
    --header-upload "Content-Type: ${CT_PMTILES}"

  # One pass per file class so each lands with the right Content-Type. rclone's
  # copy is idempotent: unchanged objects are skipped.
  echo "==> uploading glyphs (*.pbf)"
  "${RC[@]}" copy "$ASSETS_DIR" "r2:${R2_BUCKET}/assets" \
    --include "*.pbf" --header-upload "Content-Type: ${CT_PBF}"
  echo "==> uploading sprite JSON (*.json)"
  "${RC[@]}" copy "$ASSETS_DIR" "r2:${R2_BUCKET}/assets" \
    --include "*.json" --header-upload "Content-Type: ${CT_JSON}"
  echo "==> uploading sprite PNG (*.png)"
  "${RC[@]}" copy "$ASSETS_DIR" "r2:${R2_BUCKET}/assets" \
    --include "*.png" --header-upload "Content-Type: ${CT_PNG}"
  echo "==> uploading remaining text (*.txt licenses)"
  "${RC[@]}" copy "$ASSETS_DIR" "r2:${R2_BUCKET}/assets" \
    --include "*.txt" --header-upload "Content-Type: text/plain; charset=utf-8"

else
  # AWS CLI path. R2 ignores region but the CLI insists on one.
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="auto"
  AWS=(aws s3 --endpoint-url "$R2_ENDPOINT")

  echo "==> uploading archive"
  "${AWS[@]}" cp "$PMTILES_PATH" "s3://${R2_BUCKET}/${PMTILES_FILE}" \
    --content-type "$CT_PMTILES"

  # `sync` is idempotent (skips by size/mtime). One pass per class for the
  # right Content-Type.
  echo "==> uploading glyphs (*.pbf)"
  "${AWS[@]}" sync "$ASSETS_DIR" "s3://${R2_BUCKET}/assets" \
    --exclude "*" --include "*.pbf" --content-type "$CT_PBF"
  echo "==> uploading sprite JSON (*.json)"
  "${AWS[@]}" sync "$ASSETS_DIR" "s3://${R2_BUCKET}/assets" \
    --exclude "*" --include "*.json" --content-type "$CT_JSON"
  echo "==> uploading sprite PNG (*.png)"
  "${AWS[@]}" sync "$ASSETS_DIR" "s3://${R2_BUCKET}/assets" \
    --exclude "*" --include "*.png" --content-type "$CT_PNG"
  echo "==> uploading remaining text (*.txt licenses)"
  "${AWS[@]}" sync "$ASSETS_DIR" "s3://${R2_BUCKET}/assets" \
    --exclude "*" --include "*.txt" --content-type "text/plain; charset=utf-8"
fi

cat <<DONE

==> done
Next:
  1. Make the bucket publicly readable (r2.dev subdomain or a custom domain).
  2. Set the CORS policy (see docs/BASEMAP.md) — the map is blank without it.
  3. Verify:  ./scripts/verify-basemap.sh https://<your-public-host>
  4. Point the app:
       VITE_BASEMAP_URL=https://<your-public-host>/${PMTILES_FILE}
       VITE_BASEMAP_ASSETS_URL=https://<your-public-host>/assets
DONE
