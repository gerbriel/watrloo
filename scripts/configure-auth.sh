#!/usr/bin/env bash
# Configure the HOSTED Supabase project's Auth email settings via the
# Management API. This is the only way to change email confirmation and SMTP
# on the hosted project — `supabase/config.toml` governs the LOCAL stack only.
#
# See docs/ops/EMAIL.md for the full decision and why this exists.
#
# Endpoints (Management API):
#   GET   https://api.supabase.com/v1/projects/{ref}/config/auth
#   PATCH https://api.supabase.com/v1/projects/{ref}/config/auth
#
# Terminology, because the field name is a double negative:
#   mailer_autoconfirm = true   -> email confirmation OFF (signup returns a
#                                  session immediately; no email is sent)
#   mailer_autoconfirm = false  -> email confirmation ON (signup sends a
#                                  confirmation link and returns NO session)
#
# Usage:
#   scripts/configure-auth.sh show            # read + pretty-print email config
#   scripts/configure-auth.sh autoconfirm-on  # confirmation OFF  (signup just works)
#   scripts/configure-auth.sh autoconfirm-off # confirmation ON   (needs working SMTP)
#   scripts/configure-auth.sh set-smtp        # point Auth at a custom SMTP relay
#
# Required env for every command:
#   SUPABASE_ACCESS_TOKEN   a personal access token (see the error text below)
#   SUPABASE_PROJECT_REF    e.g. riylggdmveqwglqilwhl
#
# Extra env for `set-smtp`:
#   SMTP_HOST          e.g. smtp.resend.com
#   SMTP_PORT          default 587
#   SMTP_USER          e.g. resend
#   SMTP_PASS          the SMTP password / API key   (never printed)
#   SMTP_SENDER_EMAIL  e.g. no-reply@yourdomain.com  (used as the From + admin address)
#   SMTP_SENDER_NAME   default "Watrloo"
#
# Secrets are never echoed. Every mutating call asks for confirmation first
# (set AUTO_CONFIRM=1 to skip the prompt in non-interactive use).

set -euo pipefail

API_BASE="https://api.supabase.com"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: configure-auth.sh <command>

commands:
  show            Read the hosted auth config and print the email-relevant fields.
  autoconfirm-on  Turn email confirmation OFF (mailer_autoconfirm=true).
                  Signup returns a session immediately and sends no email.
  autoconfirm-off Turn email confirmation ON (mailer_autoconfirm=false).
                  Only do this once a working SMTP relay is configured, or new
                  users will never receive their confirmation email.
  set-smtp        Point Auth at a custom SMTP relay (reads SMTP_* env) and raise
                  the email send rate limit to 30/hour.

env (all commands):  SUPABASE_ACCESS_TOKEN  SUPABASE_PROJECT_REF
env (set-smtp):      SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS
                     SMTP_SENDER_EMAIL SMTP_SENDER_NAME
EOF
  exit 2
}

preflight_auth() {
  if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    cat >&2 <<'EOF'
error: SUPABASE_ACCESS_TOKEN is not set.

  This script talks to the Supabase Management API, which needs a personal
  access token (a project anon/service key will NOT work here).

  1. Open https://supabase.com/dashboard/account/tokens
  2. "Generate new token", name it (e.g. "watrloo-auth-cli"), copy it.
  3. Export it for this shell (do NOT commit it, do NOT put it in .env.local):

       export SUPABASE_ACCESS_TOKEN="sbp_xxxxxxxxxxxxxxxxxxxx"
       export SUPABASE_PROJECT_REF="riylggdmveqwglqilwhl"

  The token carries your full account privileges — keep it secret and revoke
  it from that same page when you are done.
EOF
    exit 1
  fi
  if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
    die "SUPABASE_PROJECT_REF is not set (e.g. export SUPABASE_PROJECT_REF=riylggdmveqwglqilwhl)."
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required but not found."
}

# api_request METHOD [DATAFILE] -> prints response body on stdout, dies on HTTP error.
api_request() {
  local method="$1" datafile="${2:-}"
  local url="${API_BASE}/v1/projects/${SUPABASE_PROJECT_REF}/config/auth"
  local args=(-sS -X "$method"
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"
    -H "Content-Type: application/json"
    -w $'\n%{http_code}')
  [[ -n "$datafile" ]] && args+=(--data-binary "@${datafile}")

  local resp status body
  resp="$(curl "${args[@]}" "$url")" || die "network error calling the Management API."
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  case "$status" in
    2*) printf '%s\n' "$body" ;;
    401) die "401 Unauthorized — SUPABASE_ACCESS_TOKEN is missing, wrong, or expired. Generate a new one at https://supabase.com/dashboard/account/tokens" ;;
    403) die "403 Forbidden — the token is valid but not allowed to manage project '${SUPABASE_PROJECT_REF}'. Check the ref and that the token belongs to an owner of that project." ;;
    404) die "404 Not Found — no project with ref '${SUPABASE_PROJECT_REF}'. Double-check SUPABASE_PROJECT_REF." ;;
    429) die "429 Too Many Requests — the Management API is rate-limiting you. Wait a moment and retry." ;;
    *)  die "unexpected HTTP ${status} from the Management API. Body: ${body}" ;;
  esac
}

confirm() {
  # $1 = human description of the mutation
  if [[ "${AUTO_CONFIRM:-}" == "1" ]]; then
    printf '==> %s (AUTO_CONFIRM=1)\n' "$1"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "refusing to mutate without confirmation in a non-interactive shell. Set AUTO_CONFIRM=1 to proceed."
  fi
  printf '\n%s\n' "$1"
  local reply=""
  read -r -p "Proceed against project '${SUPABASE_PROJECT_REF}'? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted; no changes made."
}

# Pretty-print only the email-relevant fields; never prints smtp_pass.
format_email_config() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.stdout.write("(could not parse the response as JSON)\n"); sys.exit(0)
fields = [
    "site_url", "external_email_enabled", "mailer_autoconfirm",
    "mailer_secure_email_change_enabled", "smtp_host", "smtp_port",
    "smtp_user", "smtp_admin_email", "smtp_sender_name",
    "smtp_max_frequency", "rate_limit_email_sent",
]
for f in fields:
    if f in d:
        print(f"  {f:36} {d[f]}")
ac = d.get("mailer_autoconfirm")
print()
if ac is True:
    print("  => Email confirmation is OFF. Signup returns a session immediately; no email is sent.")
elif ac is False:
    print("  => Email confirmation is ON. Signup sends a confirmation link and returns no session.")
    if not d.get("external_email_enabled") or not d.get("smtp_host"):
        print("     WARNING: confirmation is ON but no custom SMTP is configured — new")
        print("     users hit the built-in 2-emails/hour cap and may never get the email.")
PY
  elif command -v jq >/dev/null 2>&1; then
    jq '{site_url, external_email_enabled, mailer_autoconfirm, smtp_host, smtp_port, smtp_user, smtp_admin_email, smtp_sender_name, smtp_max_frequency, rate_limit_email_sent}'
  else
    cat
    echo >&2 "(install jq or python3 for a readable summary)"
  fi
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

cmd_show() {
  preflight_auth
  printf '==> auth email config for project %s\n\n' "$SUPABASE_PROJECT_REF"
  api_request GET | format_email_config
}

# $1 = "true" (confirmation OFF) or "false" (confirmation ON)
cmd_autoconfirm() {
  preflight_auth
  local value="$1" desc
  if [[ "$value" == "true" ]]; then
    desc="Turn email confirmation OFF (mailer_autoconfirm=true): signup will return a session immediately and send no email."
  else
    desc="Turn email confirmation ON (mailer_autoconfirm=false): signup will send a confirmation link. This BREAKS signup unless a working SMTP relay is configured."
  fi
  confirm "$desc"

  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  printf '{"mailer_autoconfirm": %s}' "$value" >"$tmp"

  printf '==> patching...\n'
  api_request PATCH "$tmp" | format_email_config
  printf '\n==> done.\n'
}

cmd_set_smtp() {
  preflight_auth
  : "${SMTP_HOST:?SMTP_HOST is required (e.g. smtp.resend.com)}"
  : "${SMTP_USER:?SMTP_USER is required (e.g. resend)}"
  : "${SMTP_PASS:?SMTP_PASS is required (your SMTP password / API key)}"
  : "${SMTP_SENDER_EMAIL:?SMTP_SENDER_EMAIL is required (e.g. no-reply@yourdomain.com)}"
  local port="${SMTP_PORT:-587}"
  local sender_name="${SMTP_SENDER_NAME:-Watrloo}"

  # Redacted summary — SMTP_PASS is never shown.
  cat <<EOF

Configure custom SMTP on project '${SUPABASE_PROJECT_REF}':
  host          ${SMTP_HOST}
  port          ${port}
  user          ${SMTP_USER}
  sender email  ${SMTP_SENDER_EMAIL}
  sender name   ${sender_name}
  password      (provided via SMTP_PASS, hidden)
  rate limit    raising rate_limit_email_sent to 30 emails/hour
EOF
  confirm "Apply the SMTP settings above and enable external email."

  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  trap 'rm -f "$tmp"' RETURN

  # Build the JSON payload from env WITHOUT putting the password on argv or in
  # any printed string. python3 preferred; jq --arg as a fallback.
  if command -v python3 >/dev/null 2>&1; then
    SMTP_PORT="$port" SMTP_SENDER_NAME="$sender_name" python3 - >"$tmp" <<'PY'
import json, os
print(json.dumps({
    "external_email_enabled": True,
    "smtp_host": os.environ["SMTP_HOST"],
    "smtp_port": os.environ["SMTP_PORT"],
    "smtp_user": os.environ["SMTP_USER"],
    "smtp_pass": os.environ["SMTP_PASS"],
    "smtp_admin_email": os.environ["SMTP_SENDER_EMAIL"],
    "smtp_sender_name": os.environ["SMTP_SENDER_NAME"],
    "rate_limit_email_sent": 30,
}))
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -n \
      --arg host "$SMTP_HOST" --arg port "$port" --arg user "$SMTP_USER" \
      --arg pass "$SMTP_PASS" --arg admin "$SMTP_SENDER_EMAIL" --arg name "$sender_name" \
      '{external_email_enabled: true, smtp_host: $host, smtp_port: $port, smtp_user: $user, smtp_pass: $pass, smtp_admin_email: $admin, smtp_sender_name: $name, rate_limit_email_sent: 30}' \
      >"$tmp"
  else
    die "set-smtp needs python3 or jq to build the request safely; neither was found."
  fi

  printf '==> patching...\n'
  api_request PATCH "$tmp" | format_email_config
  cat <<'EOF'

==> done. Note: this does NOT toggle confirmation. To require confirmation now
    that SMTP works, run:  scripts/configure-auth.sh autoconfirm-off
    Then send yourself a test signup and confirm the email actually arrives.
EOF
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

main() {
  local cmd="${1:-}"
  case "$cmd" in
    show)             cmd_show ;;
    autoconfirm-on)   cmd_autoconfirm true ;;
    autoconfirm-off)  cmd_autoconfirm false ;;
    set-smtp)         cmd_set_smtp ;;
    -h|--help|help|"") usage ;;
    *) printf 'error: unknown command: %s\n\n' "$cmd" >&2; usage ;;
  esac
}

main "$@"
