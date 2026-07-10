# Watrloo Privacy Policy

> # ⚠️ TEMPLATE — NOT LEGAL ADVICE — REVIEW BY COUNSEL BEFORE PUBLISHING
>
> **Nothing in this document is legal advice.** It is a **draft template** written by
> an engineering assistant, not an attorney, and it does **not** create an
> attorney–client relationship. It was written to match what the Watrloo app actually
> does (see `PRIVACY_NOTES.md`). Before you publish it: (1) have a **licensed
> attorney** (US state privacy + GDPR) review it; (2) confirm the **code defects** in
> `PRIVACY_NOTES.md` §2 are resolved — some statements below are only true once those
> fixes ship (they are flagged inline); and (3) fill in every `[PLACEHOLDER]`.
> Publishing a policy that misdescribes the app is itself unlawful (FTC Act §5, 15
> U.S.C. § 45; GDPR Arts. 5, 13–14). Do **not** invent the bracketed details.
>
> **Code re-check as of 2026-07-10 (see `PRIVACY_NOTES.md`):** Defects **D1**
> (email-derived username), **D2** (EXIF/GPS in uploaded photos), and **D4** (map
> tiles from a third-party CDN) are **fixed** in the current source, so the statements
> below that depended on them are now accurate — but a lawyer must still confirm the
> wording. Defect **D5** (account deletion does not remove stored photo *files*)
> **remains open**: the deletion promise in §7 is **not yet true** and is flagged
> there. **This re-check is a fact-check of the code, not legal advice.**

**Effective date:** `[EFFECTIVE DATE]`
**Operator:** `[LEGAL ENTITY / OPERATOR NAME]` ("Watrloo," "we," "us")
**Contact:** `[CONTACT EMAIL]` · `[POSTAL ADDRESS]`

---

## 1. Who we are

Watrloo is a community directory where people find and rate public bathrooms. It is
operated by `[LEGAL ENTITY / OPERATOR NAME]`, based in California, United States. We
are the "controller" of your personal information for the purposes of this policy.
You can reach us at `[CONTACT EMAIL]`.

This policy explains what we collect, why, who we share it with, how long we keep it,
and the rights you have.

## 2. The short version

- We collect **very little**: essentially your email and password (to make an
  account), a public username, and the reviews, ratings, and photos you choose to
  post.
- **We do not sell or share your personal information** (see §8).
- **We use no advertising trackers, no analytics pixels, and no cookies** beyond a
  strictly-necessary sign-in token stored in your browser (see §9).
- **Reviews, your username, and any photos you post are public** and can be seen and
  indexed by anyone (see §10). Please don't post anything you want to keep private.

## 3. What we collect

**a. Information you give us**

- **Account details:** your **email address** and a **password** when you sign up.
  Your password is stored only in **hashed** form by our authentication provider; we
  never see or store it in plaintext.
- **Username:** a public display name that you choose at sign-up. If you sign up by a
  method that does not supply one, we generate a **random handle** (e.g. `user_1a2b3c4d`);
  **we never derive your username from your email address.** `[DECISION NEEDED:
  Defect D1 is fixed in the current code as of 2026-07-10 — the email-local-part
  fallback was removed and replaced with an opaque random handle. Confirm this remains
  true (and applies to any future OAuth/magic-link sign-up) before relying on this
  sentence.]`
- **Reviews and ratings:** the overall rating, optional sub-scores (cleanliness,
  privacy, accessibility), and any free-text review you write.
- **Bathroom entries:** if you add a bathroom, the name, address, map location, and
  amenity details you provide.
- **Photos (optional):** images you attach to a review. Before a photo leaves your
  device, we **re-encode it in your browser**, which resizes it and **removes embedded
  metadata — including any GPS location and camera/device information (EXIF)** — so
  that data is not published with your photo. `[DECISION NEEDED: Defect D2 is fixed in
  the current code as of 2026-07-10 — every uploaded image is re-encoded through a
  canvas (which drops EXIF/GPS) with no small-file passthrough; see PRIVACY_NOTES §2.
  Confirm this before publishing. Do NOT publish this sentence if that path is ever
  bypassed.]`

**b. Information collected automatically**

- **Sign-in token:** to keep you logged in, we store an authentication token in your
  browser's local storage. This is first-party and strictly necessary.
- **Theme preference:** your light/dark choice is stored in your browser's local
  storage. It never leaves your device and is not personal information.
- **Technical/log data at our providers:** when your device connects to our service
  providers (below), they process technical data such as your **IP address** and
  standard request logs, as any web service does. We do not use this to track you
  across other websites.

**We do NOT collect:** precise device geolocation via your browser (we never ask for
it); advertising identifiers; cross-site tracking data; data purchased from data
brokers; special-category/sensitive data beyond anything you might voluntarily write
in a review.

## 4. Why we use it, and our legal basis (GDPR)

For users in the EU/EEA/UK, where the GDPR applies, our lawful bases (GDPR Art. 6)
are:

| What we do | Why | Legal basis (GDPR Art. 6(1)) |
|---|---|---|
| Create and operate your account; sign you in | To provide the service you asked for | **(b) Performance of a contract** |
| Publish the reviews, ratings, and photos you choose to post | To run a public bathroom directory | **(f) Legitimate interests** (operating a community directory) and, for the act of posting, **(a) your consent** by choosing to submit |
| Keep the service secure and prevent abuse | Security | **(f) Legitimate interests** |
| Respond to your requests (support, rights requests) | To help you and meet legal duties | **(b) Contract** and **(c) Legal obligation** |

We do not rely on legitimate interests to sell, share, or profile you — we don't do
those things (§8, §9).

## 5. Who we share it with

We share personal information only with **service providers ("processors")** who
process it on our behalf, under contract, to run the service — never with
advertisers, data brokers, or partners for their own purposes.

| Provider | What they do for us | What they process |
|---|---|---|
| **Supabase** | Hosts our database, authentication, and photo storage | Email, hashed password, all content you post, photos, IP addresses, logs |
| **Cloudflare** *(only if the basemap is hosted there)* | Hosts the map's base imagery (a self-hosted map data file) | IP address of anyone loading the map `[DECISION NEEDED: Defect D4 is fixed as of 2026-07-10 — the map no longer calls the OpenStreetMap tile servers; it loads a self-hosted map archive. Name here **whatever host actually serves that archive** (e.g. Cloudflare R2). If no basemap host is configured, the map shows locations on a plain background and **no third party receives your IP for the map**, so remove this row. Disclose whichever is actually in production.]` |

We may also disclose information if **required by law** (e.g., a valid legal request),
or to protect the rights, safety, or property of our users or us.

We have data-processing agreements in place with our processors as required by GDPR
Art. 28. `[DECISION NEEDED: confirm the Supabase and Cloudflare DPAs are actually
signed/accepted before publishing this sentence.]`

## 6. International data transfers

Our providers store and process data in the **United States** (our database region is
US `us-west-1`). If you are in the EU/EEA/UK, your information is transferred to the
US. Where such transfers happen, we rely on the **Standard Contractual Clauses** our
providers offer, and/or the **EU–US Data Privacy Framework** where a provider is
certified, as the transfer mechanism. `[DECISION NEEDED: confirm the current transfer
mechanism with counsel — the Data Privacy Framework's status is subject to ongoing EU
litigation; see PRIVACY_NOTES §6.]` You can ask us for more detail using the contact
above.

## 7. How long we keep it

- **Account data (email, username):** for as long as your account exists.
- **Reviews, ratings, bathroom entries, photos:** until you delete them or your
  account. Note that because these are public, others may have seen or copied them
  while they were posted.
- **Sign-in token / theme preference:** stored in your browser until you sign out,
  it expires, or you clear your browser storage.
- **Provider logs (e.g., IP address):** retained by our providers per their own
  retention schedules.

When you delete your account, we delete your account data and the content you posted,
**including your uploaded photo files.** `[DECISION NEEDED — ⚠️ NOT TRUE YET: Defect
D5 is STILL OPEN as of 2026-07-10. There is no self-serve account-deletion flow, and
deleting a user cascades the database rows but does NOT delete the photo *files* in
storage — they remain public at their URLs. Do NOT publish this sentence as written.
Either (a) fix D5 so account deletion also removes the user's `review-photos/<uid>/`
storage prefix, or (b) rewrite this to describe the actual, possibly manual, process
honestly (e.g. "email us and we will delete your account and photo files within X
days"). A false erasure promise is an FTC Act §5 problem and defeats a GDPR Art. 17 /
CCPA deletion request.]`

## 8. We do not sell or share your personal information

**We do not sell your personal information, and we do not share it for cross-context
behavioral advertising, as those terms are defined under the California Consumer
Privacy Act (as amended by the CPRA).** We have never done so and we have no "Do Not
Sell or Share" process because there is nothing to opt out of. We do not use your
information to build advertising profiles or to target ads to you anywhere.

If this ever changes, we will update this policy and provide any legally required
choices **before** the change takes effect.

## 9. Cookies and local storage

**We do not use cookies, and we do not use advertising or analytics trackers.** The
only information we store on your device is:

- a **strictly-necessary sign-in token** (in your browser's local storage) so you
  stay logged in; and
- your **theme (light/dark) preference** (in your browser's local storage).

Neither is used to track you, and neither is shared with anyone. Because we use only
strictly-necessary, first-party storage, we do not display a cookie-consent banner.
You can clear this storage at any time via your browser settings (doing so will sign
you out).

## 10. Public content — please read before posting

Watrloo is a public directory. **Your username, your reviews and ratings, the
bathrooms you add, and any photos you attach are visible to anyone**, including people
who are not signed in, and may be indexed by search engines. Anyone can view the set
of reviews associated with your username.

We strip hidden location and device metadata (EXIF/GPS) from photos before upload, but
that does **not** hide what is *visible* in the image. Please do not include anything
you consider private in a review or photo — including faces, license plates, documents,
or your home. `[DECISION NEEDED: the metadata-stripping statement depends on Defect D2,
which is fixed as of 2026-07-10 (PRIVACY_NOTES §2). Confirm it still holds before
publishing.]` You can edit or delete your own reviews and photos at any time.

## 11. Your rights

**If you are in the EU/EEA/UK (GDPR):** you have the right to **access** your data, to
**rectify** inaccurate data, to **erase** your data ("right to be forgotten"), to
**data portability**, to **object** to processing based on legitimate interests, and
to **restrict** processing, in each case subject to legal limits. Where we rely on
consent, you may **withdraw** it at any time. You also have the right to **lodge a
complaint with your local data protection supervisory authority.**

**If you are a California resident (CCPA/CPRA):** you have the right to **know** what
personal information we hold about you, to **delete** it, to **correct** it, and to
**opt out of sale/sharing** — though, as stated in §8, **we do not sell or share
personal information**, so there is nothing to opt out of. We will **not discriminate**
against you for exercising any right.

`[NOTE FOR COUNSEL: as analyzed in PRIVACY_NOTES §3, CCPA/CPRA likely does not
currently apply to this operator by its thresholds, and GDPR may not automatically
apply absent EU targeting. We describe these rights because we choose to honor them.
Confirm the framing you want.]`

**To exercise any right**, email us at `[CONTACT EMAIL]`. We will verify your request
(usually by confirming control of your account email) and respond within the time
required by applicable law. You may use an authorized agent where the law allows.

## 12. Security

We take reasonable measures to protect your information. Our database uses
**row-level security** so that write access is limited to your own account, and photo
uploads are confined to your own storage area. Your password is stored only in hashed
form by our authentication provider, which maintains recognized security controls.

**No online service can be perfectly secure, and we cannot guarantee absolute
security.** In particular, remember that anything you post is public by design (§10).
If we become aware of a breach affecting your personal information, we will notify you
and any regulators as required by law.

## 13. Children

Watrloo is not intended for children. **You must be at least 13 years old to use
Watrloo.** We do not knowingly collect personal information from children under 13
(consistent with the US Children's Online Privacy Protection Act). `[DECISION NEEDED:
for EU users, GDPR Art. 8 sets the age of consent between 13 and 16 depending on the
country — confirm with counsel whether to require 16+ for EU users.]` If you believe a
child has provided us personal information, contact us at `[CONTACT EMAIL]` and we
will delete it.

## 14. How to contact us or complain

Questions or requests: `[CONTACT EMAIL]` · `[POSTAL ADDRESS]`.

- **EU/EEA/UK users:** you may lodge a complaint with your national **data protection
  supervisory authority**.
- **California users:** you may contact the **California Attorney General**
  (oag.ca.gov) or the **California Privacy Protection Agency** (cppa.ca.gov).

We would appreciate the chance to address your concern first — please reach out.

## 15. Changes to this policy

We may update this policy from time to time. If we make a material change, we will
update the "Effective date" above and, where appropriate, notify you. If a change
would ever affect whether we sell or share personal information (§8), we will make the
required disclosures and provide any legally required choices **before** the change
takes effect.

---

> **Placeholders to fill before publishing:** `[EFFECTIVE DATE]`,
> `[LEGAL ENTITY / OPERATOR NAME]`, `[CONTACT EMAIL]`, `[POSTAL ADDRESS]`, and every
> `[DECISION NEEDED: …]` block. Do not invent these — they are business/legal facts
> only you and your counsel can supply.
