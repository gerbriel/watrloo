# Ad Ideas — Creative & Formats

Domain: images on ads, headlines/primary text/descriptions, CTAs, creative specs & validation, ad format types. All ideas below are additive to the shipped design (`INAPP_ADS.md` §2/§4/§6, `CAMPAIGNS.md` §1.4/§7.2, `ADVERTISER_CONSOLE.md` §5.5) — none re-propose the three canonical surfaces (`FeaturedCard`/`FeaturedNearbyStrip`+`FeaturedPin`/`SponsorSlot`), the `{tagline, image_url, cta_label, link}` creative shape, the "Sponsored"/"Featured" label wording, or the freeze-at-approval rule.

## 1. Render the business logo badge that already exists in the data

`active_featured()` (INAPP_ADS.md §6.1) already returns `business_logo_url`, and `FeaturedItem.businessLogoUrl` is typed for it — but the shipped `FeaturedCard` spec (§6.3) never renders it. Add a small circular logo chip (24–28px, falls back to a monogram of the business name when null) next to the business/listing name on `FeaturedCard` and in the `SponsorSlot` "Sponsored by {business}" header. This is pure brand-recognition payoff for the advertiser at effectively zero net-new cost — the field is already fetched, already in `campaign-creatives`-style storage conventions, and this closes a literal gap between the design doc and the implemented `Campaigns.tsx`/`AdminCampaigns.tsx` (which don't even collect a logo yet, only title/body/link/region). Reused across all three placements it also gives repeat viewers a consistent visual anchor for a given advertiser, which is what makes "Sponsored" placements feel less like anonymous banner noise and more like a real business showing up.
**Effort:** S
**Touches:** UI (FeaturedCard, SponsorSlot), storage (reuse `businesses.logo_url`, already-planned bucket)
**Ship-first:** yes

## 2. Auto-fallback creative image from the bathroom's own real photos

The current `Campaigns.tsx` builder has no image field at all, and `ADVERTISER_CONSOLE.md`'s `CreativeEditor` treats the ad image as optional — so a first-time or budget-conscious advertiser ships a text-only, visually flat card next to organic `BathroomCard`s that often have photos. When `creative.image_url` is absent, fall back to the promoted listing's own most-recent approved `review_photos`/listing photo (same source `BathroomDetail` already trusts) instead of leaving the card bare. Because it's a real, already-moderated photo of the actual bathroom — not stock art, not a fabricated scene — it doesn't weaken the "never fake the listing" principle, and it removes the single biggest reason a cheap ad looks untrustworthy: an empty visual slot. This directly raises perceived quality for exactly the advertisers Watrloo needs most (small/local, no marketing team) without asking them to produce creative.
**Effort:** S/M
**Touches:** UI (fallback logic in `FeaturedCard`/`SponsorSlot`/strip card), read from existing photos table (no new storage)
**Ship-first:** yes

## 3. Controlled CTA vocabulary with deep-link behavior, not a freeform button label

Today `cta_label`/`creative.link` (and the shipped `Campaigns.tsx` "Link (optional)" field) are freeform text + a bare URL. Replace the label with a small closed set of verbs tuned to what a bathroom listing page can actually do — "View details," "Get directions," "Call," "See hours" — each with its own wired behavior (`tel:` link for Call, a `geo:`/maps deep link for Directions, `/bathrooms/{id}` for View details) instead of trusting the advertiser to paste a working URL. This is squarely a creative-and-format improvement: it standardizes ad voice across placements (reviewers stop having to eyeball "is this CTA text deceptive"), it removes an entire class of broken/typo'd links that currently only get caught by a human admin reading `CreativePreview`, and it very plausibly lifts click-through because "Call" and "Get directions" are exactly what someone glancing at a bathroom ad wants to do next.
**Effort:** S/M
**Touches:** schema (small `cta_type` enum column or `creative.cta_type`), UI (CreativeEditor + three render components)
**Ship-first:** yes

## 4. Required alt text on every ad image

`creative.image_url` has no accompanying alt-text field anywhere in the spec, so every rendered `<img>` for a featured card is either unlabeled or stuck with a generic fallback — a real accessibility gap for a public-accommodation-adjacent product (bathroom finding is disproportionately used by people who may also rely on screen readers). Add a required `image_alt` (short, length-capped) input next to the image upload in `CreativeEditor`, validated non-empty whenever an image is present, and wire it straight into the `alt` attribute on `FeaturedCard`/`SponsorSlot`/strip images. Cheap, on-brand with the app's existing "color is never the only signal" accessibility discipline (INAPP_ADS.md §4.3 mirrors this for rating pins), and it's a compliance/trust line item advertisers never think to ask for but that protects Watrloo.
**Effort:** S
**Touches:** schema (`creative.image_alt`), UI (CreativeEditor + render components)

## 5. Anti-review-mimicry creative linter

The bright line in INAPP_ADS.md §4.3 — "never an ad disguised as a review," never fake `Stars`, never a fabricated author — is currently enforced only by a human admin's judgment at review time. Add a lightweight client-side (and mirrored server-side, at `submit_campaign`) heuristic check on `creative.tagline`/`body`/`title` that flags patterns designed to read like an organic review — literal star glyphs (★★★★★), phrases like "5 stars," "best I've ever," first-person testimonial framing ("I visited and…") — with an inline warning before submit and a corresponding structured `reject_reason` an admin can pin the rejection to (CAMPAIGNS.md §7.2 already has a `low_quality`/`deceptive` vocabulary this slots into). This doesn't block anything by itself (advertisers can still submit), it just surfaces the same judgment call earlier and gives the admin queue a machine-assisted first pass, directly reinforcing the platform's single most trust-critical structural rule.
**Effort:** S/M
**Touches:** UI (inline validator in CreativeEditor), light server-side mirror in `submit_campaign`

## 6. Surface-accurate character-limit & truncation preview

`ADVERTISER_CONSOLE.md` gives email subject a numeric cap (~120) but the in-app tagline/CTA label have no stated limits, and nothing today shows an advertiser how their text will actually truncate inside a `FeaturedCard`'s `truncate` classes, the map strip's narrow mini-card, or the `SponsorSlot` header. Add real per-surface character budgets (derived from the actual card widths already in the shipped Tailwind classes) and render a live truncated preview — not just a count — as the advertiser types in each mode of `CreativeEditor`. This turns "I typed a great tagline and it got cut off after approval" from a support ticket into something the advertiser fixes themselves before ever submitting, which matters a lot given creative is frozen post-approval and a bad truncation can't be patched without a full re-review cycle.
**Effort:** S/M
**Touches:** UI only (CreativeEditor)

## 7. Structured "Offer" field, distinct from the tagline

Right now a discount or promo ("10% off," "free with any purchase") has nowhere dedicated to live — it gets buried in the freeform tagline/body, indistinguishable from generic marketing copy, with no consistent visual treatment. Add an optional structured `creative.offer_text` (short, e.g. "10% off today") + `offer_expires_at`, rendered as its own small badge/chip (visually distinct from the "Sponsored" pill so the two labels are never confused) across all three placements. This gives advertisers a concrete lever that's proven to move behavior in local-business advertising generally, and — because it's a labeled offer chip rather than something dressed up as a review or a rating boost — it stays entirely inside the "pay to be seen, not pay to look better-rated" line. It's also a natural upsell narrative for the sales pitch to a business ("your ad can carry a deal, not just a name").
**Effort:** S/M
**Touches:** schema (`creative.offer_text`, `offer_expires_at`), UI (all three render components)

## 8. Client-side image spec preflight (dimensions, aspect ratio, minimum resolution)

`compressImage`/`MAX_UPLOAD_BYTES` (reused per ADVERTISER_CONSOLE.md §5.5) handle file size but not shape — an advertiser can upload a tall portrait photo that gets awkwardly cropped inside a `FeaturedCard`'s fixed-aspect image slot, or a low-res image that looks blurry once scaled up on the map strip. Add a preflight check in the upload step of `CreativeEditor` that reads the image's natural dimensions before upload, warns (or blocks, per mode) on aspect ratios outside a per-surface tolerance and on resolutions below a floor (e.g. 600px on the short edge), and offers a simple crop/center-point picker so the advertiser controls what gets cut off rather than discovering it after their ad is live. Reduces both the "my ad looks bad" support burden and the admin-rejection rate for otherwise-fine campaigns that just need a re-crop.
**Effort:** M
**Touches:** UI (CreativeEditor upload step)

## 9. Broken/dead-link preflight check before submit

An advertiser's `creative.link`/`cta_label` link is currently taken on faith until a human reviewer clicks it (or a user does, post-launch). Because the browser's own `fetch` to an arbitrary third-party URL is CORS-blocked, this needs a small Edge Function that does a server-side `HEAD`/`GET` against the submitted link at submit time and flags a non-2xx/timeout result inline in the builder ("This link didn't respond — check it before submitting") rather than silently letting a dead CTA go to review and, worse, to production. This is a small but real trust and reviewer-efficiency win — it's exactly the kind of check a human admin currently has to do by hand for every single submission.
**Effort:** M
**Touches:** edge-function (link-check proxy), UI (submit-step validation)

## 10. Live cross-context preview toggle in `CreativeEditor`

`CreativeEditor`'s live preview (ADVERTISER_CONSOLE.md §5.5) renders one static preview per `mode`. Add lightweight toggles — mobile width vs. desktop grid-cell width, light vs. dark token set — so the advertiser can see their `FeaturedCard`/`SponsorSlot`/strip creative under the same conditions real viewers will actually see it in (the app is dark-mode-aware per §8, and most browsing is mobile). This is a lower-drama version of idea #6's truncation preview generalized to layout/theme, and it's cheap because it's just re-rendering the same components at different container widths/`data-theme`, not new data.
**Effort:** S/M
**Touches:** UI only (CreativeEditor)

## 11. Creative-only "refresh" path for a running campaign

Per CAMPAIGNS.md §1.4, once a campaign is `running` its creative is fully frozen — any change requires cloning into a brand-new `draft` and a full re-review, even for something as small as swapping a stale seasonal tagline or fixing a typo an admin didn't catch. Add a narrow, creative-only re-review lane: an `admin_review_creative_refresh(campaign_id, new_creative)` RPC that lets a manager submit a replacement creative for an *already-approved/running* campaign, versions it (append to a small `creative_versions` history rather than overwrite), and requires a fast admin re-check of just the new creative fields (same content-policy checklist as §7.2) before it swaps live — without touching targeting/schedule/entitlement accounting, which stay untouched and already-paid-for. This keeps the audit trail append-only (matches the doc's existing "never re-open a terminal state" philosophy) while removing the current all-or-nothing choice between "live with stale creative" and "cancel and resubmit the whole campaign."
**Effort:** M/L
**Touches:** schema (`creative_versions` or versioned column on `ad_campaigns`), RPC, UI (CampaignDetail)

## 12. "Sponsored nearby" tile on zero-result search/browse states

The three sold surfaces are browse/map/detail; none of them cover the moment a viewer's search or filter returns *no* organic bathrooms. Add a new contextual moment — not a new sold surface, just a client-side render path — where an empty results state shows a single labeled "Sponsored nearby" tile (reusing the exact `FeaturedCard`/strip-card chrome and the existing `active_featured('browse', region)` data) instead of a bare "no results" message. This adds no ad load anywhere ads currently compete with organic content — it only fills a currently-blank state — so it's additive inventory-for-free rather than more clutter, and it gives an advertiser a shot at exactly the viewer who's actively searching and coming up empty (arguably higher intent than a browse-grid scroll-by).
**Effort:** M
**Touches:** UI only (empty-state branch in Home.tsx/search results), no schema change if it reuses the existing `active_featured` RPC as-is

## 13. A/B creative variants with CTR-based rotation weighting

Let an advertiser attach two creative variants (different tagline/image/CTA combos) to one `featured_placements` booking; A7's existing session-seeded rotation (INAPP_ADS.md §5.2) is extended to also rotate between an advertiser's own variants and gently bias future impressions toward whichever variant has the better `featured_click`/`featured_impression` ratio in `analytics_events`. This is the most "real ad platform" feature on the list and the most valuable at scale, but it's also the most machinery for a v1 with manual billing and a handful of advertisers — it needs a variant table, a weighting function layered onto rotation that's already carefully spec'd for fairness, and enough impression volume per advertiser to make the statistics meaningful. Good candidate for later, once there's enough traffic that a single advertiser's placement gets meaningfully more than a handful of daily impressions.
**Effort:** L
**Touches:** schema (`campaign_creative_variants` or `creative` as jsonb array), UI (CreativeEditor multi-variant), rotation-logic change (client + reads from `analytics_events`)

---

**Top picks:** Ship the business-logo badge, the real-photo fallback, and the controlled CTA vocabulary first — all three are cheap, purely additive to fields/data that already exist in the shipped design, and directly fix the gap between what `INAPP_ADS.md`/`ADVERTISER_CONSOLE.md` spec'd and what `Campaigns.tsx` actually collects today (title/body/link/region, no image, no logo, no structured CTA). They raise perceived ad quality for the smallest advertisers with no new schema risk. The anti-review-mimicry linter (#5) and alt-text requirement (#4) are the next-cheapest wins because they harden the platform's core trust rule and its accessibility posture, respectively.
