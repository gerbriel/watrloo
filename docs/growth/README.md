# Watrloo Growth Platform — design index & rollout plan

**Author:** A14 Architecture & Rollout · **Date:** 2026-07-10

**Summary (3 lines).**
Watrloo is adding an opt-in, location-aware, ad-supported layer: featured in-app placements, geo-targeted email blasts, and a newsletter, funded by paid business tiers — built entirely on the stack we already run (Supabase + Resend + R2). This directory holds 14 design docs; `ARCHITECTURE.md` is the map that stitches them together and this file is the index + the order to build in. The order is chosen to **ship value early and defer legal/trust risk**, with one non-negotiable gate: **no marketing message is sent until consent, unsubscribe, and privacy policy v2 are live.**

**Dependencies.** This README indexes every `docs/growth/*.md` and depends on the phase boundaries in each. Start with `GROWTH_CONTRACT.md` (shared vocabulary and canonical data model) and `ARCHITECTURE.md` (system diagram, data flows, contracts). Everything here is **design only** — nothing is built or deployed; the current privacy policy stays live and true until Phase 4 ships.

---

## Index of documents

| Doc | Owner | One-line description |
|-----|-------|----------------------|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | A14 | System diagram, end-to-end data flows, cross-doc dependency graph, canonical component contracts, and the consolidated open decisions. **Read this second, after the contract.** |
| [`README.md`](./README.md) | A14 | This file — the index and the phased rollout plan with go/no-go gates. |
| [`COMPLIANCE.md`](./COMPLIANCE.md) | A1 | CAN-SPAM / GDPR / CPRA requirements, the consent model, GPC handling, unsubscribe rules, send-time re-check obligation. The legal spine everything sends through. |
| [`PRIVACY_POLICY_v2.md`](./PRIVACY_POLICY_v2.md) | A1 | Rewritten privacy policy for the ad-supported pivot. Marked **v2 / not yet in effect** until Phase 4. |
| [`DATA_MODEL.md`](./DATA_MODEL.md) | A2 | Authoritative schema: the canonical tables, columns, RLS policies, indexes, and `SECURITY DEFINER` RPC signatures. Everyone else references these names. |
| [`LOCATION.md`](./LOCATION.md) | A3 | Coarse IP→city/region capture (`ip-geo`), the chosen geo source, `user_locations`, retention, and `user_segments` definitions. |
| [`ANALYTICS.md`](./ANALYTICS.md) | A4 | First-party, in-Postgres analytics: `analytics_events`, `record_event()`, consent-aware attribution, no third-party analytics SaaS. |
| [`CAMPAIGNS.md`](./CAMPAIGNS.md) | A5 | Campaign lifecycle, `ad_campaigns`/`campaign_sends`, the pg_cron `campaign-scheduler`, eligibility query, enqueue→sender hand-off. |
| [`EMAIL_DELIVERY.md`](./EMAIL_DELIVERY.md) | A6 | The `email-send` sender with send-time re-check, Resend integration, `unsubscribe` + `resend-webhook`, `email_suppressions`, bounce/complaint handling. |
| [`INAPP_ADS.md`](./INAPP_ADS.md) | A7 | Featured placements: `featured_placements`, contextual selection (`active_featured_placements`), surfaces (map/browse/detail), per-slot frequency limits. |
| [`NEWSLETTER.md`](./NEWSLETTER.md) | A8 | Periodic newsletter: `newsletter_editions`/`newsletter_sends`, edition assembly, embedded sold featured slots — reuses the A6 send path. |
| [`PRICING.md`](./PRICING.md) | A9 | Tiers and packaging: `plans`/`plan_features`, entitlements (`plan_allows`), the ~$10 single-shop tier through chain/enterprise, Stripe design (deferred). |
| [`ADVERTISER_CONSOLE.md`](./ADVERTISER_CONSOLE.md) | A10 | Advertiser-facing UI: build campaigns, aggregate reach estimates (never user lists), buy featured slots, view aggregate results. |
| [`ADMIN_CRM.md`](./ADMIN_CRM.md) | A11 | Admin-only CRM: segment builder, campaign approvals, raw `user_locations` view — `is_admin()` RLS, never exposed to advertisers. |
| [`ABUSE_AND_LIMITS.md`](./ABUSE_AND_LIMITS.md) | A12 | Fairness and abuse controls: frequency caps, advertiser fairness across slots, fraud/click-abuse, server-side enforcement. |
| [`SCALING_COST.md`](./SCALING_COST.md) | A13 | Volume and cost model against Resend / Supabase / R2 free-tier and paid limits; where the platform first hits a wall and what it costs. |

Not in this directory but load-bearing: `GROWTH_CONTRACT.md` (the shared design contract — the source of the canonical data model and constraints), and the existing ops docs [`../ops/EMAIL.md`](../ops/EMAIL.md), [`../ops/RATE_LIMITING.md`](../ops/RATE_LIMITING.md), [`../ops/BUSINESS_ACCOUNTS.md`](../ops/BUSINESS_ACCOUNTS.md), [`../BASEMAP.md`](../BASEMAP.md).

---

## Phased rollout plan

**Ordering principle.** Ship user-invisible foundations and low-risk value first; put the highest-risk surface (marketing email) last, after every guardrail it needs is live. Each phase lists **what ships**, **what it depends on**, and a **go/no-go gate** — the condition that must be true to start the next phase.

Each phase is independently valuable and shippable. Phases 0–3 change nothing about what we *promise* users beyond an honest opt-in; Phase 4 is the first time a marketing message leaves the building, and it is gated hard.

### Phase 0 — Consent, policy v2, suppression (the floor)
*Must precede ANY marketing. Nothing user-visible ships marketing; this is the legal + data floor.*

- **Ships:**
  - `user_consents` table + RLS + `set_consent()` and the `has_marketing_consent()` / `has_location_consent()` read helpers (A1, A2).
  - `email_suppressions` table + `unsubscribe` Edge Function (one-click, RFC 8058) + the global per-user kill-switch (A6, A1).
  - Consent gate UI in `/profile`: explicit, default-off toggles for location and marketing; GPC detection recorded to `user_consents.gpc_detected` (A1).
  - **Privacy Policy v2 authored and staged** (A1) — held as "v2 / not yet in effect" until Phase 4's go-live flips it.
- **Depends on:** the existing auth/profile system only. This is greenfield tables + RLS in the house style.
- **Go/no-go gate to leave Phase 0:** `set_consent` writes and reads correctly; a suppression + unsubscribe round-trips end to end; consent is **off by default** and absence of a row reads as no-consent everywhere. **If any of these is false, no later phase may send or track.**

### Phase 1 — First-party analytics + admin CRM (read-only)
*Value with near-zero consent risk: understand usage, stand up the admin surface.*

- **Ships:**
  - `analytics_events` + `record_event()`; instrument existing surfaces (browse/map/detail), consent-aware attribution — anonymous+session when not opted in (A4).
  - Admin CRM shell, **read-only**: dashboards over first-party analytics and existing business data, behind `is_admin()` RLS (A11).
- **Depends on:** Phase 0 (consent helpers, so events attach a `user_id` only when permitted).
- **Go/no-go gate:** events never carry PII in `props`; anonymous users are never silently identified; admin views are `is_admin()`-gated and invisible to advertisers.

### Phase 2 — Coarse location + segments
*Turns on the location half of consent. Still no outbound messages.*

- **Ships:**
  - `ip-geo` Edge Function (chosen source per Decision **D4**, leaning MaxMind GeoLite2), writing `user_locations` — **only** when `has_location_consent` is true (A3).
  - `user_segments` (+ optional `segment_members`) and the admin segment builder in the CRM (A3, A11).
  - `location-retention-reaper` pg_cron job trimming `user_locations` to the retention window (Decision **D5**) (A3).
- **Depends on:** Phase 0 (location consent) and Phase 1 (CRM shell to view/segment).
- **Go/no-go gate:** capture is gated on consent and re-checked server-side; raw IP is never persisted; `user_locations` is `is_admin()`-only by RLS; retention reaper runs; the retention window is written into Privacy Policy v2. **This is the "sensitive personal information" tripwire — if location can be captured without consent, or is finer than city/region, stop.**

### Phase 3 — Featured in-app placements + pricing/entitlements
*First revenue surface. Lowest consent risk because it's contextual — it needs no personal data.*

- **Ships:**
  - `featured_placements` + `active_featured_placements()` contextual selection; render slots on map/browse/detail; per-slot per-week frequency limit (A7, A12).
  - `plans` / `plan_features` + `plan_allows()` entitlements; wire the paywall for featured slots (A9). Pricing numbers per Decision **D2**.
  - Advertiser console: buy/schedule featured slots, see **aggregate** impression/click counts (A10).
  - Billing stays **manual** (admin sets `subscriptions.status`, reusing the existing approval RPC) — Stripe deferred to Phase 5.
- **Depends on:** Phase 1 (analytics for impression/click), Phase 2 (optional region match), Phase 0 (nothing here messages users, but entitlements ride the consent-era plumbing).
- **Go/no-go gate:** featured selection runs with **zero personal data** when region is null; entitlements enforced server-side (RPC boundary, not just UI); advertisers see counts, never users. Revenue can now flow with no marketing-send risk taken.

### Phase 4 — Email blasts + newsletter (highest risk — needs everything before it)
*The first time a marketing message leaves the system. Do not start until the gate below is green.*

- **Ships:**
  - `ad_campaigns` + `campaign_sends`; `campaign-scheduler` (pg_cron) enqueue; `campaign_eligible_recipients()` first-pass eligibility (A5).
  - `email-send` Edge Function with the **send-time re-check** `can_send_to()`, Resend dispatch from `watrloo.com`, `List-Unsubscribe` headers, and the CAN-SPAM footer incl. the physical address (Decision **D1**) (A6).
  - `resend-webhook` for delivered/open/click and bounce/complaint → `email_suppressions` (A6).
  - `newsletter_editions`/`newsletter_sends` reusing the same send path (A8).
  - Campaign approval flow in the admin CRM (A11); campaign builder + aggregate reach estimate in the advertiser console (A10).
  - **Privacy Policy v2 goes into effect** (flip from "not yet in effect") the moment the first send is enabled.
- **Depends on:** Phases 0–3 in full — consent, suppression, unsubscribe, policy v2, entitlements, segments, and the console/CRM.
- **Go/no-go gate (the hard one — ALL must be true):**
  1. **Consent + unsubscribe + policy v2 are live** (Phase 0 shipped and verified).
  2. A **physical postal address** is chosen and rendered in every email footer (Decision **D1** resolved).
  3. The **send-time re-check** is proven: a user who unsubscribes or flips consent *after* enqueue is *not* sent to — tested end to end.
  4. **Frequency cap (3/7d default)** enforced against actual `sent` rows; one-click unsubscribe honored on the next send.
  5. Bounce/complaint auto-suppression works; Resend domain auth (SPF/DKIM/DMARC on `watrloo.com`) verified.
  6. EU handling decided (Decision **D6**) — double opt-in or geo-gating in place.
  > **No marketing send until 1–6 are green. This gate is the whole reason for the phase order.**

### Phase 5 — Stripe self-serve billing
*Deferred by design. Manual billing carries Phases 0–4.*

- **Ships:** Stripe Checkout/Portal wired to `subscriptions` (schema already carries `stripe_customer_id`/`stripe_subscription_id`); self-serve upgrade/downgrade; entitlement sync (A9).
- **Depends on:** Phase 3 (plans/entitlements exist) and owner's timing (Decision **D3**).
- **Go/no-go gate:** entitlements stay authoritative in Postgres (Stripe is the payment rail, not the source of truth for what a plan allows); a failed/lapsed payment downgrades entitlements via the existing `plan_allows` check; no plan grants a feature the DB doesn't independently enforce.

**Rollout at a glance:**

```
P0 consent+policy+suppression ──► P1 analytics+CRM ──► P2 location+segments ──► P3 featured+pricing ──► P4 email+newsletter ──► P5 Stripe
   (legal floor, no sends)         (low risk value)     (opt-in location)       (first revenue,          (first marketing send,    (self-serve
                                                                                 contextual, low risk)    HARD GATE)                billing)
        │                                                                                                       ▲
        └──────────────────── consent, unsubscribe, policy v2 must be live before ANY send ───────────────────┘
```

---

## Biggest risks (blunt)

**Legal — the one that can actually hurt.**
Sending marketing without the full consent/unsubscribe/address machinery is the highest-consequence mistake here. CAN-SPAM penalties are per-email; GDPR/ePrivacy exposure for messaging or tracking EU users without prior opt-in is real; CPRA treats precise location as "sensitive personal information" — which is exactly why the contract limits us to **coarse city/region, IP-derived, opt-in only.** The mitigations are structural, not procedural: consent is a server-side boundary (not a UI checkbox), there is exactly **one send path** with a **mandatory send-time re-check**, and marketing is physically impossible before Phase 0 ships. The residual open items are Decisions **D1** (postal address — there is no lawful send without it) and **D6** (EU handling).

**Cost — low in absolute terms, with sharp free-tier edges.**
The design deliberately avoids ad networks and analytics SaaS, so recurring cost is near zero. But free tiers have cliffs: Resend free is **3,000/mo · 100/day** (per `../ops/EMAIL.md`) — a single region-wide blast can blow the daily cap, so the sender must **rate-limit and batch** (A6/A13). Supabase Postgres/Edge/pg_cron are resource-bound, not plan-gated; `analytics_events` and `user_locations` are the tables that grow — retention reaping (Phase 2) and event hygiene (A4) keep them bounded. R2 creative storage is trivial (free egress). A13 owns the real numbers and the first wall.

**Trust / UX — the quiet killer for a privacy-first app.**
Watrloo's whole prior identity was "privacy-first bathroom directory." Pivoting to ad-supported without eroding trust means: **everything off by default**, opt-in that is honest and reversible in one click, a frequency cap that means users get *at most a few* messages a week, contextual (not creepy) in-app ads, and a rewritten privacy policy that plainly says what changed. Over-messaging, a broken unsubscribe, or ads that feel like surveillance would cost more users than the ad revenue is worth. The frequency cap (3/7d), the contextual-first ad surface (Phase 3 before Phase 4), and the coarse-location constraint are all trust decisions as much as technical ones.

## The three things to get right first

1. **Consent as a server-enforced boundary (Phase 0).** `user_consents` + `set_consent()` + server-side re-checks in every producer, off by default, absence = no consent. If this is shaky, nothing above it is safe. This is the single most important deliverable.
2. **One send path with an unavoidable send-time re-check (Phase 4 core, designed in Phase 0's suppression + A6).** Enqueue and send are separate so the re-check (`can_send_to`) is structural, not a code path someone can skip. Campaigns and newsletter share it. Get this and CAN-SPAM/GDPR compliance is enforced by construction, not by remembering.
3. **Coarse-location discipline (Phase 2).** City/region only, IP-derived, opt-in, retention-limited, admin-only by RLS. This is the line that keeps Watrloo out of "sensitive personal information" territory and keeps faith with the app's privacy-first origin. No device GPS, ever.
```
