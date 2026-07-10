# Watrloo — Email & signup confirmation

**Author:** EMAIL agent · **Date:** 2026-07-10
**Constraint being honored:** self-sufficient — no third-party service or API unless it is **100% free**. Supabase (Postgres/Auth/Storage) and one static file on Cloudflare R2 are the only allowed backends. Every transactional-email vendor is a third party, so choosing one is a real architectural decision, not a config chore.

**TL;DR recommendation (staged):**
1. **Now — turn email confirmation OFF** (`scripts/configure-auth.sh autoconfirm-on`). Zero third parties, signup works this minute, and **the app already handles it correctly** (§6).
2. **Before any real launch — wire a free custom SMTP relay** (Resend or Brevo) on your own domain, then turn confirmation back ON (`set-smtp` → `autoconfirm-off`). This is the only way to get password recovery and to restore the abuse brake that turning confirmation off removes (§3a, §7).

---

## 1. The verified problem

The hosted project (`riylggdmveqwglqilwhl`) has **email confirmation ON**. Signup calls Supabase's **built-in** email sender, which is capped at **2 emails per hour, project-wide**. A live signup attempt returned:

```json
{ "code": 429, "error_code": "over_email_send_rate_limit", "msg": "email rate limit exceeded" }
```

Consequence: the `auth.users` row is created, the confirmation email never sends, and `SignUp.tsx` shows "Check your email" forever. Supabase says the built-in sender is not for production, in as many words:

> "The default SMTP service is provided as best-effort only and intended for the following non-production use cases: Exploring and getting started with Supabase Auth, Setting up and testing email templates with the members of the project's team, Building toy projects, demos or any non-mission-critical application."
> — [Send emails with custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

**Why `config.toml` doesn't help.** `supabase/config.toml` sets `enable_confirmations = false` (line 176) and `[auth.rate_limit] email_sent = 2` (line 149). Those govern the **local** `supabase start` stack only. The hosted project's auth settings live in the dashboard / Management API and are unaffected by anything in this repo.

### Platform facts I verified (don't take these from memory — they move)

| Claim | Verified value | Source |
|---|---|---|
| Built-in email sender rate limit | **2 messages/hour, project-wide.** "The rate limit ... You can only change this with a custom SMTP setup." | [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits) |
| Built-in sender is non-production | Quoted above — "best-effort only", "toy projects, demos or any non-mission-critical application". | [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp) |
| Custom SMTP raises the cap | Enabling custom SMTP starts at **30 messages/hour**, then tunable via `rate_limit_email_sent`. | [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp), [rate-limits](https://supabase.com/docs/guides/auth/rate-limits) |
| `rate_limit_email_sent` scope | The per-hour email cap. Listed as configurable in the Management API but **"Custom SMTP only"** — the built-in sender is stuck at 2/hr. | [rate-limits](https://supabase.com/docs/guides/auth/rate-limits) |
| Custom SMTP on the **Free** plan | **Available.** It is an Auth configuration setting, not a plan-gated feature — the dashboard SMTP form and the `[auth.email.smtp]` block in `config.toml` (lines 187–194) exist on every tier. | [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp) |
| "Confirm email" is per-project | Yes — dashboard **Authentication → Sign In / Providers → Email → "Confirm email"**, or Management API field `mailer_autoconfirm`. | [auth-smtp](https://supabase.com/docs/guides/auth/auth-smtp), [Management API](https://supabase.com/docs/reference/api/v1-update-auth-service-config) |

### The Management API (how the script and the fix actually work)

Auth config is read and written per-project through the Management API:

- **Read:** `GET https://api.supabase.com/v1/projects/{ref}/config/auth`
- **Write:** `PATCH https://api.supabase.com/v1/projects/{ref}/config/auth`
- **Auth:** `Authorization: Bearer <personal access token>`. A PAT is created at **[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)** ("Generate new token"); alternatively `supabase login` stores one for the CLI. A project anon/service key does **not** work on this API.

Relevant body fields:

| Field | Type | Meaning |
|---|---|---|
| `mailer_autoconfirm` | bool | **`true` = confirmation OFF** (signup auto-confirms, returns a session, sends no email). **`false` = confirmation ON.** Note the double negative. |
| `external_email_enabled` | bool | Turns the custom SMTP relay on. |
| `smtp_host` / `smtp_port` | string | Relay endpoint. |
| `smtp_user` / `smtp_pass` | string | Relay credentials (the API key for most providers). |
| `smtp_admin_email` | string | The `From:` / sender address. |
| `smtp_sender_name` | string | Display name on outgoing mail. |
| `rate_limit_email_sent` | number | Per-hour email cap (custom SMTP only). |

Reference: [Update auth config](https://supabase.com/docs/reference/api/v1-update-auth-service-config), [Get auth config](https://supabase.com/docs/reference/api/v1-get-auth-service-config).

**There are no Management API tokens and no SMTP credentials on this machine, so the fix cannot be applied here.** This doc + `scripts/configure-auth.sh` are staged so the owner can apply it in one command once they supply a token.

---

## 2. The four options

| Option | Cost | Honors "100% free / self-sufficient"? | Deliverability risk | Abuse impact | What breaks |
|---|---|---|---|---|---|
| **(a) Confirmation OFF** | $0 | ✅ Fully — no email at all, no third party | N/A (no email sent) | ⬆️ Removes the accidental Sybil brake; instant `authenticated` writes | Nothing today; **no path to password reset** later |
| **(b) Free custom SMTP** | $0 relay + ~$10/yr domain | ⚠️ Relay is a third party, but free-forever tiers qualify; domain is a one-time cost, not a metered API | Low **with** SPF/DKIM/DMARC on a real domain; **high (spam)** without | Restores confirm-gates-writes; unlocks 30 signups/hr | Nothing — app already handles both states |
| **(c) Self-hosted mail server** | VPS + time | ❌ In practice worse than a free relay | **Very high** — port 25 blocked, cold IP, no reputation | Same as (b) if it worked | Ongoing ops burden; mail lands in spam |
| **(d) Passwordless / OAuth** | $0–third party | ❌ Magic link still needs email; OAuth is a third party + tracking vector | Same email problem, or Google/GitHub dependency | Moves trust to the IdP | Requires rebuilding the auth UI |

### (a) Turn email confirmation OFF — honest downsides

Set `mailer_autoconfirm = true`. `supabase.auth.signUp` then returns a **session immediately** and sends no email. Signup works instantly with zero third parties. The costs:

- **Unverified / fake emails.** Anyone can register `nobody@nowhere.invalid`. For this app that is low-harm: the *only* PII stored is the email itself (see `profiles` — just `username`, `avatar_url`; the email lives in `auth.users`), and every content row is a public directory entry. A junk email harms mainly the junk account.
- **No password reset — today and, more importantly, tomorrow.** I grepped `src/` for `resetPassword`, `resetPasswordForEmail`, `forgot`, `recover`, `signInWithOtp`, `updateUser`, `magiclink` → **no matches.** The app has **no reset flow at all right now**, so turning confirmation off changes nothing about recovery *today*. But the moment you add "Forgot password?", it calls `supabase.auth.resetPasswordForEmail`, which needs a working email pipe. With confirmation off and no SMTP, a forgotten password = a permanently locked-out account. **This is the single strongest reason (b) is eventually required.**
- **Sybil / abuse — a real regression against our own threat model.** `docs/ops/RATE_LIMITING.md` §6 explicitly leans on the 2-emails/hr cap as an *accidental* brake: "you cannot confirm more than 2 new accounts per hour project-wide", and §3.3 states "must confirm email before first write needs **zero code** — just keep the setting on" (with confirmation ON, `signUp` returns `session === null`, so the caller holds the `anon` role and every `to authenticated` insert policy rejects it). **Turning confirmation OFF deletes both of those brakes:** account minting is now bounded only by the per-IP signup token bucket (~30 / 5 min per IP), and a brand-new account is `authenticated` and can write immediately. The compensating controls then become RATE_LIMITING.md's write-side rate-limit triggers (§2–3) — which must actually be shipped for the posture to hold. Flag this to the owner as an accepted, temporary regression.

Net: (a) is the right **immediate** move (it is the only thing achievable with no token and no domain), and an acceptable medium-term state for a low-stakes hobby directory — but it is explicitly a way-station to (b), not the destination.

### (b) Custom SMTP on a genuinely free tier — the survey

Verified against each provider's **own** pricing page (July 2026). Blog posts lie; these don't.

| Provider | Free allotment | Card required? | Permanent? | Notes |
|---|---|---|---|---|
| **Resend** ⭐ | **3,000/mo · 100/day** | No | **Yes** | Supabase's #1 recommended provider; trivial SMTP (`smtp.resend.com`, user `resend`, pass = API key). Must verify a domain to send to real users — `onboarding@resend.dev` only reaches *your own* address. [pricing](https://resend.com/pricing) |
| **Brevo** ⭐ | **300/day** (~9k/mo), 100k contacts | No | **Yes, free forever** | 3× Resend's daily headroom. Appends a "sent with Brevo" footer on free tier. [pricing](https://www.brevo.com/pricing/) · [limits](https://help.brevo.com/hc/en-us/articles/208580669) |
| **Mailjet** | 6,000/mo · 200/day | No | Yes | SMTP relay + API on free. [pricing](https://www.mailjet.com/pricing/) |
| **Mailgun** | 100/day (~3k/mo) | (not stated) | Yes (reinstated) | [pricing](https://www.mailgun.com/pricing/) |
| **MailerSend** | **500/mo** (reduced) | **Yes** (details to prevent abuse) | Yes | Smaller than it used to be; card wall. [pricing](https://www.mailersend.com/pricing) |
| **Amazon SES** | 3,000 msgs/mo | Yes (AWS acct) | ❌ **12 months only**, then ~$0.10/1k | Cheapest at scale but complex: sandbox mode, domain verification, IAM. [pricing](https://aws.amazon.com/ses/pricing/) |
| **Zoho ZeptoMail** | 10,000 email **credit** | Zoho acct | ❌ **Trial credit (1 month)**, then pay-as-you-go | Not a free tier. [pricing](https://www.zoho.com/zeptomail/pricing.html) |
| **Postmark** | 100/mo | No | Yes (dev plan) | Too small for signups + resets. [pricing](https://postmarkapp.com/pricing) |
| **SendGrid** | ❌ **none** | — | ❌ | **Killed its free tier May 27, 2025** — now a 60-day trial (100/day) then $19.95/mo. Do not choose. [changelog](https://www.twilio.com/en-us/changelog/sendgrid-free-plan) |

**Flagged removals/reductions:** SendGrid removed its free tier entirely (2025); Amazon SES free is 12-month only; ZeptoMail is trial credit only; MailerSend cut its free plan to 500/mo behind a card wall.

**Recommended relay: Resend**, with **Brevo** as runner-up. Resend is Supabase's own top recommendation, needs no credit card, injects no branding, and its SMTP config is the simplest of any provider. 100 emails/day comfortably covers a hobby app's signups *and* password resets. Choose **Brevo** instead if you expect launch-day spikes above 100 emails/day and can tolerate its free-tier email footer (300/day).

**Deliverability is not optional.** A transactional confirmation email from a no-name or `.invalid` sender lands in spam or is rejected outright. Realistically you need:
- a **custom domain** (~$10/yr — a one-time registrar cost, not a metered third-party API, so it stays within the spirit of the constraint),
- **SPF** (authorize the relay), **DKIM** (sign the mail — the relay gives you the DNS records), and **DMARC** (a `p=none` policy record to start).

Without a verified domain + these records, Gmail/Outlook will junk the confirmation link and you are no better off than the built-in sender.

### (c) Self-host a mail server — rejected, and here's the proper reason

Running your own Postfix/Exim box looks like the maximally self-sufficient answer. It is a trap:

- **Port 25 is blocked** outbound by nearly every residential ISP and most cloud/VPS providers (AWS, GCP, DigitalOcean, Oracle) by default. No port 25, no direct mail delivery.
- **Cold IP reputation.** A brand-new IP has no sending history; Gmail/Outlook greylist or junk it for weeks to months. A single home IP is often already on a consumer-dynamic-range blocklist (Spamhaus PBL).
- **PTR / rDNS, DMARC alignment, TLS, feedback loops** all have to be configured and *maintained* correctly, forever, or you silently start bouncing.
- **Ongoing operational cost** — patching, monitoring blocklists, handling bounces — for an app that sends a handful of confirmation emails a day.

The irony: a self-hosted box would deliver **worse** privacy and reliability than a free relay — your home/VPS IP and its geolocation get stamped into every `Received:` header, and downtime means signups silently break. This is strictly dominated by option (b). Reject.

### (d) Passwordless / OAuth — assessed briefly

- **Magic links / email OTP** still send email → same rate-limit problem, no escape.
- **OAuth (Google/GitHub)** removes password reset entirely and needs no SMTP, but each is a **third party** on the auth hot path and a **tracking vector** — squarely against the constraint — and it means rebuilding the whole `SignIn`/`SignUp` UI. Reasonable someday as an *addition*, not the fix for this problem.

---

## 3. Recommendation — staged

**Stage A — do this now (unblocks signup, zero third parties):**

```bash
export SUPABASE_ACCESS_TOKEN="sbp_...."          # from the dashboard tokens page
export SUPABASE_PROJECT_REF="riylggdmveqwglqilwhl"
scripts/configure-auth.sh show            # confirm current state
scripts/configure-auth.sh autoconfirm-on  # confirmation OFF -> signup returns a session
```

Signup works immediately. No app change is needed — see §6. Accept, temporarily, the abuse regression in §2(a)/§7 and make sure RATE_LIMITING.md's write-side rate limiters are shipped.

**Stage B — before you let strangers in (restores verification + recovery):**

1. Register a domain (~$10/yr).
2. Create a **Resend** account (no card), verify the domain, copy the API key and the DKIM/SPF DNS records into your registrar.
3. Point Supabase at it and raise the cap to 30/hr:
   ```bash
   export SMTP_HOST="smtp.resend.com" SMTP_PORT="587" SMTP_USER="resend"
   export SMTP_PASS="re_xxxxxxxx"                 # the Resend API key
   export SMTP_SENDER_EMAIL="no-reply@yourdomain.com" SMTP_SENDER_NAME="Watrloo"
   scripts/configure-auth.sh set-smtp
   ```
4. Turn confirmation back ON and verify a real email arrives:
   ```bash
   scripts/configure-auth.sh autoconfirm-off
   ```

Again, no app change is needed — `SignUp.tsx` already handles the confirmation-ON path too (§6).

---

## 4. Applying the fix — the two routes

### Route 1 — Dashboard (no token needed)

- **Turn confirmation off:** Authentication → **Sign In / Providers** → **Email** → toggle **"Confirm email" OFF** → Save.
- **Configure SMTP:** Authentication → **Emails** (SMTP Settings) → **Enable Custom SMTP** → fill host / port / username / password / sender email / sender name → Save. Then toggle **"Confirm email" back ON**.

### Route 2 — Script (`scripts/configure-auth.sh`, this repo)

Reads `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` (and `SMTP_*` for `set-smtp`) from the environment. Subcommands: `show`, `autoconfirm-on`, `autoconfirm-off`, `set-smtp`. It **never echoes secrets**, **confirms before every mutating call** (`AUTO_CONFIRM=1` to skip in CI), and **fails loudly with token instructions** when the PAT is absent — which is the state it will first be run in. Commands map directly onto the dashboard toggles above.

---

## 5. How to verify it worked

- **Confirmation OFF (Stage A):** the `show` output prints `mailer_autoconfirm  True` and the line "Email confirmation is OFF". Behaviorally, a signup **returns a session** and the app navigates straight to `/` — no "check your email" screen.
- **Confirmation ON + SMTP (Stage B):** `show` prints `external_email_enabled True`, your `smtp_host`, and `mailer_autoconfirm False`. Behaviorally, a real signup produces a confirmation email that **actually lands in the inbox** (check Gmail's "via" / SPF-DKIM headers show `PASS`), the link confirms the account, and only then does sign-in succeed.
- Do **not** test by spamming the live signup while the built-in sender is still active — it burns the 2/hr quota and creates junk users.

---

## 6. What changes in the app — nothing, and here's the proof

`SignUp.tsx` already handles **both** states correctly, so neither stage needs a code change.

- **`AuthProvider.signUp`** returns `{ needsEmailConfirmation: data.session === null }` (line 135).
- **Confirmation OFF** → `signUp` returns a **non-null session** → `needsEmailConfirmation === false` → `SignUp.onSubmit` runs `navigate('/', { replace: true })` (line 87). The "Check your email" branch (gated on `sentTo`) never renders. `onAuthStateChange` in `AuthProvider` also populates `session`, so the top guard `if (session && !sentTo) return <Navigate to="/" />` (line 42) sends them home regardless. The `handle_new_user` DB trigger mints the `profiles` row on the `auth.users` insert independent of confirmation, so the profile loads normally.
- **Confirmation ON** → `signUp` returns `session === null` → `needsEmailConfirmation === true` → `setSentTo(email)` shows the "Check your email" screen (lines 44–64). Also correct.

**Verdict: the existing code path already works for autoconfirm.** The `AuthProvider.signUp` comment ("When the project has email confirmation enabled Supabase returns no session") remains accurate; that branch is simply not taken when confirmation is off. The only thing the fix changes is *which* branch runs.

The one thing to line up alongside Stage A: ensure the write-side rate-limit triggers from `docs/ops/RATE_LIMITING.md` (§2–3) are actually deployed, since confirmation-off removes the email brake those triggers are meant to back up (§7).

---

## 7. Cross-doc consequence (read this before flipping the switch)

`docs/ops/RATE_LIMITING.md` treats "Confirm email = ON" as a **free, load-bearing abuse control** (§1 threat 1, §3.3, §6). Turning it OFF:

- removes the "≤2 new confirmed accounts/hour project-wide" Sybil ceiling, and
- makes a newly-registered account `authenticated` and write-capable **immediately** (no email round-trip to slow it down).

Mitigation while confirmation is off: rely on RATE_LIMITING.md's `check_rate_limit` triggers on `reviews`/`bathrooms` and the storage quota predicate, plus the per-IP signup token bucket Supabase enforces. Restoring confirmation (Stage B) is what re-establishes the full posture that doc assumes. If you keep confirmation off long-term, treat the §2–3 write-side limiters as **mandatory**, not optional.

---

## 8. Proposed one-line README correction (NOT applied)

The recommendation changes README's "Before you launch" section, which currently states confirmation "is on" and instructs wiring SMTP first. Proposed edit — replace the imperative sentence at the end of that paragraph:

> - "Configure a custom SMTP provider in *Authentication → Emails* before you let anyone sign up."
> + "Until you do, **turn email confirmation off so signup works without email** (`scripts/configure-auth.sh autoconfirm-on`); wire custom SMTP and turn it back on before a real launch. Full plan: [docs/ops/EMAIL.md](docs/ops/EMAIL.md)."

(Left for the owner / a docs change — this agent only writes `docs/ops/EMAIL.md` and `scripts/configure-auth.sh`.)

---

### Sources
- Send emails with custom SMTP (non-production quote, 30/hr, providers) — https://supabase.com/docs/guides/auth/auth-smtp
- Auth rate limits (2/hr built-in, project-wide, `rate_limit_email_sent`) — https://supabase.com/docs/guides/auth/rate-limits
- Management API — update auth config (`mailer_autoconfirm`, `smtp_*`) — https://supabase.com/docs/reference/api/v1-update-auth-service-config
- Management API — get auth config — https://supabase.com/docs/reference/api/v1-get-auth-service-config
- Personal access tokens — https://supabase.com/dashboard/account/tokens
- Resend pricing — https://resend.com/pricing
- Brevo pricing / free-plan limits — https://www.brevo.com/pricing/ , https://help.brevo.com/hc/en-us/articles/208580669
- Mailjet pricing — https://www.mailjet.com/pricing/
- Mailgun pricing — https://www.mailgun.com/pricing/
- MailerSend pricing — https://www.mailersend.com/pricing
- Amazon SES pricing — https://aws.amazon.com/ses/pricing/
- Zoho ZeptoMail pricing — https://www.zoho.com/zeptomail/pricing.html
- Postmark pricing — https://postmarkapp.com/pricing
- SendGrid free-plan retirement — https://www.twilio.com/en-us/changelog/sendgrid-free-plan
