# Growth Platform — Architecture & Seams

**Author:** A14 Architecture & Rollout · **Date:** 2026-07-10

**Summary (3 lines).**
The growth platform layers onto the existing Watrloo stack without new infrastructure: React client → Supabase (Postgres + RLS + `SECURITY DEFINER` RPCs + pg_cron + Edge Functions) → Resend (email) / Cloudflare R2 (creative). Two invariants are load-bearing and modeled as first-class components: a **consent gate** at capture time and a **send-time re-check** immediately before every message leaves. This doc is the map that stitches the other 13 designs together — it owns the seams and the contracts, not the depth.

**Dependencies.** This doc integrates all of: `COMPLIANCE.md` (A1), `DATA_MODEL.md` (A2), `LOCATION.md` (A3), `ANALYTICS.md` (A4), `CAMPAIGNS.md` (A5), `EMAIL_DELIVERY.md` (A6), `INAPP_ADS.md` (A7), `NEWSLETTER.md` (A8), `PRICING.md` (A9), `ADVERTISER_CONSOLE.md` (A10), `ADMIN_CRM.md` (A11), `ABUSE_AND_LIMITS.md` (A12), `SCALING_COST.md` (A13). Table/column names are the canonical set in `GROWTH_CONTRACT.md`; A2 is authoritative for schema. Where this doc names a component contract, the owning agent's doc is authoritative for its internals — cited inline.

> **Design only.** Nothing here runs. The current privacy policy stays live and true until implementation ships. Component names coined here (`campaign-scheduler`, `email-send`, `ip-geo`, etc.) are proposals for the orchestrator to reconcile against each owner's doc.

---

## 1. System diagram

The growth platform reuses every tier the app already runs. New surfaces are marked `[+]`; everything else exists today (`notify-access-request` Edge Function, Resend SMTP, R2 basemap, PostGIS, pg_cron/pg_net).

```
                          CLIENT  (React 19 + Vite, GitHub Pages)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  Consumer app            Advertiser console [+]        Admin CRM [+]        │
  │  /browse /map /detail    /business/campaigns           /admin/crm          │
  │  /profile (consent)      (build campaign, reach est.)  (segments, review,  │
  │      │                        │                         raw locations)     │
  │      │                        │                              │             │
  │  ┌───▼─────────────┐   in-app featured slots [+]             │             │
  │  │ CONSENT GATE [+]│   rendered from active_featured_        │             │
  │  │ (capture-time)  │   placements() — contextual, no PII     │             │
  │  │ profile UI +    │                                         │             │
  │  │ GPC detect      │                                         │             │
  │  └───┬─────────────┘                                         │             │
  └──────┼──────────────────────┼──────────────────────────────┼─────────────┘
         │ supabase-js (anon key, RLS-scoped)   │ supabase-js (admin, is_admin RLS)
         ▼                       ▼                              ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                 SUPABASE  (project ezaibwhtlaqnpegcdlqc)                    │
  │                                                                             │
  │  POSTGRES + RLS                          RPCs (SECURITY DEFINER)            │
  │  ┌──────────────────────────────┐        ┌──────────────────────────────┐  │
  │  │ user_consents  user_locations│        │ set_consent()                │  │
  │  │ user_segments  segment_members│       │ campaign_eligible_recipients()│ │
  │  │ ad_campaigns   campaign_sends │◄──────►│ can_send_to()  [send-time]   │  │
  │  │ featured_placements           │        │ active_featured_placements() │  │
  │  │ email_suppressions            │        │ admin_review_campaign()      │  │
  │  │ newsletter_editions/_sends    │        │ record_event()               │  │
  │  │ analytics_events   plans      │        │ (all re-check role/consent,  │  │
  │  │ rate_limits (existing)        │        │  write moderation_actions)   │  │
  │  └──────────────────────────────┘        └──────────────────────────────┘  │
  │                    ▲                                    ▲                   │
  │                    │                                    │                   │
  │  pg_cron SCHEDULER │        pg_net (HTTP + Vault secrets)│                   │
  │  ┌─────────────────┴───────────┐                        │                   │
  │  │ campaign-scheduler (*/5 min) │──enqueue campaign_sends (status=queued)   │
  │  │ newsletter-scheduler (cron)  │──build edition                            │
  │  │ location-retention-reaper    │──trim user_locations                      │
  │  │ suppression/cap housekeeping │                                           │
  │  └──────────────┬───────────────┘                                          │
  │                 │ net.http_post(url, Bearer = Vault service key)            │
  │                 ▼                                                           │
  │  EDGE FUNCTIONS (Deno) [+]                                                  │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
  │  │ ip-geo       │  │ email-send   │  │ unsubscribe  │  │ resend-webhook │  │
  │  │ (sign-in →   │  │ SEND-TIME    │  │ one-click,   │  │ delivered/open/│  │
  │  │  coarse geo, │  │ RE-CHECK ▶   │  │ RFC 8058     │  │ click/bounce/  │  │
  │  │  writes      │  │ can_send_to()│  │ writes       │  │ complaint →    │  │
  │  │  user_       │  │ then Resend  │  │ email_       │  │ campaign_sends │  │
  │  │  locations)  │  │              │  │ suppressions │  │ + suppressions │  │
  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
  └─────────┼─────────────────┼─────────────────┼──────────────────┼──────────┘
            │                 │                 │                  │
            ▼                 ▼                 ▲                  ▲
   ┌─────────────────┐  ┌──────────┐      one-click link      Resend webhook
   │ IP-geo source   │  │  RESEND  │      in every email      (events POST)
   │ [DECISION: A3]  │  │ watrloo. │
   │ MaxMind GeoLite2│  │ com veri-│      ┌──────────────────────────────────┐
   │ or edge headers │  │ fied SMTP│      │ CLOUDFLARE R2 (creative + basemap)│
   └─────────────────┘  └────┬─────┘      │ campaign images, newsletter assets│
                             ▼            └──────────────────────────────────┘
                        recipients' inboxes
```

**The two first-class guardrails, called out because everything legal hinges on them:**

- **Consent gate (capture-time).** No `user_locations`, `analytics_events` with a `user_id`, or marketing send exists for a user without a matching `user_consents` row saying so. Absence of a row = no consent (per A1/A2). The gate lives in the client `/profile` surface **and** is re-asserted server-side inside every RPC/Edge Function that touches PII — the client toggle is UX, the RPC check is the boundary.
- **Send-time re-check.** The `campaign-scheduler` computing eligibility is a *first pass*. State can change between enqueue and send (user unsubscribes, hits cap, GPC flips). `email-send` therefore calls `can_send_to(user_id, campaign_id)` in the same transaction that marks the send, immediately before handing the message to Resend. A message is never sent on stale eligibility. This is A1 + A6's hard requirement and the reason enqueue and send are separate components.

---

## 2. End-to-end data flows

Each step names the **component that owns it** and the **doc that specifies it**. Component names are A14 proposals; the cited doc is authoritative.

### Flow 1 — Sign-in → coarse location captured (only if opted in)

```
user signs in ──► client detects session (existing useAuth)
   │
   ├─ (a) client reads user_consents. If location_opt_in is false/absent → STOP. No capture.
   │        Owner: Consent Gate (client)                         Spec: COMPLIANCE.md (A1)
   │
   └─ (b) if location_opt_in = true → client invokes Edge Function `ip-geo`
            Owner: ip-geo Edge Function                          Spec: LOCATION.md (A3)
              • reads the request IP (Edge sees it; the SPA on Pages does not)
              • resolves IP → { city, region, country, centroid point }  [coarse only]
              • re-checks location_opt_in server-side before writing
              • inserts user_locations (admin-only RLS, retention-limited)
              • NEVER stores the raw IP beyond the resolve; NEVER street-level
```

Notes: capture is throttled (at most once per session / per N hours — A3 sets the cadence) so it isn't a per-request geo lookup. GPC/opt-out state (`user_consents.gpc_detected`) is honored here too: a California "do not share" flag still allows the user to *use* the app but suppresses location logging used for targeting (A1 decides the exact semantics).

### Flow 2 — Advertiser builds campaign → approval → schedule → **send-time re-check** → Resend → engagement

```
1. Advertiser builds campaign in the console
   inserts ad_campaigns (status='draft' → 'pending_review'), creative, target
   (target_region / target_geog+radius_km at CITY granularity / segment_id)
   Owner: Advertiser Console (client)          Spec: ADVERTISER_CONSOLE.md (A10)
   Guard: PRICING entitlements — plan allows this blast? within blasts_per_month?
          Owner: entitlement check RPC          Spec: PRICING.md (A9)
   Reach estimate shown is AGGREGATE ONLY (a count), never a user list.  (A11 rule)
        │
2. Admin reviews & approves
   admin_review_campaign(campaign_id, approve|reject) → status='approved'
   writes moderation_actions (audit)
   Owner: Admin CRM (client) + RPC             Spec: ADMIN_CRM.md (A11), CAMPAIGNS.md (A5)
        │
3. Scheduler enqueues (pg_cron `campaign-scheduler`, every ~5 min)
   for each campaign where status='approved'/'running' and now() in [starts_at, ends_at]:
     rows := campaign_eligible_recipients(campaign_id)   -- FIRST-PASS eligibility
     insert campaign_sends (campaign_id, user_id, status='queued', unsubscribe_token)
       on conflict do nothing   -- idempotent; frequency cap applied in the query
     net.http_post(email-send, batch)   -- hand off via pg_net + Vault service key
   Owner: campaign-scheduler (pg_cron)         Spec: CAMPAIGNS.md (A5)
        │
4. Sender dispatches with SEND-TIME RE-CHECK (Edge Function `email-send`)
   for each queued send, IN ONE TX right before the API call:
     if not can_send_to(user_id, campaign_id):     -- re-check consent+suppress+cap
         mark campaign_sends.status='skipped'; continue
     POST Resend /emails  (from watrloo.com, List-Unsubscribe headers, footer w/ address)
     mark campaign_sends.status='sent', sent_at=now()
   Owner: email-send Edge Function             Spec: EMAIL_DELIVERY.md (A6)
        │
5. Engagement events flow back
   Resend → `resend-webhook` Edge Function:
     delivered / opened / clicked  → update campaign_sends.status + record_event()
     bounced / complained          → update status AND insert email_suppressions (kill-switch)
   Owner: resend-webhook Edge Function         Spec: EMAIL_DELIVERY.md (A6), ANALYTICS.md (A4)
   Unsubscribe (any time): one-click link → `unsubscribe` Edge Function →
     insert email_suppressions, set marketing_opt_in=false. Honored on the NEXT send-time re-check.
   Owner: unsubscribe Edge Function            Spec: EMAIL_DELIVERY.md (A6), COMPLIANCE.md (A1)
        │
6. Advertiser sees results — AGGREGATE reach/open/click counts only, from campaign_sends.
   Never individual recipients or locations.   Spec: ADVERTISER_CONSOLE.md (A10), ADMIN_CRM.md (A11)
```

### Flow 3 — Featured placement selection (in-app, lowest consent risk)

```
user opens /map or /browse or a /detail page
   │
   client calls active_featured_placements(surface, region?)
     • returns time-boxed featured_placements where now() in [starts_at, ends_at],
       matching surface ('map'|'browse'|'detail') and — if the user opted into location —
       their coarse region; otherwise region-agnostic/national slots only.
     • CONTEXTUAL: selection can run with NO personal data at all (region is optional).
       This is why it's the lowest-consent-risk surface.
     • frequency-limited per advertiser slot per week (server-side).
   Owner: active_featured_placements() RPC + client renderer   Spec: INAPP_ADS.md (A7)
   Impression/click logged via record_event() → analytics_events (respects consent). (A4)
```

### Flow 4 — Newsletter edition

```
editor assembles a newsletter_editions row (curated content + sold featured_placements slots)
   │
   pg_cron `newsletter-scheduler` (or admin "send now"):
     recipients := eligible newsletter subscribers (marketing_opt_in, not suppressed)
     insert newsletter_sends (edition_id, user_id, status='queued', unsubscribe_token)
     hand off to `email-send` — SAME sender, SAME send-time re-check, SAME suppression path
   Owner: newsletter-scheduler + email-send      Spec: NEWSLETTER.md (A8), EMAIL_DELIVERY.md (A6)
```

**Deliberate reuse:** the newsletter does not get its own delivery pipe. It shares `email-send`, `can_send_to()`, `email_suppressions`, `unsubscribe`, and `resend-webhook` with campaigns. Only the audience selection and content assembly differ (A8). One send path = one place to enforce consent, one place to get CAN-SPAM right.

---

## 3. Cross-doc dependency graph

Arrows read "depends on / builds on". The two foundations (A1 consent model, A2 schema) sit under everything; A14 sits over everything.

```
                         ┌──────────────────────────────────────┐
                         │   A1 COMPLIANCE   +   A2 DATA_MODEL   │  ← foundation; everyone
                         └───────────────┬──────────────────────┘     references these names
        ┌───────────────┬───────────────┼───────────────┬───────────────┬─────────────┐
        ▼               ▼               ▼               ▼               ▼             ▼
   A3 LOCATION     A4 ANALYTICS    A9 PRICING      A12 ABUSE        (RLS,        (audit,
   (user_          (analytics_     (plans,         (frequency       is_admin)    moderation_
    locations,      events,         plan_features,  caps, fairness,               actions)
    segments)       consent-aware)  entitlements)   fraud)
        │               │               │               │
        ├───────────────┴───────┐       │               │
        ▼                       ▼       │               │
   A5 CAMPAIGNS ◄───────────────────────┴───────────────┤   (caps + entitlements gate
   (ad_campaigns, campaign_sends,                        │    campaign creation & sending)
    scheduler, eligibility)                              │
        │        │                                       │
        ▼        ▼                                       │
   A6 EMAIL   A7 INAPP_ADS                               │
   DELIVERY   (featured_placements,                      │
   (sender,    contextual selection)                     │
    webhook,        │                                    │
    unsub)          ▼                                    │
        │        (featured slots embedded)               │
        ▼        │                                       │
   A8 NEWSLETTER ◄┘                                      │
   (editions, reuses A6 sender)                          │
                                                         │
   A10 ADVERTISER_CONSOLE ── depends on A5, A7, A9, A4 ──┘  (builds campaigns, shows aggregate reach)
   A11 ADMIN_CRM         ── depends on A3, A5, A1        (segments, approvals, raw locations, admin-only)
   A13 SCALING_COST      ── depends on ALL              (volumes, Resend/Supabase/R2 limits & $)
   A14 ARCHITECTURE/README ── integrates ALL            (this doc + rollout order)
```

**Critical-path reading.** Nothing in A5–A8 (any send) is buildable or shippable before A1 (consent + unsubscribe model) and A2 (tables + RLS) are settled. A10/A11 consoles are buildable against A5's contracts once those exist. A13 costs everything; it can start early with A5/A6 volume assumptions.

---

## 4. Canonical contracts between components

Clean interfaces so each owner implements independently. Signatures are proposals; the owning doc refines types. All RPCs follow the existing house style: `SECURITY DEFINER`, `set search_path = ''`, `(select auth.uid())` / `(select public.is_admin())` initplan form, RLS on every table, mutations logged to `moderation_actions` or an audit table.

### 4.1 Consent gate → everything

```sql
-- Owner: A1/A2. The one write path for consent; also the GPC recorder.
set_consent(p_marketing boolean, p_location boolean, p_gpc boolean, p_source text)
  returns user_consents      -- upserts the caller's row; consent_updated_at = now()

-- Read helpers every producer calls (SECURITY DEFINER, re-checked server-side):
has_marketing_consent(p_user_id uuid) returns boolean   -- marketing_opt_in AND not GPC-suppressed
has_location_consent(p_user_id uuid)  returns boolean
```
Contract: **absence of a `user_consents` row = no consent.** No feature may treat a missing row as permissive. Client toggles call `set_consent`; producers call the read helpers, never trust a client claim.

### 4.2 Location capture (`ip-geo`) → `user_locations`

```
INPUT  (from client, authenticated): none but the session; Edge Function reads the IP.
GUARD  : has_location_consent(auth.uid()) must be true, re-checked in the function.
OUTPUT : insert user_locations { user_id, captured_at, ip_city, ip_region, ip_country,
                                 geog=city_centroid, source='ip-geo' }
NEVER  : raw IP persisted; sub-city precision; any write when consent is false.
```
Owner A3 chooses the IP→geo source (see Decision D4). RLS: `user_locations` readable only by `is_admin()`.

### 4.3 Scheduler → Sender  (the core hand-off)

```sql
-- FIRST-PASS eligibility. SECURITY DEFINER, runs in scheduler/service context ONLY.
-- Returns email because the sender needs it; email is PII, so this is NEVER exposed to
-- advertisers or non-admins (no grant to authenticated for advertiser use).
campaign_eligible_recipients(p_campaign_id uuid)
  returns table (user_id uuid, email text, region text)
  -- applies, in the query: marketing consent + segment/region target match
  --                        + NOT in email_suppressions + under frequency cap
```
```
ENQUEUE (campaign-scheduler, pg_cron):
  insert into campaign_sends (campaign_id, user_id, channel, status, unsubscribe_token)
    select campaign_id, user_id, 'email', 'queued', gen_unsub_token()
    from campaign_eligible_recipients(campaign_id)
    on conflict (campaign_id, user_id) do nothing;   -- idempotent re-runs
  net.http_post( email-send URL, { campaign_id, batch_of user_ids },
                 Authorization: Bearer <Vault service_role_key> );   -- pg_net + Vault
```
The scheduler's job ends at "rows are `queued` and the sender is nudged". It does not call Resend. This separation is what makes the send-time re-check possible and what bounds a stuck sender (queued rows are the durable work list).

### 4.4 Send-time re-check  (Sender internal, the legal linchpin)

```sql
-- Owner A6. Called by email-send for EACH recipient, in the same TX as the status flip,
-- immediately before the Resend API call. Returns false if ANY guard now fails.
can_send_to(p_user_id uuid, p_campaign_id uuid) returns boolean
  -- true only if, AS OF NOW:
  --   has_marketing_consent(p_user_id)                         (may have flipped off)
  --   AND no email_suppressions row for the user/address       (may have unsubscribed)
  --   AND count(campaign_sends where sent within 7 days, status='sent') < cap  (3/7d default)
```
```
SENDER LOOP (email-send Edge Function):
  for send in queued(campaign_id):
     begin tx;
       if not can_send_to(send.user_id, campaign_id):
          update campaign_sends set status='skipped' where ...; commit; continue;
       -- optimistic claim: flip to 'sent' first so a crash can't double-send
       update campaign_sends set status='sent', sent_at=now() where id=send.id and status='queued';
     commit;
     POST Resend /emails { from: '...@watrloo.com', headers: List-Unsubscribe*, footer: address };
     on Resend failure → update status='failed' (retry policy per A6/A12);
```
Contract guarantees: (1) no send on stale eligibility, (2) at-most-once per recipient per campaign (unique `(campaign_id, user_id)` + claim-before-send), (3) the frequency cap is enforced against actual `sent` rows, not intentions.

### 4.5 Engagement webhook (`resend-webhook`) → state

```
INPUT : Resend event POST (verified via signing secret in Vault).
MAP   : email.delivered/opened/clicked → campaign_sends.status + record_event(analytics)
        email.bounced/complained       → campaign_sends.status='bounced'|'complained'
                                          AND insert email_suppressions (permanent kill-switch)
IDEMPOTENT: keyed on Resend message id; duplicate deliveries are no-ops.
```

### 4.6 Featured selection (`active_featured_placements`) → client

```sql
active_featured_placements(p_surface text, p_region text default null)
  returns setof featured_placements   -- time-boxed, frequency-limited, region-optional
-- grant to anon, authenticated. NO PII in, NO PII out. Runs with zero personal data
-- when p_region is null (contextual). This is the lowest-consent-risk ad surface.
```

### 4.7 Entitlement gate (PRICING) → console & scheduler

```sql
-- Owner A9. The paywall for growth features, mirroring the existing manages_bathroom() shape.
plan_allows(p_business_id uuid, p_feature text, p_requested int default 1) returns boolean
  -- checks subscriptions.status in ('active','trialing') AND plan_features for the plan,
  -- e.g. plan_allows(b,'email_blast', 1), plan_allows(b,'featured_per_week', n),
  --      plan_allows(b,'max_locations', n).
```
Every campaign create (A10) and every enqueue (A5) re-checks `plan_allows`; the console check is UX, the RPC check is the boundary — same doctrine as consent.

### 4.8 Analytics ingest (`record_event`) → `analytics_events`

```sql
record_event(p_event text, p_props jsonb, p_session_id text, p_region text default null)
  -- inserts analytics_events with user_id = (select auth.uid()) (nullable/anon).
  -- NO PII in props (enforced by convention + A4 allow-list). Respects consent:
  -- attaches user_id only when the user permits; otherwise anon+session only.
```

---

## 5. Open decisions — consolidated `[DECISION NEEDED]`

These require the **owner** (or a named agent) to choose before the dependent phase can ship. A14 consolidates the `[DECISION NEEDED]`s the other agents will raise so they land in one place.

| # | Decision | Options / trade-off | Blocks | Owner / input |
|---|----------|---------------------|--------|---------------|
| **D1** | **Physical postal address for CAN-SPAM.** Every marketing/newsletter email must carry a valid physical mailing address of the sender. | (a) Owner's real address — simplest, privacy cost. (b) USPS PO Box (~$5–20/mo) — cheap, must be a *registered agent for commercial mail*; a plain PO box qualifies under CAN-SPAM. (c) Virtual mailbox / CMRA (~$10–30/mo). (d) Registered-agent service. There is **no lawful path to send marketing with no address.** | Phase 4 (email + newsletter) — the send path can't launch without it. | **Owner.** A1 specifies the requirement; owner supplies the address. |
| **D2** | **Pricing & allowance sign-off.** The concrete dollar prices and per-plan allowances (`blasts_per_month`, `featured_per_week`, `max_locations`, seats). Contract anchors: ~$10 single-location shop; higher tiers for chains. | A9 proposes the tier table and numbers; owner signs off before anything charges or gates on them. Default frequency cap (3/7d) is already fixed by the contract — not a decision. | Phase 3 (entitlements gate) and Phase 5 (billing). | **Owner** signs off on A9's proposal. |
| **D3** | **Stripe timing.** When to replace manual billing (admin sets `subscriptions.status='active'` by hand, per the existing `admin_approve_access_request`) with self-serve Stripe. | Design for it now (schema already carries `stripe_customer_id`/`stripe_subscription_id`), but do not assume it exists. Manual billing is fine through Phases 0–4. Trigger to build: volume of paying advertisers exceeds hand-processing, or self-serve signup is desired. | Phase 5 only. Nothing before Phase 5 depends on Stripe. | **Owner** picks the trigger; A9 specifies the integration. |
| **D4** | **IP-geo source.** How `ip-geo` turns an IP into coarse city/region. | (a) **MaxMind GeoLite2** — free with a (free) license key; ship the `.mmdb` in the Edge Function bundle or R2; must honor GeoLite2 license (attribution, update cadence) and DB size in the Deno bundle. Best accuracy, fully self-contained after download. (b) **Cloudflare edge geo headers** (`CF-IPCountry`, `cf-ipcity`) — but the SPA is on **GitHub Pages, not behind Cloudflare**, and Supabase Edge Functions don't get Cloudflare's geo headers, so this needs Cloudflare in front of the function or is country-only. (c) A free IP-geo HTTP API — a third party on the hot path, against the self-sufficiency constraint; reject unless justified. **Leaning (a) MaxMind GeoLite2**, city granularity, refreshed quarterly like the basemap. | Phase 2 (location capture). | **A3** decides & documents; owner ratifies the license obligation. |
| **D5** | **`user_locations` retention window.** How long coarse location rows are kept before the `location-retention-reaper` trims them. | Shorter = less risk, weaker segments/trends; longer = better analytics, more exposure. A1 + A3 propose a default (e.g. keep latest-N or last-90-days); owner ratifies. Must appear in the privacy policy v2. | Phase 2. | **A1/A3** propose; **owner** ratifies (it's a published promise). |
| **D6** | **EU double opt-in?** Whether marketing opt-in for EU users needs a confirmation step (GDPR/ePrivacy) vs. single explicit opt-in. | A1 decides based on how much EU traffic is expected; affects the consent gate UX and the sender's eligibility. Also: whether to geo-gate marketing to non-EU only at launch to defer this. | Phase 0 (consent model) / Phase 4 (first send). | **A1**; owner ratifies risk appetite. |

Decisions **not** open (already fixed by `GROWTH_CONTRACT.md`, do not relitigate): ad-supported pivot = yes; opt-in required for location AND marketing; coarse location only (no GPS); frequency cap default 3/7d; admin-only CRM/RLS; first-party analytics in Postgres; self-sufficiency (Supabase + Resend + R2, no ad networks/analytics SaaS).

---

## 6. Why this shape (integration rationale)

- **No new infrastructure.** Every box in §1 is a tier the app already runs. The growth platform is tables + RLS + RPCs + a handful of Edge Functions + pg_cron jobs — the exact pattern already proven by `notify-access-request`, the RATE_LIMITING reaper design, and the business-accounts RPCs. This keeps the self-sufficiency constraint intact and the cost near zero (A13 sizes it).
- **One send path.** Campaigns and the newsletter both flow through `email-send` → `can_send_to()` → `email_suppressions`. There is exactly one place where a message can leave the system and exactly one place where consent/suppression/cap are enforced at send time. Two send paths would mean two chances to violate CAN-SPAM/GDPR.
- **Enqueue and send are separate on purpose.** The scheduler produces durable `queued` rows; the sender drains them with a fresh re-check. This gives idempotent retries, at-most-once delivery, a bounded blast rate (A6/A13), and — crucially — makes the send-time re-check structurally unavoidable rather than a code path someone can forget.
- **Consent is a boundary, not a checkbox.** Client toggles are UX; the truth is `user_consents` + server-side re-checks inside every RPC/Edge Function. This mirrors the existing doctrine where `manages_bathroom()` is the paywall+ownership check enforced in the DB, not the UI.
- **Advertisers never see users.** Eligibility queries that return email/PII run only in service/admin context. Advertisers get aggregate counts from `campaign_sends`. Raw `user_locations` are `is_admin()`-only by RLS. This is the wall between "we can target a region" and "we can see who lives there".
```
