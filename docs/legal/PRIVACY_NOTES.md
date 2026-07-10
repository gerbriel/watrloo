# Watrloo — Privacy & Compliance Notes

> # ⚠️ NOT LEGAL ADVICE — HAVE A LAWYER REVIEW THIS
>
> This document was written by an engineering assistant, not an attorney. It is a
> **template and an explainer**, not legal advice, and no attorney–client
> relationship is created by it. A privacy policy is a **binding legal document**.
> Before you publish anything based on this, have it reviewed by a **licensed
> attorney** — ideally one who practices US state privacy law (California) **and**
> GDPR. Publishing a policy that misdescribes what the app actually does is itself
> a legal liability: in the US it can be an **FTC Act Section 5 "deceptive
> practice"** (15 U.S.C. § 45); under the **GDPR** it is a transparency/accuracy
> failure (Arts. 5, 13–14). A confidently wrong statement is worse than silence.
>
> Legal citations below were checked against primary sources (see **Sources** at
> the end). Where a specific subsection letter could not be verified, the statute
> is cited generally and the gap is called out. Nothing here should be treated as
> a final legal conclusion.

**Prepared:** 2026-07-09 · **App:** Watrloo (public-bathroom reviews) · **Stack:** React + Supabase
**Operator profile assumed:** individual, based in California, service open to the United States, wants to be GDPR-ready in case EU users appear.

---

## 0. TL;DR for the owner

1. **The app collects very little, and that is your biggest compliance asset.** No
   analytics, no ad pixels, no third-party trackers, no cookies beyond the
   first-party auth session. Keep it that way.
2. **But there are real code-level privacy defects that a policy cannot paper
   over** (see §2). Fix these *before* publishing a policy, because a policy that
   describes a leaky app is worthless and is itself a liability. The two that
   matter most:
   - **Photos are uploaded with their EXIF metadata intact to a *public* bucket.**
     A phone photo can carry the exact GPS coordinates where it was taken. This is
     a precise-geolocation leak. **HIGH.**
   - **Usernames can be derived from the email address on a world-readable table.**
     **MEDIUM–HIGH (latent).**
3. **CCPA/CPRA almost certainly does *not* legally apply to you today** (you are
   below every threshold, and one threshold is impossible to hit unless you sell/
   share data — see §3). **GDPR probably does not automatically apply just because
   an EU tourist could visit** (§3). You are choosing to comply proactively, which
   is reasonable and cheap given how little you collect.
4. **You have decided not to sell or share personal information. Good.** That makes
   the whole regime dramatically simpler (§4). ⚠️ **The sentence "We do not sell or
   share your personal information" becomes legally binding the moment you publish
   it** — see the boxed warning in §4.

---

## 1. Data inventory (what the app actually collects)

Evidence is cited as `file:line`. "World-readable" means an anonymous, unauthenticated
visitor can read it, because the table's row-level-security SELECT policy is
`using (true)`.

| # | Data element | Where stored | Who can read it | Why collected | Retention (today) |
|---|---|---|---|---|---|
| 1 | **Email address** | Supabase Auth (`auth.users`), *not* a public table | The user themselves (shown at `src/pages/Profile.tsx:146`); Supabase; operator via dashboard. **Not directly world-readable.** ⚠️ but see Defect D1 — the local-part can leak into the username. | Account identity, login, email-confirmation link | Until account deletion; no automatic expiry |
| 2 | **Password** | Supabase Auth, stored **hashed** (`auth.users`) | No one in plaintext (managed by Supabase GoTrue) | Authentication | Until account deletion |
| 3 | **Username** | `public.profiles.username` (`supabase/migrations/20260710000000_init.sql:11`) | **World-readable** — policy `using (true)` at `…init.sql:157-158`. Read by client at `src/auth/AuthProvider.tsx:82-90` and `src/lib/api/profiles.ts:4-12` | Public display name on reviews | Until account deletion |
| 4 | **Avatar URL** | `public.profiles.avatar_url` (`…init.sql:13`) | World-readable (same policy). No upload UI wired yet; `updateProfile` allows it (`src/lib/api/profiles.ts:14-26`) | Public avatar | Until deletion |
| 5 | **Account creation date** | `public.profiles.created_at` (`…init.sql:14`) | World-readable; shown on own profile (`src/pages/Profile.tsx:51-55`) | "Joined" display | Until deletion |
| 6 | **Bathroom entries** (name, address, lat, lng, description, 4 amenity flags, `created_by`) | `public.bathrooms` (`…init.sql:21-36`) | **World-readable** — policy at `…init.sql:170-171` | Core directory content | Indefinite (no deletion policy) |
| 7 | **Reviews** (rating, 3 optional sub-scores, free-text body, timestamps, `bathroom_id`, `author_id`) | `public.reviews` (`…init.sql:46-58`) | **World-readable** — policy at `…init.sql:183-184`; indexed by author at `…init.sql:61` | Core review content | Until user deletes it (delete policy `…init.sql:195-197`) |
| 8 | **Review photos — DB pointer** (`storage_path`, which embeds the uploader's uid, e.g. `<uid>/<uuid>.jpg`) | `public.review_photos` (`…init.sql:66-71`); path built at `src/lib/api/photos.ts:23` | **World-readable** — policy at `…init.sql:200-201` | Link row → image file | Until review/photo deleted |
| 9 | **Review photos — image files** | Supabase Storage bucket `review-photos`, declared **`public = true`** (`…init.sql:225-230`), public-read policy (`…init.sql:232-234`) | **Anyone with the URL — fully public, indexable.** Uploaded **raw** at `src/lib/api/photos.ts:25-31` (no EXIF stripping — see Defect D2) | Show photos on reviews | Files persist even after account row deletion — see Defect D5 |
| 10 | **Auth session token (JWT access + refresh token)** | Browser **`localStorage`** (key `sb-<project-ref>-auth-token`) — implied by `persistSession: true` with default storage at `src/lib/supabase.ts:12-18` | The user's own browser only | Keep the user signed in | Until logout / token expiry. **First-party, strictly necessary — not a cookie.** |
| 11 | **Theme preference** | Browser `localStorage` key `watrloo-theme` (`index.html:18`, `src/components/layout/ThemeToggle.tsx:15-41`) | The user's own browser only | Remember light/dark choice | Persistent; not personal data |
| 12 | **IP address + request logs** | Not stored by the app itself, but **processed by every processor** the browser talks to: Supabase (auth/DB/storage — every call in `src/lib/api/*`), and the **OpenStreetMap tile CDN** today (`src/components/map/BathroomMap.tsx:145`) / Cloudflare R2 under the intended basemap plan | The relevant processor | Inherent to serving HTTP | Governed by each processor's own policy |

**Note on the auth token (matters for the cookie-banner analysis):** the Supabase
client is configured with `persistSession: true` and the default storage adapter
(`src/lib/supabase.ts:12-18`), which in a browser is **`localStorage`**, not a
cookie. The app sets **no cookies at all**. The only other browser storage is the
theme key (#11). This is significant: strictly-necessary first-party storage does
not require an ePrivacy/"cookie" consent banner. **Do not add one unless you add
tracking** (see §5).

---

## 2. Privacy defects found in the code (highest-value section)

A policy cannot fix these — code has to. Fixes are **proposed here only**; per the
work rules I did not modify any source file.

### D1 — Username can be derived from the email address, on a world-readable table · **MEDIUM–HIGH (latent)**

**Evidence.** The `handle_new_user` trigger sets the username from signup metadata,
**falling back to the email local-part**:

```
-- supabase/migrations/20260710000000_init.sql:107-110
desired := coalesce(
  nullif(new.raw_user_meta_data ->> 'username', ''),
  split_part(new.email, '@', 1)        -- <-- the part of the email before "@"
);
```

`public.profiles` is world-readable (`using (true)`, `…init.sql:157-158`) and every
column is exposed via `select('*')` (`src/auth/AuthProvider.tsx:84`,
`src/lib/api/profiles.ts:6`).

**Why it matters.** For any signup path that does **not** pass a `username` in
metadata, the username becomes the local-part of the person's email — publicly
exposed and permanently correlated to their reviews. Many people's email local-part
is their real name (`jane.doe@…` → `janedoe`). This is unintended disclosure of
part of an identifier that the user reasonably expects to be private.

**Honest scoping.** The *current* signup form always supplies a username
(`src/pages/SignUp.tsx:103-110` → `src/auth/AuthProvider.tsx:118-122`), so the
email fallback does **not** normally fire today. It is a **latent** defect that
becomes an **active** leak the moment you enable any alternate signup that omits the
metadata — OAuth ("Sign in with Google"), magic links, or an admin-created user.
Because those are natural next features, treat this as a real risk, not a
hypothetical.

**Fix (propose, do not apply):**
1. **Never derive the username from the email.** Change the fallback so the
   collision-resistant handle the trigger already builds at `…init.sql:113`
   (`'user_' || substr(new.id::text,1,8)`) is the *only* fallback. Drop
   `split_part(new.email,'@',1)` entirely.
2. **Stop exposing the whole `profiles` row publicly.** The public UI only needs
   `id`, `username`, `avatar_url`. Consider locking the base table down and
   exposing a `security_invoker` view (or narrowing client `select` lists) so that
   new columns can never leak by default. (This is defense-in-depth; the app never
   puts email in `profiles` today, but `select('*')` is a footgun.)

### D2 — Uploaded photos keep their EXIF metadata (GPS, device) and go to a *public* bucket · **HIGH**

**Evidence.** `PhotoUploader.tsx` validates type/size only and hands the **raw
`File`** to the parent (`src/components/review/PhotoUploader.tsx:43-63`). The upload
sends that raw file straight to storage:

```
-- src/lib/api/photos.ts:25-31
await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
  contentType: file.type || undefined,
  upsert: false,
});
```

The bucket is declared **`public = true`** (`…init.sql:225-230`) with public read
(`…init.sql:232-234`), and `publicPhotoUrl` mints a durable public URL
(`src/lib/api/photos.ts:47-50`). **There is no EXIF/metadata stripping anywhere** —
a grep for `exif|canvas|createImageBitmap|strip|metadata` in `src/` returns nothing.

**Why it matters.** Photos taken on phones commonly embed **EXIF GPS coordinates**
(the exact spot the picture was taken), plus camera make/model/serial and a precise
timestamp. Under California law, **precise geolocation — location within a ~1,850-foot
radius — is "sensitive personal information"** (Cal. Civ. Code § 1798.140; verified).
Publishing user photos with GPS intact means the app is republishing users' precise
location and device fingerprints at a public, indexable URL, without their
knowledge. This is the single most serious privacy issue in the codebase.

**Fix (propose, do not apply):** strip metadata **client-side before upload** by
re-encoding the image (drawing it to a `<canvas>` / `createImageBitmap` and
exporting via `canvas.toBlob(...)` drops all EXIF), or use a small EXIF-scrubbing
library. Re-encoding also lets you downscale to a sane max dimension. Do this in the
`PhotoUploader`/upload path so *nothing* with metadata ever reaches the public
bucket. Until fixed, either disable photo upload or warn users explicitly.

### D3 — Public, correlatable per-user review history · **MEDIUM (design characteristic — mitigate, don't necessarily remove)**

**Evidence.** `reviews` is world-readable (`…init.sql:183-184`), carries `author_id`
(`…init.sql:49`), and is **indexed by author** (`reviews_author_id_idx`,
`…init.sql:61`). The read path joins the author profile
(`src/lib/api/reviews.ts:14-16`). So anyone can enumerate every review a given user
has written and, via the join, their username.

**Why it matters.** A per-user, timestamped, geolocated review history reveals
patterns about a person's movements and habits. This is inherent to any public
review site (Yelp, Google Maps contributions work the same way), so it is not a
"bug" — but users must be **clearly told, before they post, that their username,
reviews, and photos are public and indexable.** The exposure is amplified by D1
(real-name-ish usernames) and D2 (GPS in photos), which is why those must be fixed.

**Fix (propose):** (a) a prominent, pre-submit notice that reviews/photos are public
and persistent (also reflected in the policy's "Public content" section); (b) make
sure erasure genuinely works (see D5); (c) fix D1 so the public identity is not
email-derived.

### D4 — Map tiles are fetched from a third-party CDN, leaking user IP · **MEDIUM**

**Evidence.** The live map loads tiles directly from OpenStreetMap's public tile
servers:

```
-- src/components/map/BathroomMap.tsx:143-146
<TileLayer
  attribution='&copy; … OpenStreetMap contributors'
  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
```

**Why it matters.** Every map view sends the user's **IP address** and the tile
coordinates they are viewing (i.e., *where on the map they are looking*) to the
OpenStreetMap Foundation's CDN — a third party with which the operator has **no data
processing agreement**. That contradicts the project's stated "no third-party
services" goal and is a data flow the policy would have to disclose.

**Note the architecture mismatch.** `package.json` already ships `maplibre-gl`,
`pmtiles`, and `@protomaps/basemaps` (`package.json:14-20`) and the repo contains a
self-hostable basemap (`basemap/us-z13.pmtiles`), but the running component still
uses Leaflet + the OSM tile CDN. The intended plan (self-hosted PMTiles served from
**Cloudflare R2**) removes the unbounded third party — but Cloudflare then becomes a
**processor** that sees user IPs, so you need a Cloudflare DPA and must name
Cloudflare in the policy (both are addressed in §6 and the draft policy).

**Fix (propose):** complete the migration to the self-hosted PMTiles basemap; retire
the direct OSM tile calls; execute Cloudflare's DPA; disclose Cloudflare (and, until
migrated, OpenStreetMap) as a processor.

### D5 — Account deletion leaves orphaned public photo files (erasure is incomplete) · **MEDIUM**

**Evidence.** DB rows cascade on user deletion: `profiles.id` → `auth.users` with
`on delete cascade` (`…init.sql:10`), and reviews/photos cascade from there
(`…init.sql:49,68`). **But Supabase Storage objects have no such foreign key** — the
per-review delete path removes the object explicitly (`src/lib/api/photos.ts:52-63`),
whereas deleting the *auth user* only cascades **rows**, not the **image files** in
the `review-photos` bucket.

**Why it matters.** If the operator (or a future "delete my account" flow) deletes a
user, their **photos remain public forever** at their existing URLs, even though the
DB pointer rows are gone. That defeats a GDPR erasure request (Art. 17) and a CCPA
deletion request, and it is exactly the kind of thing regulators treat as a
retention/erasure failure.

**Fix (propose):** any account-deletion routine must also delete the user's entire
`review-photos/<uid>/` storage prefix. Also note: there is currently **no self-serve
account-deletion or data-export UI** at all — users can delete individual reviews
but not their account or their email. That is fine to start if you handle deletion/
export requests **by email**, but the policy must give a working contact and you
must actually honor requests (see checklist §7).

### D6 — Public storage path discloses the uploader's Supabase user id · **LOW (informational)**

The storage path is `\<uid>/\<uuid>.ext` (`src/lib/api/photos.ts:23`) in a public
bucket, so the public photo URL reveals the uploader's `auth.users` UUID. That UUID
is opaque and already effectively linkable via `reviews.author_id`, so the marginal
exposure is low — but if you ever want photo URLs not to encode identity, change the
path scheme. Noted for completeness.

---

## 3. Which laws plausibly apply — and the thresholds (verify with counsel)

This is where generic templates get it most wrong. Applicability is not automatic.

### 3.1 CCPA / CPRA (California) — *probably does not legally apply to you today*

The CCPA (as amended by the CPRA) only binds a **"business,"** defined in **Cal.
Civ. Code § 1798.140** as a **for-profit** entity doing business in California that
meets **at least one** of three thresholds (verified against the statute):

| Prong | Threshold (verified) | Watrloo today |
|---|---|---|
| (1) Revenue | Annual gross revenue **> $25,000,000** (statutory figure; the CPPA adjusts it for inflation — ~**$26.625M** for 2025). Not limited to California revenue. | **No** — a hobby app has ~$0 revenue |
| (2) Volume | **"annually buys, sells, or shares the personal information of 100,000 or more"** consumers/households | **No** — and note the exact verb: the trigger is **buy/sell/share**, *not* mere collection. If you never buy, sell, or share, **this prong is not met no matter how many users you have.** |
| (3) Data-sale revenue | Derives **≥ 50%** of annual revenue from **selling or sharing** personal information | **No** — you have decided not to sell/share (§4) |

**Conclusion (subject to counsel):** as a non-commercial, non-selling hobby project
below $25M, **Watrloo meets none of the three prongs, so the CCPA/CPRA does not
apply as a matter of law.** Prong (2) is especially important and often
misunderstood: because the statute says *buys, sells, or shares* — not *collects* —
a purely-collecting app that does not sell/share **cannot trip the 100,000
threshold** even if it becomes popular. (You could still argue you might not even be
a "business" doing business "for profit" at all.)

**Caveats:** (a) this flips if you start selling/sharing, take on real revenue near
$25M, or a future reading treats some data flow as a "sale." (b) Other US **state**
laws (e.g., Virginia VCDPA, Colorado CPA, and a growing list) have their own — often
similar or higher — thresholds and are generally **not** triggered by a small hobby
app either, but counsel should scan the states you actually serve. (c) Even below
threshold, following CCPA-style practices (a clear notice, honoring deletion) is good
hygiene and cheap insurance — which is why we still draft a policy.

### 3.2 GDPR (EU/EEA) — *probably does not automatically apply merely from EU visitors*

Under **GDPR Art. 3(2)** (verified), a non-EU operator is caught only if it either
**(a)** offers goods or services **to** data subjects in the Union (payment
irrelevant), or **(b)** **monitors** their behaviour within the Union.

- **Monitoring (b): not met.** The app does no tracking, profiling, analytics, or
  behavioural advertising (§5). There is nothing to monitor.
- **Offering services (a): fact-dependent, and "mere accessibility" is not enough.**
  Recital 23 makes clear that a website being *reachable* from the EU does **not**
  by itself mean you are "offering services" to EU data subjects. What matters is
  whether you **envisage** offering services to them — signals like using an EU
  language or currency, EU-targeted marketing, or shipping/serving EU locations. A
  US-only, English-language, USD-free bathroom app that markets to the US and merely
  *could* be signed up for by a visiting EU tourist arguably does **not** trigger
  Art. 3(2).

**Conclusion (subject to counsel):** GDPR likely does **not** automatically apply to
Watrloo just because an EU person could visit. **However**, the moment EU users
actually sign up and post, you *are* processing their personal data, and the
operator has **chosen** to comply proactively. That is a reasonable, low-cost
decision here because the app collects so little. The draft policy is written to be
GDPR-shaped for that reason — but do not overstate applicability; say you comply
"where GDPR applies."

### 3.3 Other regimes that *do* bite regardless of the above

- **FTC Act Section 5 (15 U.S.C. § 45).** Applies to essentially any US business.
  Its main relevance: **whatever your published policy says, it must be true.**
  Saying you don't sell data, or that photos are private, when the app does
  otherwise, is a **deceptive practice**. This is the sharpest reason to fix the §2
  defects before publishing.
- **COPPA (15 U.S.C. §§ 6501–6506).** US children's privacy law covering **children
  under 13**. Verified. You should **not knowingly collect data from under-13s**;
  set the minimum age at 13 and say so. (If you ever knowingly serve under-13s, COPPA
  imposes heavy verified-parental-consent duties — avoid that.)
- **GDPR Art. 8 (children's consent).** Verified: default age is **16**, but member
  states may lower it to **no younger than 13**, so it varies by country (some at 16,
  many at 13). Practically, restrict the service to **16+** for EU users (or 13+ with
  the caveat that some member states require 16) — counsel should pin the number for
  your target countries.
- **ePrivacy / "cookie law" (EU).** Only bites if you store/read non-essential
  information on the user's device. Today you store only a **strictly-necessary
  first-party auth token and a theme preference** (§1, #10–11) — **no consent banner
  is required.** This changes instantly if you add analytics or ad pixels (§5).

---

## 4. The owner's questions

### (a) "What's a good privacy policy, similar to Airbnb/Yelp?"

Big commercial review/marketplace policies (Yelp, Airbnb, Tripadvisor, Google Maps
contributions) share a common **section skeleton**. You should borrow the
**structure**, never the **text** — their wording is copyrighted and, more
importantly, describes *their* data flows (ad networks, partners, cross-site
tracking), most of which **do not exist in Watrloo**. Copying their text would make
your policy inaccurate, which is the one thing you must not do (FTC §5).

**The shared skeleton, mapped to Watrloo:**

| Typical section | Applies to Watrloo? | Notes |
|---|---|---|
| Who we are / scope | **Yes** | Name the operator/entity, contact |
| Information we collect (from you / automatically / from third parties) | **Yes**, but small | Only what's in §1. No "from third parties," no data brokers |
| How we use it (purposes) | **Yes** | Account, display reviews, run the map |
| Legal bases (GDPR) | **Yes** (for EU users) | Contract for the account; legitimate interest for the public directory; consent for anything optional |
| How we share / disclose | **Yes**, minimal | Only **processors** (Supabase, Cloudflare). **No sale, no sharing, no ad partners** |
| Cookies & tracking technologies | **Yes, but say "we don't"** | Only the first-party auth token + theme in localStorage; no cookies, no trackers |
| Data retention | **Yes** | Be honest it's mostly "until you delete it"; note the photo-orphan fix (D5) |
| Security | **Yes**, carefully | You may mention RLS — but **do not overpromise**; see the policy's security section |
| International data transfers | **Yes** (for EU users) | Supabase region is US (`us-west-1`); SCCs / DPF (§6) |
| Your rights (GDPR + California) | **Yes** | Access, rectification, erasure, portability, objection; CCPA know/delete/correct/opt-out |
| "Do not sell/share" | **Yes — as an affirmative "we don't"** | See §4 boxed warning |
| Children | **Yes** | 13 (COPPA) / 13–16 (GDPR Art. 8) |
| Public content warning | **Yes — important here** | Reviews, username, photos are public/indexable (D3) |
| How to contact / complain | **Yes** | Include supervisory-authority + California AG/CPPA rights |
| Changes to the policy | **Yes** | Standard |

Sections you can **omit or shrink** because they don't apply: advertising/ad
partners, data brokers, "information we buy," social-media pixels, cross-context
tracking, loyalty programs, financial data, biometric data.

### (b) Selling data — the decision, and why "we don't" is the strong move

> The owner has decided **not to sell or share** personal information. This section
> is deliberately short: it justifies the decision rather than teaching how to sell.

**Why "we don't sell or share" is the right call and the simpler one.** Under Cal.
Civ. Code § 1798.140, **"sell"** is disclosing personal information to a third party
for **monetary *or other valuable* consideration** (broader than cash changing
hands), and **"share"** is disclosing it to a third party for **cross-context
behavioral advertising, whether or not for money** (both verified). The instant you
do either, a stack of obligations attaches: a **"Do Not Sell or Share My Personal
Information"** link, a working opt-out, honoring **Global Privacy Control** browser
signals (California treats GPC as a mandatory opt-out — established by the AG's 2022
**Sephora** settlement), **opt-in consent for minors under 16** (Cal. Civ. Code
§ 1798.120(c): the 13–15 minor opts in; a parent opts in for under-13s), plus
service-provider contracts and heightened limits on "sensitive PI." Under **GDPR**
it is worse: selling EU users' data needs a lawful basis under **Art. 6**, and
**legitimate interest is a very weak fit** for data sale (a data subject does not
reasonably expect their data to be sold), so in practice you would need **explicit
opt-in consent**, plus **Art. 13/14** transparency naming the recipients. A policy
that claims GDPR compliance while reserving the right to sell data is usually
**incoherent**. Choosing **not** to sell erases all of that machinery, and lets you
make a clean, trustworthy promise instead.

> ## ⚠️ THE "WE DON'T SELL OR SHARE" SENTENCE IS LEGALLY BINDING ONCE PUBLISHED
>
> Putting **"We do not sell or share your personal information"** in the policy is
> the simplest path and a genuine trust/competitive advantage — **but it is a
> binding representation.** If Watrloo later adds an **ad pixel**, an **analytics
> SDK that does cross-context behavioral advertising**, or a **data partnership**,
> that sentence becomes **false**, and the falsehood is itself the violation:
> - **FTC Act §5** (15 U.S.C. § 45) — deceptive practice;
> - **CCPA/CPRA** — undisclosed sale/sharing plus failure to provide the required
>   opt-out;
> - **GDPR** — transparency/lawful-basis failure.
>
> **This statement must be revisited and the policy updated *before* any such change
> ships — not after.** Make it part of the review checklist for adding any
> third-party script.

**Compatible ways to make money (one paragraph).** You can monetize without selling
personal data: **voluntary donations**, a **paid/premium tier** (extra features for
signed-in users), or publishing **genuinely aggregate, non-personal statistics**
(e.g., "average cleanliness by city"). ⚠️ Beware the words: **"anonymized,"
"aggregated," and "deidentified" have strict legal meanings.** Under CPRA,
"deidentified" data carries **technical + contractual** requirements (safeguards
against re-identification and a commitment not to re-identify); under **GDPR Recital
26**, truly *anonymous* data is a **high bar** — merely pseudonymized data (e.g.,
review-level data with the username removed but still linkable) is **still personal
data**. So: aggregate city-level counts are fine to share; anything at the level of
an individual review, user, or photo is **not** anonymous and must not be sold or
shared.

### (c) Tracking pixels / ad targeting — recommend against

Adding tracking pixels, an ad SDK, or a behavioral-analytics tool would trigger, at
once: (1) an **ePrivacy cookie/consent requirement** for EU users (you'd need a real
**consent banner** and a **consent management platform** — the very complexity you've
avoided); (2) **CCPA/CPRA "sharing"** for cross-context behavioral advertising,
which brings the Do-Not-Sell/Share link, GPC honoring, and the minors opt-in rules;
and (3) it would **falsify the "we don't sell or share" statement** (see §4 box).
**Recommendation: do not add them.** It is consistent with the project's stated
"no third-party services / no tracking" architecture, keeps you outside the cookie-
banner and Do-Not-Sell regimes entirely, and is a real trust advantage. If you ever
need product metrics, prefer **privacy-preserving, cookieless, first-party** counting
that does not build cross-site profiles — and get counsel to confirm it stays
outside "sharing" before shipping.

---

## 5. Confirmation: no analytics, pixels, trackers, or cookies today (verified)

Grepping `src/` and `index.html` for `analytics|gtag|ga(|segment|mixpanel|amplitude|
posthog|plausible|fathom|sentry|hotjar|fbq|facebook|pixel|doubleclick` returns
**nothing** relevant (the only hits are the CSS class `tracking-tight` and a code
comment). Grepping for `cookie|document.cookie` returns **nothing**; the only browser
storage is `localStorage` for the **auth token** (`src/lib/supabase.ts:12-18`) and
the **theme** (`src/components/layout/ThemeToggle.tsx`, `index.html:18`). Grepping for
`geolocation|getCurrentPosition|watchPosition` returns **nothing** — **the app never
requests browser geolocation.** (Locations come from the user tapping the map:
`src/components/map/BathroomMap.tsx:90-97`.) The one outbound third-party call today
is the **OSM tile CDN** (Defect D4).

**Implication:** because the only device storage is strictly-necessary and
first-party, **no cookie-consent banner is legally required today.** Preserve this.

---

## 6. Processors & international transfers

You are the **controller**; these vendors are **processors** (GDPR Art. 28 requires a
written data-processing agreement with each — verified). Name them in the policy.

| Processor | Role | What it processes | DPA available? | International transfer mechanism |
|---|---|---|---|---|
| **Supabase** | Auth, Postgres DB, Storage, logs | Email, hashed password, all DB content, uploaded photos, **IP addresses**, request logs | **Yes** — Supabase publishes a DPA incorporating the EU **SCCs** (+ UK addendum); SOC 2 Type 2 (verified). **Sign/accept it.** | Project region is **US (`us-west-1`)**, so for EU users this is a **restricted transfer**. Rely on Supabase's **SCCs** and/or the **EU–US Data Privacy Framework** if Supabase self-certifies. Data stays in the chosen region. |
| **Cloudflare** (planned R2 basemap host) | Static basemap (PMTiles) hosting/CDN | **IP addresses** of anyone loading the map | **Yes** — Cloudflare publishes a customer DPA incorporating **SCCs**; Cloudflare is **DPF-certified** (verified). | SCCs / DPF as above. **Execute the DPA before going live.** |
| **OpenStreetMap Foundation tile CDN** | *Current* map tiles (Defect D4) | **IP addresses** + tiles viewed | **No contract** — this is the problem. | None. **Migrate off it** (self-host via Cloudflare R2). |

> ⚠️ **International-transfer reality check (genuinely unsettled as of July 2026).**
> The **EU–US Data Privacy Framework** adequacy decision (Commission Implementing
> Decision (EU) **2023/1795**) is **still formally in force**, and the EU General
> Court **dismissed** the *Latombe* challenge on **3 Sept 2025 (T-553/23)** — but
> that ruling is **under appeal at the CJEU (C-703/25 P, pending)**, and a **29 June
> 2026 US Supreme Court ruling** on the President's power to remove FTC commissioners
> has raised fresh doubt about the FTC-independence assumptions the DPF rests on. In
> short: **do not treat DPF as bulletproof.** The safer belt-and-suspenders posture
> is to rely on your processors' **Standard Contractual Clauses** (which both
> Supabase and Cloudflare provide) as the primary transfer mechanism, with DPF as a
> secondary basis. Have counsel confirm the current status when you publish.

---

## 7. Compliance checklist (do these in order)

**Do first — fix the code the policy will describe (a policy over a leaky app is a
liability):**

1. **[HIGH] Strip EXIF/metadata from photos before upload** (Defect D2). Re-encode
   client-side; nothing with GPS should reach the public bucket. Until done,
   consider disabling photo upload.
2. **[MED-HIGH] Remove the email-local-part username fallback** (Defect D1); stop
   `select('*')`-ing the whole `profiles` row publicly.
3. **[MED] Make account deletion also delete the user's `review-photos/<uid>/`
   storage prefix** (Defect D5); stand up a way (even email-based) to honor
   deletion, access, and export requests.
4. **[MED] Migrate the map off the OSM tile CDN to the self-hosted PMTiles basemap on
   Cloudflare R2** (Defect D4).

**Then — paperwork & governance:**

5. **Execute the DPAs** with Supabase and Cloudflare (GDPR Art. 28). Keep copies.
6. **Add the required pre-post notice** that reviews, username, and photos are public
   and indexable (Defect D3) — both in the UI at submit time and in the policy.
7. **Set and enforce a minimum age** (13 for US/COPPA; consider 16 for EU per GDPR
   Art. 8) at signup, and state it.
8. **Fill the policy placeholders** (`[EFFECTIVE DATE]`, `[LEGAL ENTITY / OPERATOR
   NAME]`, `[CONTACT EMAIL]`, `[POSTAL ADDRESS]`) — do **not** invent these.
9. **Have a licensed attorney review** `PRIVACY_POLICY.md` (US state privacy + GDPR)
   **before publishing.**
10. **Publish the policy** and link it from signup, the footer, and the app stores if
    applicable.

**Ongoing:**

11. **Before adding any third-party script/SDK/pixel or any data partnership**, stop
    and re-check §4: it will likely falsify "we don't sell or share" and pull you
    into the cookie-consent and Do-Not-Sell regimes. Update the policy *first*.
12. **Re-verify DPF/SCC status** periodically (§6) given the pending CJEU appeal.
13. **Actually honor** deletion/access requests within statutory timelines your
    counsel identifies; keep a simple log.

---

## 8. Sources (primary where possible; verified 2026-07-09)

- **CCPA/CPRA statute — definitions ("business" thresholds, "sell," "share",
  sensitive PI, precise geolocation):** Cal. Civ. Code § 1798.140 —
  https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140.
  and https://oag.ca.gov/privacy/ccpa
- **CCPA/CPRA opt-out & minors (under-16 opt-in):** Cal. Civ. Code § 1798.120 —
  https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.120.
- **CPPA (regulator, FAQs, inflation-adjusted thresholds):** https://cppa.ca.gov/faq.html
- **Global Privacy Control mandatory / Sephora settlement (AG):**
  https://oag.ca.gov/news/press-releases/attorney-general-bonta-announces-settlement-sephora-part-ongoing-enforcement
- **GDPR Art. 3 (territorial scope):** https://gdpr-info.eu/art-3-gdpr/
- **GDPR Art. 6 (lawful bases):** https://gdpr-info.eu/art-6-gdpr/
- **GDPR Art. 8 (children's consent, 16→13):** https://gdpr-info.eu/art-8-gdpr/
- **GDPR Art. 28 (processor DPA):** https://gdpr-info.eu/art-28-gdpr/
- **GDPR Recital 26 (anonymous vs pseudonymous):** https://gdpr-info.eu/recitals/no-26/
- **EU–US Data Privacy Framework (status, program):**
  https://www.dataprivacyframework.gov/Program-Overview ; EDPB FAQ:
  https://www.edpb.europa.eu/ ; *Latombe* General Court (T-553/23, dismissed 3 Sep
  2025) & appeal (C-703/25 P, pending), plus 29 Jun 2026 US Supreme Court FTC ruling
  (reported via legal analyses).
- **FTC Act Section 5 (deceptive practices):** 15 U.S.C. § 45 —
  https://www.ftc.gov/news-events/topics/protecting-consumer-privacy-security/privacy-security-enforcement
- **COPPA (children under 13):** 15 U.S.C. §§ 6501–6506 —
  https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- **Supabase DPA / SCCs / SOC 2 / regions:** https://supabase.com/legal/dpa ;
  https://supabase.com/docs/guides/security/soc-2-compliance
- **Cloudflare DPA / SCCs / DPF:** https://www.cloudflare.com/cloudflare-customer-dpa/ ;
  https://www.cloudflare.com/trust-hub/gdpr/

> **Reminder:** citations were checked against the sources above, but statutes are
> amended and case law moves (especially DPF). Treat every citation as a starting
> point for your attorney, not a final answer. Specific subsection *letters* within
> § 1798.140 were not individually pinned and should be confirmed by counsel.
