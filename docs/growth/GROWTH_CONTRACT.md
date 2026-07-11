# Watrloo Growth Platform — shared design contract

14 agents are designing this **in parallel**. Read this whole file first. It pins
the shared vocabulary, the canonical data model, the constraints, and who owns
what — so nobody diverges or double-works.

Repo: `/Users/gabrielrios/Desktop/WebDevProjects/watrloo`

## What we're building

Watrloo is pivoting from a privacy-first bathroom directory to an **ad-supported,
location-aware platform**. Businesses (already a feature) can pay to reach the
app's users: featured placements in-app, geo-targeted promotional email blasts,
and features in a newsletter. A CRM-style backend logs coarse user location and
lets admins segment users. Consumers keep using the app free.

**The owner's three binding decisions (do NOT relitigate):**
1. **Ad-supported pivot** — yes, build it. The privacy policy will be rewritten
   to match (that's a deliverable, not a blocker).
2. **Opt-in consent** — users must explicitly agree to location use AND marketing
   before we track or message them. Nothing is on by default.
3. **Coarse location only** — approximate city/region derived from IP at sign-in.
   **No device GPS. No precise real-time location.** This keeps us out of
   "sensitive personal information" (CPRA) territory. "Radius/near me" targeting
   operates at city/region granularity, not street-level.

## Hard constraints

- **Self-sufficiency still holds.** Prefer what we already run: **Supabase**
  (Postgres + Auth + Storage + Edge Functions + pg_cron), **Resend** (email, domain
  `watrloo.com` verified), **Cloudflare R2** (static assets). Avoid third-party ad
  networks and analytics SaaS. **Analytics is first-party, in Postgres.** IP→geo
  must use a free/self-hostable source (e.g. MaxMind GeoLite2, or Cloudflare's
  `CF-IPCountry`/edge geo headers) — name what you pick and why. Any third party
  must be free and justified.
- **Consent-first & lawful.** Marketing email must be CAN-SPAM compliant
  (identifiable sender, physical address or equivalent, one-click unsubscribe,
  honored promptly). EU users: no marketing/location without prior opt-in
  (GDPR/ePrivacy). California: honor Global Privacy Control + a "sharing" opt-out.
  Consent + suppression are checked **at send time**, not just at signup.
- **Admin-only CRM.** Raw user locations and the CRM are visible ONLY to admins,
  enforced by RLS (`is_admin()`), never to advertisers. Advertisers see aggregate
  reach counts, never individual users or locations.
- **Frequency cap.** A user receives **at most a few promotional messages per
  week** — pin a default of **3 per 7 days per user**, configurable. Featured
  placements are time-boxed and limited to **a few activations per week** per
  advertiser slot. Enforced server-side.
- **Build ON the existing system.** Do not reinvent auth, businesses, roles, or
  moderation. Extend them.

## Existing system you extend (already built & live)

- React 19 + Vite + TS, Tailwind v4, deployed to GitHub Pages at
  `https://gerbriel.github.io/watrloo/` via Actions on push to `main`.
- Supabase (project ref `ezaibwhtlaqnpegcdlqc`), PostGIS + pg_trgm installed,
  pg_cron/pg_net available, Edge Functions supported (one deployed:
  `notify-access-request`). Resend SMTP wired; branded transactional email.
- Schema highlights: `profiles`, `bathrooms` (+PostGIS `geog`, soft-delete),
  `reviews` (soft-delete), `review_photos`, `bathroom_stats` view; roles
  (`user_roles`, `is_admin()`/`is_moderator()`), `reports`, `moderation_actions`
  (has `detail jsonb`); **business tier**: `businesses`, `business_members`,
  `subscriptions` (plan/status), `bathroom_claims` (verified claim = a business
  controls a listing), `business_access_requests`, `review_responses`. Business
  scope flows claim → business → member; a business controls listing FACTS and
  responds to reviews but CANNOT edit/delete reviews (that's moderators).
- Auth: email/password, confirmation on, session in localStorage,
  `emailRedirectTo` → `/browse`. `useAuth()` exposes session/profile/roles.
- Money is currently **manual** (admin approves a business, arranges payment out
  of band). Stripe is a future phase — design for it but don't assume it exists.

## CANONICAL data model — everyone aligns to these names

The DATA MODEL agent owns the authoritative schema. Everyone else REFERENCES
these table/column names; if you need a field that isn't here, note it as "for
DATA MODEL to add" rather than inventing a parallel table.

- `user_consents` — one row per user: `user_id pk`, `marketing_opt_in bool`,
  `location_opt_in bool`, `gpc_detected bool`, `consent_updated_at`,
  `source` (how consent was captured). Absence = no consent.
- `user_locations` — coarse location log: `id`, `user_id`, `captured_at`,
  `ip_city`, `ip_region`, `ip_country`, `geog geography(Point)` (city centroid),
  `source`. **Admin-only RLS.** Retention-limited.
- `user_segments` — saved segment definitions (name, predicate: region/consent/
  activity); `segment_members` optional materialization.
- `ad_campaigns` — `id`, `business_id`, `type` ('email_blast' | 'featured'),
  `status` ('draft'|'pending_review'|'approved'|'running'|'paused'|'done'|'rejected'),
  target (`target_region` / `target_geog` + `radius_km` at city granularity /
  `segment_id`), `starts_at`, `ends_at`, `frequency_per_week`, `creative`
  (subject/body/image/link), `created_by`, timestamps.
- `campaign_sends` — per-recipient log: `campaign_id`, `user_id`, `sent_at`,
  `channel`, `status`, `unsubscribe_token`. Powers frequency cap + suppression +
  audit + advertiser reach counts (aggregate only).
- `featured_placements` — a time-boxed featured slot: `bathroom_id`/`business_id`,
  `surface` ('map'|'browse'|'detail'), `region`, `starts_at`, `ends_at`,
  `campaign_id`. Frequency-limited per week.
- `email_suppressions` — unsubscribed / bounced / complained addresses; checked
  at send time; global kill-switch per user.
- `newsletter_editions` + `newsletter_sends` — periodic newsletter; may embed
  `featured_placements` slots sold to advertisers.
- `analytics_events` — first-party events: `id`, `user_id` (nullable/anon),
  `session_id`, `event`, `props jsonb`, `occurred_at`, coarse `region`. No PII in
  props; respects consent.
- `plans` — pricing tiers (see PRICING agent) + `plan_features`/entitlements the
  code checks (e.g. `max_locations`, `blasts_per_month`, `featured_per_week`).

Conventions to match the existing codebase: snake_case SQL; RLS on every table;
mutations through `SECURITY DEFINER` RPCs that re-check role/consent and write to
`moderation_actions` or an audit table; `set search_path = ''` in functions;
`(select auth.uid())` / `(select public.is_admin())` initplan form in policies.

## Pricing anchors (PRICING agent refines; others assume these exist)

- **Small business, single location — ~$10/month.** Gets most features:
  claim + manage its listing, respond to reviews, a modest monthly email-blast
  and featured-placement allowance, basic analytics. The ONE thing it does NOT
  get: **multiple locations**.
- **Multi-location / chains — higher tiers**, more robust: many locations, bulk
  CSV import (exists), higher blast/featured allowances, team seats, deeper
  analytics, maybe API. Design **a few tiers** between "single $10 shop" and
  "national chain" (e.g. small / growth / chain / enterprise). Keep small owners
  feeling first-class — the differentiator is scale (locations, volume, seats),
  not withholding core features.

## File ownership — write ONLY your file(s), under `docs/growth/`

Do NOT edit `src/**`, `supabase/**`, `package.json`, or any existing doc. Do NOT
apply DB changes, run migrations, or deploy. Produce a design doc with
implementation-ready detail (schema SQL, RLS, RPC signatures, component specs,
code sketches) that the orchestrator will implement later.

| Agent | Owns |
| --- | --- |
| A1 Compliance & Privacy | `docs/growth/COMPLIANCE.md`, `docs/growth/PRIVACY_POLICY_v2.md` |
| A2 Data model & RLS | `docs/growth/DATA_MODEL.md` |
| A3 Location & segmentation | `docs/growth/LOCATION.md` |
| A4 First-party analytics | `docs/growth/ANALYTICS.md` |
| A5 Campaigns & scheduling | `docs/growth/CAMPAIGNS.md` |
| A6 Email blast delivery | `docs/growth/EMAIL_DELIVERY.md` |
| A7 In-app ad placements | `docs/growth/INAPP_ADS.md` |
| A8 Newsletter | `docs/growth/NEWSLETTER.md` |
| A9 Pricing & packaging | `docs/growth/PRICING.md` |
| A10 Advertiser console | `docs/growth/ADVERTISER_CONSOLE.md` |
| A11 Admin CRM console | `docs/growth/ADMIN_CRM.md` |
| A12 Abuse, fairness, limits | `docs/growth/ABUSE_AND_LIMITS.md` |
| A13 Scaling & cost | `docs/growth/SCALING_COST.md` |
| A14 Architecture & rollout | `docs/growth/ARCHITECTURE.md`, `docs/growth/README.md` |

## Alignment rules (this is how we avoid double work)

- The **canonical data model above is law.** A2 details it; everyone else uses
  those names. If you need a new table/column, write "REQUEST TO A2: …" in your
  doc; don't create a parallel design.
- Stay in your lane. If your topic touches another's (it will), write the
  interface/assumption and defer the depth to them, e.g. "consent is checked at
  send time per A1's model; see COMPLIANCE.md."
- A14 is the integrator's reference — assume it stitches everything; give it clean
  seams.
- Every doc starts with a 3-line **summary** and a **dependencies** line (which
  other docs yours relies on).
- Cite real facts (Resend/Supabase/Cloudflare limits, CAN-SPAM/GDPR/CPRA
  specifics) with sources where it affects a decision; don't invent numbers.

## Hard rules (every agent)

- Write ONLY your owned file(s) under `docs/growth/`. Create the dir if needed.
- NEVER run: `git`, `npm install`, any `supabase` CLI command, `psql`, deploy.
- You may read the repo and use WebSearch/WebFetch. Scratch files go in the
  scratchpad dir only.
- This is a DESIGN. No live app or DB changes. The current privacy policy stays
  live and true until implementation ships — your policy rewrite is for THAT
  moment, clearly marked "v2 / not yet in effect."
