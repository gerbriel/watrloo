# COMPLIANCE.md — Consent, marketing-law & privacy operating manual

**Owner:** A1 Compliance & Privacy · **Date:** 2026-07-10 · **Status:** DESIGN (not
yet implemented; current live policy stays true until this ships)

> **⚠️ NOT LEGAL ADVICE.** Written by an engineering assistant, not an attorney. The
> ad-supported pivot *materially changes* Watrloo's privacy-law exposure (we now
> track, profile-by-region, and send marketing), so the need for **review by a
> licensed attorney (US state privacy + GDPR/ePrivacy)** is *higher* than it was for
> the current policy — not lower. Every load-bearing claim cites a primary source;
> treat citations as a starting point for counsel, not a final answer.

**Summary (3 lines).**
1. Nothing about a user is tracked, located, or marketed to without a prior,
   unbundled, non-pre-ticked **opt-in**, recorded in `user_consents` and **re-checked
   at send/log time** — signup consent alone is never sufficient.
2. Marketing email is **CAN-SPAM + Gmail/Yahoo-bulk compliant** (identifiable sender,
   valid physical address `[DECISION NEEDED]`, RFC 8058 one-click unsubscribe, honored
   fast); EU users get GDPR consent; California gets a "do not sell/share" path + GPC
   honored — even though our design is built to avoid "sale/share."
3. **Coarse IP-city location only** keeps us out of CPRA "precise geolocation"
   sensitive-PI territory; advertisers never receive user data (aggregate reach only),
   which is what keeps us out of "sale/share."

**Dependencies (docs this relies on / hands off to).**
- **A2 DATA_MODEL** — owns `user_consents`, `user_locations`, `analytics_events`,
  `campaign_sends`, `email_suppressions` schema + RLS. This doc states the *legal
  invariants* those tables must enforce; A2 details columns/policies. `REQUEST TO A2`
  items are flagged inline.
- **A3 LOCATION** — coarse IP→city derivation (source, granularity). This doc fixes
  the *legal* ceiling (city/region, never <1,850 ft) and the consent gate.
- **A4 ANALYTICS** — first-party event capture. This doc fixes the consent gate and
  the "no PII in props" / GPC rules.
- **A5 CAMPAIGNS / A6 EMAIL_DELIVERY / A8 NEWSLETTER** — the send pipelines that MUST
  call the send-time consent/suppression/frequency gate defined in §3.4 and §5.
- **A11 ADMIN_CRM / A10 ADVERTISER_CONSOLE** — must enforce "admins see raw, advertisers
  see aggregate" (§7), and the DSAR/erasure surfaces (§8).

---

## 0. Scope — what this pivot changes, legally

The current app collects almost nothing and its live policy truthfully says "no
analytics, no ad trackers, no cookies, we don't sell or share" (`docs/legal/PRIVACY_POLICY.md`
§§2, 8, 9). **The pivot falsifies three of those promises** unless we do this
carefully. After the pivot we will:

- **Log coarse location** per user (`user_locations`) — *new personal-data processing*.
- **Run first-party analytics** tied to users/sessions (`analytics_events`) — *new
  device storage + profiling-ish processing*.
- **Send promotional email / newsletter with paid placements** (`ad_campaigns`,
  `campaign_sends`, `newsletter_*`) — *new commercial email → CAN-SPAM + GDPR marketing
  consent*.
- **Let businesses pay to reach users** — forces a real **"sale/share"** analysis
  (§6) and a **CCPA-applicability re-assessment** (§6.4): the current notes concluded
  CCPA "probably does not apply today" *because* we don't sell/share and have ~$0
  revenue (`docs/legal/PRIVACY_NOTES.md` §3.1). **Charging advertisers changes both
  inputs.** Counsel must re-run the threshold test before launch.

Everything below is gated on the owner's three fixed decisions: **ad-supported pivot,
opt-in consent, coarse IP-city location only** (GROWTH_CONTRACT.md).

---

## 1. The consent model — what a user actually opts into

There are **three independent, granular consents**, plus a derived signal. They map 1:1
to `user_consents` columns (A2 owns the table).

| Consent | Column | Gates | Default |
| --- | --- | --- | --- |
| **Location use** | `location_opt_in bool` | Logging coarse IP-city to `user_locations`; using stored location to *target* this user for blasts/featured/newsletter | **false** (off) |
| **Marketing email** | `marketing_opt_in bool` | Sending any promotional/newsletter/blast email to this user via `campaign_sends`/`newsletter_sends` | **false** (off) |
| **Identified analytics** | `analytics_opt_in bool` | A4 **Tier B** only: attributing `analytics_events` to a *known user* (`user_id`) / a persistent identifier. A4 **Tier A** (anonymous, aggregate) is **not** gated — see §1.5 | **false** (off) |
| **GPC (derived, not a grant)** | `gpc_detected bool` | Records that the browser sent a "do not sell/share" signal; also **hard-kills Tier B analytics at ingest** — see §4 | n/a (observed) |

> **REQUEST TO A2:** add `analytics_opt_in bool not null default false` to `user_consents`
> (A4's Tier-B gate). Absence/false = anonymous Tier-A only.

Plus provenance: `consent_updated_at`, `source` (how captured, e.g.
`'signup'`/`'settings'`/`'gpc'`). **Absence of a row = no consent** (GROWTH_CONTRACT
canonical model). Fail closed: no row → treat as both `false`.

### 1.1 The line the contract draws: ads vs. tracking

The task's key distinction, made precise:

- **Being *shown* an ad is NOT consent-gated.** An in-app featured placement selected
  from the *coarse region derived at request time* (edge geo header, not stored),
  shown inside our own property, is **contextual/first-party advertising**. It does
  not require opt-in — it is no different from a magazine printing an ad. See A7
  INAPP_ADS.
- **Tracking IS consent-gated.** *Storing* a user's location (`user_locations`),
  *attributing* analytics events to a *known user* (`analytics_events.user_id`), and
  *using* either to build a targetable profile all require `location_opt_in`.
  Anonymous, un-attributed analytics (`user_id = null`, no cross-session identifier)
  is the fallback for non-consenting users (A4 owns the mechanics; the legal ceiling
  is: no stable per-user identifier, no stored location, no PII in `props`).
- **Receiving marketing email IS consent-gated** (`marketing_opt_in`) — separately
  from location. A user may opt into email but not location (they get non-geo blasts /
  the general newsletter) or location but not email, or neither, or both. **Unbundled.**

> Transactional email (signup confirmation, password reset, review replies, receipts,
> a business's own account mail) is **not** marketing and is **not** consent-gated —
> CAN-SPAM's "commercial" rules and GDPR marketing-consent do not attach to genuine
> transactional/relationship messages. Do not smuggle promotions into transactional
> mail; a message whose *primary purpose* is commercial is commercial regardless of
> the envelope (16 CFR 316.3, primary-purpose test).

### 1.2 Where & when the prompt appears

1. **At signup** — an unbundled block *below* the account fields, **not pre-ticked**
   (GDPR Art. 4(11) / Recital 32 require an affirmative act; a pre-checked box is not
   consent — CJEU *Planet49*, C-673/17). Two separate toggles:
   - ☐ *Show me offers and a newsletter by email.* (`marketing_opt_in`)
   - ☐ *Use my approximate city (from my connection) to make offers and results more
     local.* (`location_opt_in`)
   Account creation must succeed with **both left off**. Consent must never be a
   condition of the core service (GDPR Art. 7(4) "conditionality"; a bathroom directory
   does not *need* marketing consent to function).
2. **A dedicated Settings → Privacy & Communications pane** — the same two toggles,
   editable any time, plus: a visible GPC status line (§4), a "download my data" and
   "delete my account" link (§8), and last-changed timestamps. **Withdrawing must be as
   easy as granting** (GDPR Art. 7(3)).
3. **Just-in-time** (optional, A3/A7): the first time a location-dependent surface is
   used, a soft prompt may explain and link to the toggle — but the *default remains
   off* until the user acts.

### 1.3 How consent is recorded (and *proven*)

`user_consents` holds **current state** (one row per user). That is enough to *gate*,
but under GDPR Art. 7(1) the controller must be able to **demonstrate** consent — which
needs *history*, not just the latest boolean.

> **REQUEST TO A2:** add an append-only **`consent_events`** audit table
> (`id`, `user_id`, `field` `'marketing'|'location'`, `new_value bool`, `source`,
> `ip_country` (coarse, for jurisdiction), `ua_hash`, `policy_version`, `occurred_at`).
> Written by the same `SECURITY DEFINER` RPC that updates `user_consents`, never
> client-writable. This is the evidence record for "when/how did this user consent, and
> to which policy version." If A2 prefers, fold it into the existing audit table with a
> `kind='consent'` discriminator — either works; the invariant is *append-only history
> of every consent change, tied to the policy version in force at the time*.

Recording rules (enforced in the consent-write RPC, per contract's
`SECURITY DEFINER` + `set search_path = ''` conventions):
- Stamp `consent_updated_at = now()`, `source`, and the **policy version** the user saw.
- Never flip a consent to `true` from a server default, a migration, or an admin action
  — only from the user's own authenticated request (or a verified support request the
  user initiated, logged with `source='support'`).
- A withdrawal (`true → false`) is recorded the same way and takes effect immediately.

### 1.4 Consent is re-checked at send/log time — not just at signup

**This is the single most important operational rule** (GROWTH_CONTRACT hard
constraint: "Consent + suppression are checked **at send time**, not just at signup").
Signup consent can be stale: the user may have withdrawn, hit the frequency cap,
bounced, complained, or turned on GPC since. Every location log and every marketing
send re-reads live state. See §3.4 (location) and §5.3 (email) for the exact gates.

---

## 2. Location consent specifics

- **Granularity ceiling is legal, not just product.** `user_locations` stores
  `ip_city`, `ip_region`, `ip_country`, and a **city-centroid** `geog` — never the raw
  IP as a stored location, never a lat/lng finer than the city centroid. "Radius/near
  me" runs at city/region granularity (`radius_km` on `ad_campaigns.target` is a
  city-cluster filter, not street-level). This is what keeps us on the safe side of
  CPRA "precise geolocation" (§6.1).
- **Source — DECIDED (A3): self-hosted MaxMind GeoLite2.** The `.mmdb` file lives on our
  own R2 and is read in a Supabase Edge Function; **the IP is resolved to a coarse
  location and then discarded — never stored.** Only `ip_city` / `ip_region` /
  `ip_country` + a **city-centroid point with a ≥5 km accuracy floor** are kept.
  Retention is **A3's: keep the latest 5 / rolling 90 days** (this supersedes the generic
  default in §8.1). Two legal consequences to carry into the policy:
  - **No new processor and no IP retention.** Because GeoLite2 runs on our own
    infrastructure, **no third party receives the user's IP** to do the lookup, and we
    persist no raw IP as location. "We estimate your approximate city from your
    connection and then **discard your IP address**" is a *strong, truthful* privacy
    statement — Privacy Policy v2 §3 is worded to make it. This data-minimization is
    load-bearing for the "coarse only / not precise geolocation" story (§6.1); the ≥5 km
    floor keeps resolution decisively coarser than the 1,850-ft sensitive-PI line.
  - **Attribution is a license obligation.** GeoLite2's end-user license **requires an
    attribution notice**. Privacy Policy v2 carries the MaxMind/GeoLite2 attribution
    line ("This product includes GeoLite2 data created by MaxMind, available from
    https://www.maxmind.com"). Keep it wherever the policy/credits render.
- **EU users:** IP-based geolocation of an EU user is processing personal data and is
  **non-essential** (the directory works without it), so it needs **prior consent**
  (ePrivacy Dir. 2002/58 Art. 5(3) for reading connection info for a non-essential
  purpose; GDPR Art. 6(1)(a)). The `location_opt_in` gate satisfies this *if* it is
  genuinely off by default and unbundled.

---

## 3. Send-time / log-time gate (the enforcement spine)

### 3.1 The invariant

No row is written to `user_locations`, and no message is written to `campaign_sends` /
`newsletter_sends`, unless a **server-side** gate passes *at that moment*. Client code
never decides this — it is enforced in `SECURITY DEFINER` RPCs / Edge Functions, per
the contract's mutation convention.

### 3.2 Location-log gate (called by A3 on sign-in)

```
can_log_location(user_id) :=
  user_consents.location_opt_in = true            -- live opt-in
  AND user_consents.gpc_detected is not forcing suppression (see §4)
  -- if false: derive coarse region in-memory for contextual use, store NOTHING
```

### 3.3 Frequency + suppression are part of the marketing gate

Per contract: **≤ 3 promotional messages / 7 days / user**, configurable
(`ad_campaigns.frequency_per_week`, enforced server-side against `campaign_sends`).
This is not itself a legal rule but under-frequency is a spam/deliverability and
trust safeguard the policy will promise; over-sending also worsens CAN-SPAM/GDPR risk.

### 3.4 Marketing-send gate (called by A5/A6/A8 per recipient, before each send)

```
can_send_marketing(user_id, campaign) :=
      user_consents.marketing_opt_in = true                     -- live opt-in (GDPR/CAN-SPAM)
  AND user_id NOT IN email_suppressions (by user + by email)    -- unsubscribed/bounced/complained
  AND count(campaign_sends WHERE user_id, sent_at > now()-7d
            AND channel='email' AND promotional) < frequency_cap -- ≤3/7d
  AND (campaign has no geo-target
       OR user has location_opt_in AND a user_locations row
          matching target_region / within target_geog+radius_km) -- geo needs location consent
  AND NOT (user is EU-region AND marketing consent record is missing/!unbundled)
```

Any single `false` → **skip the recipient and log why** in `campaign_sends.status`
(`'skipped_no_consent'`, `'skipped_suppressed'`, `'skipped_freqcap'`, …). The skip
reasons are the audit trail that proves the gate ran. Geo-targeting a user who did not
consent to location is itself a consent violation, hence the geo branch.

---

## 4. Global Privacy Control (GPC)

**What it is.** GPC is a browser signal that legally means "opt me out of sale/sharing"
in California (and other opt-out states). It arrives two ways:
- HTTP request header **`Sec-GPC: 1`** on navigations/fetches, and
- JS property **`navigator.globalPrivacyControl === true`**.

California treats GPC as a **mandatory** opt-out preference signal — the AG's 2022
**Sephora** settlement ($1.2M) was in part for *not* honoring GPC (oag.ca.gov; CPPA
regs §7025). This is confirmed in `docs/legal/PRIVACY_NOTES.md` (Citation row 11).

**Detect it early and record it.**
```ts
// runs in AuthProvider bootstrap and on the marketing/settings surfaces
const gpc =
  (typeof navigator !== 'undefined' && (navigator as any).globalPrivacyControl === true);
// server side (Edge Function): req.headers.get('Sec-GPC') === '1'
// -> upsert user_consents.gpc_detected = gpc (never clears an explicit opt-in; see below)
```
The **server-side `Sec-GPC` header is authoritative** for the opt-out (a client JS read
can be spoofed/stripped); the JS property is used to reflect status in the UI. Persist
`gpc_detected` on the consent row and surface it in the Settings pane
("Your browser is sending a Global Privacy Control signal; we treat it as an opt-out of
sale/sharing.").

**How GPC interacts with our opt-in model.** Because our design is opt-in and built to
*avoid* sale/share (§6), GPC mostly *reinforces* our defaults. Precise rules:

1. **GPC never turns anything ON.** It cannot grant consent.
2. **GPC does not silently erase an explicit, unbundled opt-in the same user just gave.**
   Under CPPA regs §7025(c), where a GPC signal *conflicts* with a consumer's existing
   business-specific privacy setting, the business **may** notify the consumer of the
   conflict and ask them to confirm the business-specific choice — but must otherwise
   respect the opt-out. Our implementation: if `gpc_detected` and the user has an
   explicit `marketing_opt_in=true`/`location_opt_in=true`, we **keep** the explicit
   choice (it is more specific and freely given) **but** show a banner in the Settings
   pane surfacing the conflict and a one-tap "honor GPC / turn these off." We do **not**
   auto-enable anything for a GPC user.
3. **For everything GPC actually governs (sale/sharing), we honor it as an opt-out
   unconditionally.** Since we don't sell/share (§6), the practical effect is: a GPC
   user is never entered into any advertiser-facing data flow, and any future feature
   that *would* be a share is disabled for them by default.
4. **Record it as the opt-out signal**, so if counsel later concludes any flow is a
   "share," we can show we honored GPC from day one.

---

## 5. CAN-SPAM — every marketing / newsletter / blast email

Legal frame: CAN-SPAM Act, **15 U.S.C. §§ 7701–7713**; FTC rule **16 CFR Part 316**;
FTC "CAN-SPAM Act: A Compliance Guide for Business" (ftc.gov). It applies to every
**commercial** email — advertiser blasts *and* our newsletter's paid-placement portions.
**Watrloo is the "sender"/"initiator"** (we operate the list and press send on the
advertiser's behalf), so **Watrloo carries the CAN-SPAM liability** even though the
advertiser wrote the creative. Penalty: **up to ~$53,088 per individual email**
(inflation-adjusted, ftc.gov) — the cap is per-message, so a single bad blast is a
five-to-eight-figure exposure.

### 5.1 The seven requirements, mapped to our pipeline

| # | CAN-SPAM requirement | How we satisfy it |
| --- | --- | --- |
| 1 | **Don't use false/misleading header info.** `From`, `To`, `Reply-To`, and routing (envelope) must be accurate and identify the sender. | Send from an authenticated `watrloo.com` address (SPF/DKIM/DMARC aligned via Resend — see A6). `From:` = "Watrloo" (the sender of record), never the advertiser's spoofed identity. |
| 2 | **Don't use deceptive subject lines.** Subject must reflect the message. | Campaign review (A5/A11) rejects clickbait/deceptive subjects in `ad_campaigns.creative.subject`. Reviewed before `status='approved'`. |
| 3 | **Identify the message as an ad** (if primary purpose is commercial). | Advertiser blasts carry a clear ad disclosure (e.g. "Sponsored offer from {business} via Watrloo"). The newsletter labels paid slots as "Sponsored." |
| 4 | **Tell recipients where you're located — a valid physical postal address.** | **See §5.2 — `[DECISION NEEDED — REQUIRED before first blast]`.** |
| 5 | **Tell recipients how to opt out**, clearly and conspicuously. | Visible unsubscribe link in every message body **and** RFC 8058 one-click header (§5.4). |
| 6 | **Honor opt-outs promptly** — within **10 business days**; keep the opt-out mechanism working ≥30 days after send; can't charge, can't require info beyond an email address, can't make them do more than reply or visit one page. | We honor **immediately** (write to `email_suppressions` on unsubscribe, re-checked at send time §3.4). Our SLA is near-real-time, well inside both the 10-business-day law *and* the 48-hour Gmail/Yahoo bulk rule (§5.4). |
| 7 | **Monitor what others do on your behalf.** You can't contract away liability. | Advertisers supply creative but **cannot send** — only Watrloo's reviewed pipeline sends. Campaign review + suppression + frequency gate is the monitoring. |

### 5.2 Physical postal address — `[DECISION NEEDED — REQUIRED, BLOCKING]`

> **Every commercial email must contain the sender's valid physical postal address.**
> This is not optional and there is no first-party-only exception. The owner's choice
> of *no postal address* for the current consumer policy **cannot carry over to
> marketing email** — a blast without a valid physical address is a per-message
> CAN-SPAM violation.
>
> Per FTC guidance, a "valid physical postal address" may be **(a)** a current street
> address, **(b)** a **P.O. box registered with the U.S. Postal Service**, or **(c)** a
> **private mailbox registered with a Commercial Mail Receiving Agency (CMRA)** under
> USPS regs. A **registered-agent address** (the operator's LLC formation agent) is a
> common privacy-preserving choice for a solo operator who does not want a home address
> public.
>
> **RESOLUTION REQUIRED before the first blast:** pick one of {USPS P.O. box,
> CMRA private mailbox, registered-agent address, business street address}. Recommended
> for a solo/California operator: a **USPS P.O. box** or the **LLC's registered-agent
> address** — both keep a home address private and both satisfy CAN-SPAM. This address
> is then a mandatory merge field in the email footer template (A6) and appears in the
> Privacy Policy v2 contact block. It does **not** need to be the consumer policy's
> contact address, but it must be real and monitored.

### 5.3 Suppression / unsubscribe handling

- **`email_suppressions` is the kill-switch.** An unsubscribe, hard bounce, or spam
  complaint writes a row; the send gate (§3.4) checks it **by user and by email
  address** before every send. A global per-user suppression overrides every campaign.
- **Unsubscribe must not require login or extra data** (CAN-SPAM: no more than "reply
  or visit a single page," no info beyond the email address). The one-click endpoint
  therefore accepts a signed `unsubscribe_token` (stored on `campaign_sends`) and
  suppresses *without* an authenticated session.
- **Suppression survives account deletion — deliberately.** See §8.3: we retain a
  minimized (hashed) suppression record even after erasure, because we must *not*
  re-mail someone who opted out. This is the standard, defensible tension between the
  right to erasure and the duty to honor an opt-out.

### 5.4 One-click unsubscribe (RFC 8058) + Gmail/Yahoo bulk-sender rules

As of **June 2024**, Gmail and Yahoo require **bulk senders (>5,000 messages/day to
their users)** to implement **RFC 8058 one-click unsubscribe** and to honor opt-outs
**within 48 hours** (plus SPF/DKIM/DMARC alignment and low spam rates). Even below the
bulk threshold, this is now the deliverability baseline. Every marketing message MUST
include:

```
List-Unsubscribe: <https://watrloo.com/u/{unsubscribe_token}>, <mailto:unsub@watrloo.com?subject={token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

- The `https` target is a **POST** endpoint (Edge Function) that suppresses on the
  `token` with no auth and no confirmation interstitial (RFC 8058 forbids requiring
  further action).
- Keep the visible in-body unsubscribe link too (CAN-SPAM requirement #5; RFC 8058
  covers the mailbox-UI button, not the body).
- Honor SLA: **immediate** (write suppression synchronously), which satisfies the
  48-hour Gmail/Yahoo rule and the 10-business-day CAN-SPAM rule at once.

A6 EMAIL_DELIVERY owns the header/template mechanics; the invariant here is *these
headers exist on every promotional/newsletter send and the endpoint suppresses without
friction.*

---

## 6. CPRA / CCPA analysis (Cal. Civ. Code § 1798.100 et seq.)

Subsection letters below were pinned to the live statute in
`docs/legal/PRIVACY_NOTES.md` (Citation verification, 2026-07-10) — reusing those
verified anchors.

### 6.1 Coarse location is NOT "precise geolocation," so NOT sensitive PI — this is *why* coarse was chosen

- **"Precise geolocation"** = location within a **circle with a radius of 1,850 feet**
  (Cal. Civ. Code **§ 1798.140(w)**), and it is listed as **sensitive personal
  information** at **§ 1798.140(ae)(1)(C)**. (Both verified verbatim in PRIVACY_NOTES,
  Citation row 5.)
- Our `user_locations` resolves to **city/region centroids** — resolution measured in
  *miles*, far coarser than 1,850 ft (~0.35 mi). **City-level location is therefore not
  "precise geolocation" and not sensitive PI.** This is the load-bearing reason the
  owner mandated coarse-only: it keeps us out of the sensitive-PI regime (which would
  otherwise trigger the "Limit the Use of My Sensitive Personal Information" right and
  extra disclosures). **Do not let any feature push resolution below city granularity**
  — that would silently convert the whole dataset into sensitive PI. (This is also why
  the historical EXIF-GPS-in-photos defect D2 mattered so much; it's fixed —
  PRIVACY_NOTES §2.)

### 6.2 Do we "sell" or "share"? — the advertiser-relationship analysis

Two defined terms (verified, PRIVACY_NOTES Citation row 10):
- **"Sell"** (§ 1798.140(ad)) = disclosing PI to a third party **for monetary or other
  valuable consideration**.
- **"Share"** (§ 1798.140(ah)) = disclosing PI to a third party **for cross-context
  behavioral advertising**, money or not. "Cross-context behavioral advertising"
  (§ 1798.140(k)) targets ads based on PI derived from the consumer's activity **across
  distinct businesses/sites/apps** — i.e., tracking a person around the web.

**Apply it to our model:**
- **No PI is disclosed to advertisers.** Advertisers upload creative + a target
  (region/segment) and receive **aggregate reach counts only** — never a user list,
  never a location, never an identifier (enforced by admin-only RLS on `user_locations`
  and the CRM, and by the advertiser console showing only aggregates — A10/A11). The
  consideration (advertiser → Watrloo) buys a *service* (we message our own users on
  their behalf); **no personal information flows outbound**. With no disclosure of PI to
  the third party, there is **no "sale."**
- **Targeting is first-party and in-context.** Ads are shown **inside our own app and
  our own email list**, targeted using **our own first-party coarse location and
  segments** — *not* by tracking users across other businesses. That is **first-party /
  contextual advertising**, which is outside the definition of "cross-context behavioral
  advertising," so it is **not a "share."**

**Conclusion (subject to counsel):** the model as designed — *advertisers never receive
user data; we send on their behalf; targeting is first-party and in-context* — is
built to be **neither a "sale" nor a "share."** The whole architecture (admin-only RLS,
aggregate-only advertiser views, no third-party ad SDK, first-party analytics) exists to
keep it that way.

### 6.3 What opt-out is still required (belt-and-suspenders)

Even having concluded "no sale/share," we implement the opt-out machinery anyway,
because (a) the conclusion depends on facts staying true, (b) GPC must be honored
regardless, and (c) it's cheap trust insurance:
- **Honor GPC** as a sale/share opt-out (§4) — mandatory in CA.
- **Provide a "Do Not Sell or Share My Personal Information" link/control** (the
  Settings pane doubles as this) even though the answer is "we don't" (Cal. Civ. Code
  § 1798.135 mechanics). A user turning off location + marketing is the practical
  opt-out; GPC does it automatically.
- **Minors:** § 1798.120(c) requires **opt-in** to sell/share for consumers under 16
  (13–15 opt in themselves; a parent for under-13). Since we don't sell/share *and*
  everything is opt-in *and* the service is 13+ (COPPA) — with 16+ recommended for EU
  (GDPR Art. 8) — we are conservative here. Do not build any flow that would sell/share
  a minor's data.
- **No CPRA "sensitive PI" limitation right is triggered**, because coarse location
  isn't sensitive PI (§6.1) and we collect no other sensitive categories.

### 6.4 Applicability re-assessment — `[DECISION NEEDED — counsel]`

`docs/legal/PRIVACY_NOTES.md` §3.1 concluded CCPA "probably does not apply today"
because Watrloo hit **none** of the three § 1798.140(d)(1) thresholds — critically the
100,000-consumer prong is worded **"buys, sells, or shares"** (not "collects"), so a
non-selling app can't trip it. **The pivot changes the inputs:** we now take advertiser
revenue, and *if* any flow were ever deemed a "share," the 100k prong could engage at
scale. **Flag for counsel to re-run the threshold test at launch and annually.** Note
also other state laws (VA VCDPA, CO CPA, etc.) with their own thresholds — most still
won't bite a small operator, but "targeted advertising" opt-out rights in those laws
are worth a scan since we now do region-targeted marketing.

---

## 7. GDPR / ePrivacy (EU/EEA/UK users)

Applies **where** GDPR applies (Art. 3(2); PRIVACY_NOTES §3.2 explains it likely does
not attach merely from EU visitors, but we comply proactively and *must* if we target EU
users). For any user we process as an EU user:

- **Lawful basis for marketing = consent** (Art. 6(1)(a)). Legitimate interest is a
  weak/inappropriate fit for e-marketing to EU consumers; use consent.
- **Lawful basis for non-essential location processing = consent** (Art. 6(1)(a) +
  ePrivacy Art. 5(3) for reading connection/device info for a non-essential purpose).
- **Consent must be** freely given, specific, informed, unambiguous, by a clear
  affirmative act (Art. 4(11); Recital 32). Therefore the opt-in UI (§1.2) must be:
  - **Unbundled** — location and marketing are separate toggles, and neither is bundled
    with account creation (Art. 7(4) conditionality).
  - **Non-pre-ticked** — pre-checked boxes are not consent (*Planet49*, C-673/17).
  - **Informed** — links to Privacy Policy v2 at the point of choice, naming what data,
    why, and who (no advertiser gets their data).
- **Right to withdraw** (Art. 7(3)) — as easy as giving; the Settings toggle is the
  withdrawal mechanism; withdrawal takes effect immediately at the next send/log gate.
- **Transparency** (Arts. 13–14) — Privacy Policy v2 discloses the new processing,
  purposes, recipients (processors: Supabase, Resend, Cloudflare, geo source),
  retention, and rights.
- **Right to object to direct marketing** (Art. 21(2)) is absolute — same mechanism as
  withdrawal + suppression.
- **DPIA:** the pivot adds systematic monitoring (location + analytics + segmentation
  for marketing). Counsel/DPO should assess whether a **Data Protection Impact
  Assessment** (Art. 35) is warranted; region-based profiling of a user base plausibly
  triggers the "systematic and extensive evaluation / large-scale monitoring" criteria.
  Flag it.

---

## 8. Retention, DSAR, and suppression handling

### 8.1 Retention limits (data minimization — GDPR Art. 5(1)(e); CPRA storage limitation § 1798.100(c))

Every new table needs a stated, enforced retention limit (via `pg_cron`, which is
available per the contract). Proposed defaults — **all configurable; counsel/owner to
confirm**:

| Table | Default retention | Rationale |
| --- | --- | --- |
| `user_locations` | Keep the **current/last-known** coarse location + **rolling 13 months** of history; purge older nightly. | Targeting only needs the recent picture; 13 months covers annual seasonality. Longer history is not needed for city-level targeting. |
| `analytics_events` | **Raw event rows: 14 months**, then drop or roll into aggregate; **strip `user_id`** (anonymize) on rows older than the raw window. | Product metrics rarely need raw per-user rows beyond a year; de-identify rather than keep. No PII in `props` at any age (A4 invariant). |
| `campaign_sends` | **24 months** for audit/frequency/reach, then aggregate. Keep the `unsubscribe_token`→suppression linkage as long as needed to honor opt-outs. | Proves consent-honored + reach counts; frequency cap only needs the last 7 days but audit wants longer. |
| `user_consents` / `consent_events` | **Life of account + a limited tail** after deletion (see §8.3) to evidence lawful basis. | GDPR Art. 7(1) "demonstrate consent." |
| `email_suppressions` | **Indefinite (minimized/hashed after erasure)** — see §8.3. | Must never re-mail an opt-out. |

`REQUEST TO A2:` expose these as `pg_cron` purge jobs + a `plan_features`/config knob
so the numbers are tunable without a migration.

### 8.2 Data-subject access / deletion extended to the new data

The existing `delete_my_account` RPC + `deleteMyAccount()` (`src/lib/api/profiles.ts`)
already deletes the auth user, cascaded rows, and the user's storage prefix (this is the
D5 fix landing). **It must be extended** so account deletion also removes/anonymizes:
`user_consents`, `consent_events` (retain minimized evidence per §8.3), `user_locations`
(delete), `analytics_events` (delete rows or null the `user_id`), `campaign_sends`
(anonymize `user_id`, keep aggregate), `user_segments` membership.

- **Access/export** (GDPR Art. 15 / CCPA "right to know"): the "download my data"
  action must include the new categories (consents, coarse locations, analytics events
  attributed to them, campaigns they received). `REQUEST TO A2/A11:` an admin/self
  export RPC covering these tables.
- **Delete** (GDPR Art. 17 / CCPA delete): the extended RPC above. Honor within
  statutory windows counsel identifies (CCPA generally 45 days; GDPR "without undue
  delay," ≤1 month).

### 8.3 Suppression vs. erasure — the deliberate exception

When a user deletes their account (or a non-user unsubscribes), we **cannot** simply
forget their email, or we'd risk re-mailing them and violating both their opt-out and
CAN-SPAM. Resolution (standard and defensible):
- On erasure, reduce the `email_suppressions` record to the **minimum necessary** — a
  **one-way hash of the email** + suppression reason + timestamp — and **retain it**.
  Delete everything else about the person.
- Legal basis: **legal obligation / legitimate interest** in honoring a suppression
  (GDPR permits retaining suppression/opt-out data as an exception to erasure;
  CAN-SPAM affirmatively requires you not to re-mail). Document this in Privacy Policy
  v2's retention section so it's disclosed, not surprising.
- The send gate (§3.4) hashes the candidate email and checks it against the suppression
  hashes, so suppression keeps working after erasure without storing the plaintext.

---

## 9. Admin-only visibility (privacy-by-design invariant)

Per contract: **raw `user_locations` and the CRM are admin-only, enforced by RLS
(`is_admin()`), never visible to advertisers.** Advertisers see **aggregate reach counts
only.** This is not merely an access-control nicety — it is the **factual predicate for
the "no sale/share" conclusion (§6.2)**. If an advertiser could ever see individual
users/locations, the analysis flips to a disclosure/"sale" and the whole compliance
posture changes. A10/A11 must enforce it; A1 asserts it as a legal invariant:

- `user_locations`, `analytics_events` (user-attributed), `user_consents`,
  `campaign_sends` per-recipient rows: **admin-only SELECT** (`(select public.is_admin())`),
  users may read their **own** rows only, advertisers get **none**.
- Advertiser-facing counts must be **k-anonymized** (suppress/aggregate any bucket below
  a small threshold, e.g. <25 users) so a narrow region can't re-identify individuals.
  `REQUEST TO A10:` enforce a minimum-bucket floor on reach displays.

---

## 10. Compliance checklist — ordered by what MUST exist before the first blast

**Blockers — the first promotional email cannot lawfully go out until all of these are true:**

1. **[BLOCKING] Valid physical postal address chosen** and merged into the email footer
   template (§5.2). No address → every send is a CAN-SPAM violation. `[DECISION NEEDED]`
2. **[BLOCKING] Opt-in consent flow live** — unbundled, non-pre-ticked toggles at signup
   + Settings pane, writing `user_consents` + `consent_events` via the server RPC
   (§1.2–1.3). Nothing may be on by default.
3. **[BLOCKING] Send-time gate live** — `can_send_marketing()` (§3.4) re-checks live
   consent + `email_suppressions` + frequency cap + geo/location-consent, per recipient,
   server-side. Signup consent alone must not authorize a send.
4. **[BLOCKING] One-click unsubscribe (RFC 8058) + visible unsubscribe** on every
   message, with a no-auth POST suppression endpoint honoring immediately (§5.4).
   Required for CAN-SPAM *and* Gmail/Yahoo delivery.
5. **[BLOCKING] `email_suppressions` enforced** by user and by email, surviving account
   deletion as a hash (§5.3, §8.3).
6. **[BLOCKING] GPC detection + honoring** wired (server `Sec-GPC` + client property),
   recorded on `user_consents.gpc_detected`, never auto-enabling anything (§4).
7. **[BLOCKING] Email auth** — SPF/DKIM/DMARC aligned on `watrloo.com` via Resend, so
   headers are non-deceptive and bulk-sender rules pass (§5.1; A6 owns).
8. **[BLOCKING] Ad-identification + subject review** in the campaign approval step
   (`status` gate) so no deceptive subject / unlabeled ad ships (§5.1 rows 2–3; A5/A11).

**Before launch — governance & disclosure:**

9. **Publish Privacy Policy v2** (this pivot's rewrite) at the moment the flows go live,
   linked from signup (at the consent toggles) and the footer. Not before — the current
   policy stays live and true until then.
10. **Retention purge jobs** (`pg_cron`) for `user_locations` / `analytics_events` /
    `campaign_sends` live (§8.1).
11. **DSAR: access/export + delete extended** to the new tables; deletion RPC covers
    them; a working, monitored contact + process exists (§8.2).
12. **Admin-only RLS verified** on `user_locations`/CRM; advertiser views aggregate +
    k-anonymized only (§9).
13. **Counsel review** — Privacy Policy v2, the sale/share analysis (§6.2), CCPA
    applicability re-assessment (§6.4), postal-address choice, and (if EU-targeted) a
    DPIA (§7).

**Ongoing:**

14. **Re-check "no sale/share" before adding ANY third-party script, ad SDK, pixel,
    analytics SaaS, or data partnership.** Any of those likely converts us to
    "sharing," pulls in the cookie-consent + Do-Not-Sell regimes, and falsifies the
    policy (FTC Act §5). Update the policy *first*. (Carries forward PRIVACY_NOTES §7
    item 11.)
15. **Honor unsubscribes/GPC/DSARs within SLA**, keep the audit logs, re-verify DPF/SCC
    transfer status periodically (PRIVACY_NOTES §6).
16. **Keep resolution at city level** — never let a feature request push
    `user_locations` below city granularity (would create sensitive PI, §6.1).

---

## 11. Top 3 ways this becomes *unlawful* if done wrong

1. **Sending marketing without a valid physical postal address, working one-click
   unsubscribe, and a live at-send-time consent/suppression check.** Each defective
   email is a **separate CAN-SPAM violation up to ~$53,088** (15 U.S.C. §§ 7701–7713;
   16 CFR 316; ftc.gov). Missing the postal address (§5.2) or emailing anyone who didn't
   opt in / already unsubscribed (§3.4, §5.3) is the highest-frequency, highest-dollar
   risk here — and Watrloo, as sender, owns the liability even for advertiser creative.

2. **Publishing a policy that says "we don't sell/share / no trackers" while actually
   letting advertiser data flows or a third-party SDK leak user data.** A policy that
   misdescribes the app is itself an **FTC Act §5 deceptive practice** (15 U.S.C. §45)
   and a CCPA undisclosed-sale/share + GDPR transparency failure. This stays lawful
   **only** as long as the §6.2 facts hold: advertisers get **aggregate only**,
   admin-only RLS is real, and targeting stays first-party/in-context. Break any of
   those (or bolt on an ad network/analytics SaaS) without updating the policy first and
   the "no sale/share" sentence becomes the violation.

3. **Treating signup consent, or a pre-ticked box, as sufficient — or ignoring GPC.**
   Consent that is bundled, pre-checked, or a condition of the service is **not valid
   consent** (GDPR Art. 4(11)/7; *Planet49*), and location/marketing without it is
   unlawful processing; not honoring **GPC** is a proven CA enforcement target (Sephora,
   $1.2M). The defense is exactly the design here: unbundled non-pre-ticked opt-in,
   re-checked live at send/log time, with GPC honored and withdrawal as easy as granting.

---

## Sources (load-bearing, verified against primary sources)

- **CAN-SPAM** — 15 U.S.C. §§ 7701–7713; FTC Rule 16 CFR Part 316; FTC "CAN-SPAM Act: A
  Compliance Guide for Business,"
  https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
  (10-business-day opt-out honor; valid physical postal address incl. USPS P.O. box /
  CMRA private mailbox; identify ads; no deceptive headers/subjects; monitor agents;
  per-email penalty up to ~$53,088, inflation-adjusted — confirmed via ftc.gov 2026-07-10).
- **One-click unsubscribe** — RFC 8058 (List-Unsubscribe / List-Unsubscribe-Post =
  One-Click); Gmail & Yahoo bulk-sender requirements (eff. June 2024): bulk = >5,000
  msgs/day, one-click required, honor within 48h, SPF/DKIM/DMARC — confirmed 2026-07-10.
- **CPRA/CCPA** — Cal. Civ. Code § 1798.140 (**w** precise geolocation = 1,850-ft radius;
  **ae** sensitive PI; **ad** "sell"; **ah** "share"; **k** cross-context behavioral
  advertising; **d** business thresholds), § 1798.120 (opt-out; minors), § 1798.135
  (opt-out mechanics), § 1798.100(c) (storage limitation) — leginfo.legislature.ca.gov;
  oag.ca.gov/privacy/ccpa; CPPA regs § 7025 (opt-out preference signals / GPC),
  cppa.ca.gov. Subsection letters cross-checked against the verified anchors in
  `docs/legal/PRIVACY_NOTES.md` (Citation verification, 2026-07-10).
- **GPC / Sephora** — oag.ca.gov press release, AG–Sephora settlement 2022-08-24 ($1.2M),
  GPC as mandatory opt-out.
- **GDPR / ePrivacy** — gdpr-info.eu Arts. 4(11), 5(1)(e), 6, 7, 8, 13–14, 17, 21, 35;
  Recital 32; ePrivacy Directive 2002/58/EC Art. 5(3); CJEU *Planet49* C-673/17
  (pre-ticked boxes ≠ consent).
- **FTC Act §5** — 15 U.S.C. § 45 (deceptive practices; a false privacy promise is the
  violation).
- **App facts** — `docs/legal/PRIVACY_POLICY.md`, `docs/legal/PRIVACY_NOTES.md`,
  `docs/ops/EMAIL.md` (Resend on `watrloo.com`), `src/lib/api/profiles.ts`
  (`deleteMyAccount`/`delete_my_account`), `src/auth/AuthProvider.tsx`,
  `src/lib/supabase.ts` (localStorage session, no cookies), GROWTH_CONTRACT.md.
