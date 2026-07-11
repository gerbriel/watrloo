# Watrloo Privacy Policy — v2 (ad-supported, location-aware)

> # ⚠️ v2 — NOT YET IN EFFECT
> **Publish only when the consent flows and the growth/marketing system described in
> `docs/growth/COMPLIANCE.md` are live.** Until then, the current
> `docs/legal/PRIVACY_POLICY.md` stays in force and remains true. Publishing *this*
> version before the opt-in consent, send-time gate, unsubscribe, GPC handling, and
> retention jobs exist would itself misdescribe the app.
>
> **NOT LEGAL ADVICE — REVIEW BY COUNSEL REQUIRED (heightened need).** This draft was
> written by an engineering assistant, not an attorney, and creates no attorney–client
> relationship. Because v2 covers **tracking, coarse-location profiling, and
> advertising** — things the current app does not do — the need for review by a
> **licensed attorney (US state privacy + GDPR/ePrivacy)** is *greater* than for v1, not
> smaller. Publishing a policy that misdescribes the app is itself unlawful (FTC Act §5,
> 15 U.S.C. § 45; GDPR Arts. 5, 13–14). Do **not** invent the bracketed details.
>
> **Depends on:** `docs/growth/COMPLIANCE.md` (consent model, CAN-SPAM, GPC, sale/share
> analysis, retention). Where this policy asserts a practice, COMPLIANCE.md defines how
> it is enforced.

**Effective date:** `[EFFECTIVE DATE — the date the consent flows go live]`
**Operator:** `[LEGAL ENTITY / OPERATOR NAME]` ("Watrloo," "we," "us")
**Contact:** `[CONTACT EMAIL]` · `[POSTAL ADDRESS — see §16; REQUIRED for marketing email]`
**Policy version:** v2 (record this version against each user's consent — see §5)

---

## 1. Who we are

Watrloo is a community directory where people find and rate public bathrooms, operated
by `[LEGAL ENTITY / OPERATOR NAME]`, based in California, United States. We are the
"controller" of your personal information.

**What changed in v2.** Watrloo is now **ad-supported**. Businesses can pay us to reach
our users through **featured placements in the app**, **promotional emails**, and a
**newsletter**. To make those relevant we can log your **approximate city** (derived
from your internet connection) and use **first-party analytics**. **All of this is
strictly opt-in** — off unless you turn it on — and **we never give advertisers your
personal information** (see §8). This section explains exactly what we collect, why, who
sees it, how long we keep it, and your choices.

## 2. The short version

- **Core account data is still minimal:** your email and password (to make an account),
  a public username, and the reviews, ratings, and photos you choose to post.
- **New, and only if you opt in:**
  - **Approximate location** — we can estimate your **city/region from your IP address**
    to make offers and results more local. **No GPS, no precise/real-time location** —
    city-level only.
  - **Marketing email** — offers and a newsletter, only if you ask for them, with
    one-click unsubscribe in every message.
  - **First-party analytics** — we count how the app is used to improve it. It runs on
    **our own servers**; there are **no third-party ad networks, ad pixels, or
    analytics SaaS**, and we do not track you across other websites.
- **We show ads inside the app and in our emails, but we do not sell or share your
  personal information** as those terms are defined by California law, and **advertisers
  never receive your data** — they get anonymous, aggregate reach counts only (§8).
- **We honor Global Privacy Control** and provide opt-outs and account deletion (§8, §11).
- **Reviews, your username, and any photos you post are public** and can be indexed by
  anyone (§10). Don't post anything you want to keep private.

## 3. What we collect

**a. Information you give us**

- **Account details:** your **email address** and a **password**. The password is stored
  only in **hashed** form by our authentication provider; we never see or store it in
  plaintext.
- **Username:** a public display name you choose at sign-up. If a sign-up method does not
  supply one, we generate a **random handle** (e.g. `user_1a2b3c4d`); **we never derive
  your username from your email address.**
- **Reviews and ratings, bathroom entries, and optional photos** — as in v1. Before a
  photo leaves your device we **re-encode it in your browser**, which resizes it and
  **removes embedded metadata, including any GPS location and camera/device info
  (EXIF)**, so that data is not published with your photo.
- **Your communication and location choices** (your opt-ins) — see §5.

**b. Information collected automatically — some only if you opt in**

- **Sign-in token** *(always; strictly necessary):* an authentication token in your
  browser's local storage to keep you logged in. First-party.
- **Theme preference** *(always; not personal data):* your light/dark choice, stored in
  your browser; never leaves your device.
- **Approximate location** *(only if you opt in to location):* when you sign in, we
  estimate your **city, region, and country from your IP address** and store that
  **coarse, city-level** location (a city-centroid point, resolution measured in miles).
  **We do not store your raw IP address as your location, and we do not collect GPS or
  precise real-time location.** `[DECISION NEEDED: name the IP→geo source actually used
  — e.g. a self-hosted MaxMind GeoLite2 database (no third party receives your IP), or
  Cloudflare edge geolocation headers (Cloudflare, already our CDN/basemap host,
  processes the IP to return a coarse location). Disclose whichever is in production —
  see COMPLIANCE.md §2.]`
- **First-party usage analytics** *(see §9 for what's stored and the consent nuance):*
  events like page/screen views and feature use, on our own servers. We keep **no
  personal information in analytics event details**. If you have **not** opted in, these
  events are **not linked to your account or to a persistent identifier**.
- **Marketing/message logs** *(only for messages we actually send you):* a record that a
  given campaign or newsletter was sent to you, its delivery status, and an unsubscribe
  token — used to cap how often you hear from us, to honor unsubscribes, and to give
  advertisers **aggregate** reach counts.
- **Technical/log data at our providers:** as any web service, our providers process
  technical data such as your **IP address** and standard request logs to deliver the
  service. We do not use this to track you across other websites.

**We still do NOT collect:** precise device geolocation (we never ask your browser for
it); advertising identifiers; cross-site tracking data; data bought from data brokers;
special-category/sensitive data beyond anything you might voluntarily write in a review.
Approximate city-level location is **not** "precise geolocation" and is **not** treated
as sensitive personal information under California law (see §8).

## 4. Why we use it, and our legal basis (GDPR)

For users in the EU/EEA/UK, where the GDPR applies, our lawful bases (Art. 6(1)) are:

| What we do | Why | Legal basis |
|---|---|---|
| Create and operate your account; sign you in | Provide the service you asked for | **(b) Contract** |
| Publish the reviews, ratings, and photos you choose to post | Run a public directory | **(f) Legitimate interests** + **(a) consent** by choosing to submit |
| Keep the service secure and prevent abuse | Security | **(f) Legitimate interests** |
| **Estimate your approximate city and use it to make results/offers local** | Provide the location-aware features **you turned on** | **(a) Consent** — you may withdraw any time |
| **Send you promotional email / the newsletter** | Marketing **you asked for** | **(a) Consent** — you may withdraw any time |
| **First-party analytics linked to your account** | Improve the app | **(a) Consent** where linked to you; anonymous analytics rely on **(f) Legitimate interests** |
| Respond to your requests (support, rights requests) | Help you and meet legal duties | **(b) Contract** and **(c) Legal obligation** |

Where we rely on **consent**, you can **withdraw** it at any time in **Settings →
Privacy & Communications**, as easily as you gave it; withdrawal does not affect
processing already carried out. We do **not** rely on legitimate interests to send you
marketing or to profile you for advertising.

## 5. Your choices and how we record them

When you sign up, and any time afterward in **Settings → Privacy & Communications**, you
control two independent switches. **Both are OFF by default** — nothing is pre-selected,
and you can use Watrloo fully with both off:

- **Use my approximate city** — turns on coarse, city-level location (§3) and lets us
  make offers and results local to you.
- **Send me offers and the newsletter by email** — turns on marketing email (§6).

We record each choice — what you turned on, when, and the version of this policy in
force at the time — so we can honor it and, where the law requires, demonstrate it. We
**re-check your current choices every time** before we log your location or send you a
message; turning a switch off stops the corresponding use going forward. See
`docs/growth/COMPLIANCE.md` §1, §3 for how this is enforced.

## 6. Marketing email and how to unsubscribe

If you opt in, we may send you **promotional emails and a periodic newsletter**, which
may include **paid placements from advertisers** (clearly labeled). We follow the US
CAN-SPAM Act and Gmail/Yahoo bulk-sender rules:

- Every marketing message identifies **Watrloo** as the sender with accurate headers and
  a non-deceptive subject, is identifiable as an advertisement where required, and
  includes our **valid physical postal address** (see §16).
- Every marketing message has a **one-click unsubscribe** (in the mailbox interface) and
  a **visible unsubscribe link** in the message. Unsubscribing is immediate and requires
  no login or account — and we honor it well within the time the law allows.
- We **cap** how often we message you (a few promotional messages per week at most).
- Advertisers supply the creative, but **we** send the messages from our own systems —
  advertisers **cannot** email you directly and **never receive your address**.

Transactional emails (sign-up confirmation, password reset, replies to your reviews,
receipts) are **not** marketing, are necessary to operate your account, and are not
governed by these marketing choices.

## 7. In-app advertising and how targeting works

- We may show **featured placements and sponsored content inside the app**. Seeing an ad
  does not require any opt-in — an ad chosen for your **approximate region at the moment
  you load a screen** is like an ad in a local paper, shown inside our own app.
- If you opted in to location and/or marketing, we may make ads and offers **more
  relevant** using your **coarse city/region** and non-identifying activity segments —
  **always within Watrloo's own app and email**, never by tracking you across other
  sites or apps.
- **We do not use third-party ad networks, ad SDKs, or tracking pixels.** All targeting
  is first-party and in-context.

## 8. Selling, sharing, and advertisers (California and beyond)

**We do not sell your personal information, and we do not "share" it for cross-context
behavioral advertising, as those terms are defined by the California Consumer Privacy Act
(as amended by the CPRA).** How our ad model stays within that promise:

- **Advertisers never receive your personal information.** They provide creative and a
  target (a region or an audience segment) and, in return, receive only **anonymous,
  aggregated reach counts** (e.g. "shown to ~4,000 people in the Sacramento area"). We
  never disclose your identity, email, or location to an advertiser. Because no personal
  information is disclosed to them, there is no "sale."
- **Targeting is first-party and in-context.** We use **our own** coarse location and
  activity segments to place ads **inside our own app and email** — we do not track you
  across other businesses' sites or apps, which is what "cross-context behavioral
  advertising" (and therefore "sharing") means. So this is not "sharing."
- **Approximate location is not sensitive personal information.** California defines
  "precise geolocation" as location within about **1,850 feet**; our city/region
  estimates are far coarser, so they are **not** "precise geolocation" and **not**
  sensitive personal information. We do not collect other sensitive categories.

Even though we conclude we do not sell or share:

- **We honor the Global Privacy Control (GPC).** If your browser sends a GPC signal, we
  treat it as a request to opt out of any sale/sharing; we will not enroll you in any
  advertiser-facing data flow, and we will not use it to turn anything on.
- **You can opt out at any time** by turning off location and/or marketing in Settings —
  this is your "Do Not Sell or Share" control, even though we don't sell or share.
- **Minors:** we do not sell or share anyone's data, and everything here is opt-in; the
  service is intended for users **13 and older** (§13).

If this ever changes — for example, if we ever considered a data partnership or a
third-party advertising technology — we would update this policy and provide any legally
required choices **before** the change took effect.

## 9. Cookies, local storage, and analytics

- **We use no advertising cookies and no third-party trackers.** We do not embed
  third-party ad or analytics pixels.
- **Strictly-necessary first-party storage:** a **sign-in token** and your **theme
  preference**, both in your browser's local storage. Neither tracks you.
- **First-party analytics:** we measure how the app is used with our **own** system on
  our **own** servers. `[DECISION NEEDED: describe exactly what the analytics client
  stores on the device and whether a persistent/session identifier is set — per
  COMPLIANCE.md, analytics linked to your account or to a persistent identifier is
  treated as consent-gated (and, for EU users and any non-essential device storage,
  requires consent under ePrivacy); anonymous, un-linked counting does not. State the
  actual behavior once A4 finalizes it, and, if a non-essential identifier is set for EU
  users, describe the consent mechanism/banner used.]` We keep **no personal information
  in analytics event details**, and we do not build cross-site advertising profiles.

## 10. Public content — please read before posting

Watrloo is a public directory. **Your username, your reviews and ratings, the bathrooms
you add, and any photos you attach are visible to anyone**, including people who are not
signed in, and may be indexed by search engines. Anyone can view the set of reviews
associated with your username.

We strip hidden location and device metadata (EXIF/GPS) from photos before upload, but
that does **not** hide what is *visible* in the image. Please don't include anything you
consider private in a review or photo — including faces, license plates, documents, or
your home. You can edit or delete your own reviews and photos at any time. **Your
approximate location and analytics are never published** — they are used only as
described above and are visible only to you and to our administrators (§12).

## 11. How long we keep it

- **Account data (email, username):** as long as your account exists.
- **Reviews, ratings, bathroom entries, photos:** until you delete them or your account.
  Because these are public, others may have seen or copied them while posted.
- **Approximate location:** we keep your most recent estimate plus a limited history
  (about the last 13 months), then delete older entries automatically. `[DECISION
  NEEDED: confirm the retention window with counsel — default per COMPLIANCE.md §8.1.]`
- **Analytics events:** kept for a limited period (about 14 months), after which they are
  deleted or de-identified. `[DECISION NEEDED: confirm window.]`
- **Message/send logs:** kept for delivery, frequency-capping, and audit (about 24
  months), then aggregated. `[DECISION NEEDED: confirm window.]`
- **Consent records:** kept for the life of your account and a limited period afterward
  to evidence your choices.
- **Unsubscribe/suppression records:** if you unsubscribe or delete your account, we keep
  a **minimized (hashed) record that you opted out** so we do not email you again. This
  is a deliberate, limited exception to deletion, required to honor your opt-out.
- **Sign-in token / theme preference:** in your browser until you sign out, they expire,
  or you clear your browser storage.
- **Provider logs (e.g. IP address):** retained by our providers per their own schedules.

When you delete your account, we delete your account data and the content you posted,
**including your uploaded photo files**, and we delete or de-identify your approximate
location, analytics, and message history — retaining only the minimized suppression
record above. `[DECISION NEEDED: confirm the self-serve account-deletion flow
(`delete_my_account`) has been extended to purge the new tables — user_consents,
user_locations, analytics_events, campaign_sends — per COMPLIANCE.md §8.2 before relying
on this sentence.]`

## 12. Who can see your location and analytics

Your **approximate location, analytics events, message history, and consent settings**
are visible only to **you** and to **Watrloo administrators**, protected by database
row-level security. **Advertisers never see them** — they receive only anonymous,
aggregated counts (§8). We do not sell, rent, or hand this data to any third party for
their own purposes.

## 13. Who we share it with (service providers)

We share personal information only with **service providers ("processors")** who process
it on our behalf, under contract, to run the service — never with advertisers, data
brokers, or partners for their own purposes.

| Provider | What they do for us | What they process |
|---|---|---|
| **Supabase** | Database, authentication, photo storage, first-party analytics store, scheduled jobs | Email, hashed password, content you post, photos, approximate location, analytics events, consent + message logs, IP addresses, request logs |
| **Resend** | Sends our email (transactional and, if you opt in, marketing) on our domain `watrloo.com` | Your email address, message content and delivery status |
| **Cloudflare** | Hosts static map assets (self-hosted basemap) `[and, if used, provides coarse IP→geolocation headers — see §3]` | IP address of anyone loading the map `[/ deriving coarse location]` |
| **`[DECISION NEEDED: IP→geo source]`** | Turns an IP into an approximate city | `[If self-hosted MaxMind GeoLite2: none — the lookup runs on our own servers and no third party receives your IP. If Cloudflare edge geo: this is Cloudflare, above. Name the actual choice.]` |

We may also disclose information if **required by law** or to protect the rights, safety,
or property of our users or us. We have data-processing agreements with our processors as
required by GDPR Art. 28. `[DECISION NEEDED: confirm the Supabase, Resend, and Cloudflare
DPAs are signed/accepted before publishing.]`

## 14. International data transfers

Our providers store and process data in the **United States**. If you are in the
EU/EEA/UK, your information is transferred to the US; where that happens we rely on the
**Standard Contractual Clauses** our providers offer and/or the **EU–US Data Privacy
Framework** where a provider is certified. `[DECISION NEEDED: confirm the current
transfer mechanism with counsel — the Data Privacy Framework's status is subject to
ongoing EU litigation; see PRIVACY_NOTES §6.]`

## 15. Your rights

**If you are in the EU/EEA/UK (GDPR):** rights to **access**, **rectify**, **erase**,
**port**, **object** (including an absolute right to object to direct marketing), and
**restrict** processing, subject to legal limits. Where we rely on **consent** (location,
marketing, account-linked analytics), you may **withdraw** it at any time in Settings.
You may also **lodge a complaint** with your local data protection authority.

**If you are a California resident (CCPA/CPRA):** rights to **know**, **delete**,
**correct**, and **opt out of sale/sharing** — and although, as explained in §8, **we do
not sell or share** personal information, you can still exercise the opt-out (via the
Settings switches and by GPC, which we honor). Because we do not collect sensitive
personal information as the law defines it, the "limit the use of sensitive personal
information" right does not apply. We will **not discriminate** against you for exercising
any right.

**To exercise any right:** use **Settings → Privacy & Communications** (to change
consents, download your data, or delete your account) or email us at `[CONTACT EMAIL]`.
We verify requests (usually by confirming control of your account email) and respond
within the time the law requires. You may use an authorized agent where the law allows.

## 16. Contact and our postal address

Questions or requests: `[CONTACT EMAIL]`.

**Postal address:** `[DECISION NEEDED — REQUIRED before sending any marketing email.]`
CAN-SPAM requires every commercial email to include the sender's **valid physical postal
address**. Per FTC guidance this may be a street address, a **USPS-registered P.O. box**,
or a **private mailbox registered with a Commercial Mail Receiving Agency**; a
**registered-agent address** is a common privacy-preserving choice for a solo operator.
**Choose one, put it here and in the email footer, and do not send marketing until it is
set** (see COMPLIANCE.md §5.2).

- **EU/EEA/UK users:** you may complain to your national **data protection supervisory
  authority**.
- **California users:** you may contact the **California Attorney General** (oag.ca.gov)
  or the **California Privacy Protection Agency** (cppa.ca.gov).

## 17. Children

Watrloo is not intended for children. **You must be at least 13 years old** (consistent
with COPPA). `[DECISION NEEDED: for EU users, GDPR Art. 8 sets the digital-consent age
between 13 and 16 depending on the country — confirm with counsel whether to require 16+
for EU users, especially now that we process location and send marketing.]` We do not
knowingly collect personal information from children under 13, and we do not sell or
share anyone's data. If you believe a child provided us personal information, contact us
and we will delete it.

## 18. Security

We take reasonable measures to protect your information. Our database uses **row-level
security** so that your location, analytics, and message history are visible only to you
and our administrators, and write access to content is limited to your own account. Your
password is stored only in hashed form by our authentication provider. **No online
service can be perfectly secure**; anything you post is public by design (§10). If we
become aware of a breach affecting your personal information, we will notify you and
regulators as required by law.

## 19. Changes to this policy

We may update this policy. If we make a material change — especially any change to
whether we sell or share personal information (§8), or to what we collect or how we
target — we will update the effective date and provide any legally required choices
**before** the change takes effect, and we will record the policy version against your
consent.

---

> **Placeholders to fill before publishing:** `[EFFECTIVE DATE]`,
> `[LEGAL ENTITY / OPERATOR NAME]`, `[CONTACT EMAIL]`, `[POSTAL ADDRESS]` (§16 —
> **required for marketing email**), the **IP→geo source** (§3, §13), the
> **analytics-storage description and any EU consent mechanism** (§9), the **DPA
> confirmations** (§13), the **transfer mechanism** (§14), the **retention windows**
> (§11), the **deletion-flow confirmation** (§11), and the **EU minimum age** (§17). Do
> not invent these — they are business/legal facts only you and your counsel can supply.
> **Publish only when the systems in COMPLIANCE.md are live.**
