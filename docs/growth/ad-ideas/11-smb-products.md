# Local-SMB Ad Products — Ranked Ideas

**Top picks:** Coupons & Offers turns the existing `SponsorSlot`/`FeaturedCard` creative into the "strongest ROI story" the docs already flag — ship it first. Map Pin Skins is a near-zero-effort visual differentiator for recognizable brands (gas pumps, coffee cups) that reuses the elevated-pin labeling pattern A7 already built. Grand Opening Boost is a pure packaging exercise — bundle placements the platform can already sell into a one-time SKU that fires the moment a claim verifies, capturing the highest-intent moment in the funnel.

All ideas below are packaging/product layers on top of the existing `featured_placements` / `ad_campaigns` / `subscriptions` model in PRICING.md and INAPP_ADS.md — none require an auction, none touch `bathroom_stats` or `reviews`, and every unit carries the "Sponsored"/"Featured" label per A7 §4. Ranked by value delivered to an SMB buyer per unit of build effort.

---

## 1. Coupons & Offers ("Show this for 10% off")

Attach a redeemable offer — a discount, a free add-on, a bundle deal — to a business's `SponsorSlot`/`FeaturedCard` creative, shown as a distinct "Offer" chip with a short expiry. Redemption is honor-system (show your phone at the counter); no POS integration needed for v1. This is the single most direct foot-traffic-to-register story a gas station or cafe can tell, and it's already called out as the "strongest ROI story" in BUSINESS_ACCOUNTS.md §6. Sell as a flat **$15–25/mo add-on** on top of any placement tier, or bundle free into Growth+ as a retention lever. Rough price shape: $19/mo flat, no per-redemption fee (keeps v1 billing simple — track redemption count for the advertiser's own vanity metric only, don't meter it).
**Effort:** S
**Touches:** `ad_campaigns.creative` jsonb (add `offer_text`, `expires_at` fields), `SponsorSlot`/`FeaturedCard` render, no new tables.
**Ship-first:** yes

## 2. Map Pin Skins (branded marker)

For a flat fee, a business's elevated map pin renders with a small branded icon (a gas pump silhouette, a cup icon) in the advertiser's brand color instead of the generic teardrop — while keeping the real rating, the "Featured" label pill, and the `aria-label` prefix exactly as A7 already specifies, so it never reads as an organic rank change. High visual delight for a low build cost, and it's the kind of thing a gas-station marketing team screenshots and shows their regional manager. Rough price shape: **$9–15/mo** add-on, only available to businesses that already hold an active `map` placement (so it's always paired with, never a substitute for, the "Featured" disclosure).
**Effort:** S
**Touches:** `ratingPinElement()` icon variant, `featured_placements` (add `icon_url`/`brand_color` to creative), no schema beyond existing `businesses.logo_url`-style fields.
**Ship-first:** yes

## 3. Grand Opening Boost (new-location launch bundle)

A one-time, fixed-price bundle that fires automatically in the window right after a `bathroom_claims` row flips to `verified`: two weeks of an elevated `FeaturedPin` + one `FeaturedCard` rotation + a starter Coupon (#1). This is pure packaging — every ingredient already exists in A7's design — sold as a single checkout line instead of three separate purchase decisions, at the exact moment a new owner is most engaged. Rough price shape: **$99 one-time** (or free-with-annual-Growth-signup as a churn-reduction perk), auto-expiring so it never becomes a permanent discount on the real placement inventory.
**Effort:** S
**Touches:** `ad_campaigns` (a `type='grand_opening_bundle'` preset that provisions 3 child placements with a shared `starts_at`), admin/checkout SKU, trigger off `bathroom_claims.status='verified'`.
**Ship-first:** yes

## 4. Featured-in-Category rail ("Top gas-station restrooms near you")

A curated rail on Browse/Search scoped by category (gas station, cafe, mall) rather than pure region — the same `FeaturedCard` mechanic A7 built, with a category filter added to the eligibility query. Lets a business buy visibility specifically among the competitive set a searcher is already comparing ("gas station restrooms near me"), which is a sharper buying decision than "featured in this city" for a chain that only cares about beating the other three gas stations on the block. Rough price shape: **$10–20/week per category-region slot**, same inventory-scarcity model as browse (cap at 3 concurrent, rotate).
**Effort:** S/M
**Touches:** `active_featured()` RPC (add `p_category` param), `bathrooms.category`/amenity taxonomy (needs a stable category field if one doesn't already exist), `Home.tsx`/Browse filter UI.

## 5. "Nearest [Brand] Restroom" chain priority

For multi-location advertisers (Growth+), when a searcher's nearest few results include more than one location of a paying chain, that chain's nearest location gets a small "Nearest {Brand}" badge and a priority slot in the "find nearest bathroom" CTA — a brand-wide feature that spans all of a chain's claimed locations at once, distinct from a single-listing placement. This is the direct product-market fit for the doc's own fictional example (Golden Bear Gas, 42 locations) and for real gas/QSR chains, whose whole pitch is "any of our doors is your restroom." Rough price shape: flat **$49–99/mo per metro** the chain operates in (not per-location — avoids punishing dense chains), sold only to businesses holding ≥3 verified locations in that metro.
**Effort:** M
**Touches:** new `brand_priority` entitlement/flag on `businesses` or `subscriptions`, nearest-bathroom sort/CTA logic (still coarse-region eligible, never precise-location targeting), a "Nearest {Brand}" badge component with its own "Sponsored" disclosure.

## 6. Newsletter Spotlight ("Local Deals" digest slot)

A named, priced product wrapped around the newsletter inventory PRICING.md already reserves as scarce ad inventory (`newsletter_slots_per_month`) — a one-paragraph business spotlight, ideally paired with a Coupon (#1), in the periodic email to opted-in users in-region. Mostly a naming/pricing exercise on top of infrastructure A8/A9 already spec'd; the new work is a clean self-serve "buy a spotlight" flow instead of only being a plan allowance. Rough price shape: **$25–49/slot**, matching the existing $25 overage figure in PRICING.md §5.
**Effort:** S
**Touches:** `newsletter_editions`/`newsletter_slots_per_month` (existing), a checkout SKU for one-off purchase beyond plan allowance, no new ad-serving surface.

## 7. City/Metro Sponsorship ("Own Fresno")

One advertiser per metro per month gets a subtle metro-wide credit line ("Keeping Fresno's restrooms great, brought to you by X") in the Browse header, plus first-right-of-refusal on that metro's other ad slots — an exclusive, single-buyer package rather than a rotated one, which sidesteps auction complexity entirely (there's only ever one seat). This is the flagship, high-ticket anchor product referenced in BUSINESS_ACCOUNTS.md §6 ("reuse the feature-a-city mechanism… let a brand own a metro's slot"). Rough price shape: **$299–999/mo** depending on metro size, sold as a Chain/Enterprise upsell, manually invoiced.
**Effort:** M
**Touches:** new `metro_sponsorships` concept (one active row per region, unique constraint = built-in exclusivity, no rotation logic needed), a header banner component on Browse/Home, admin sales workflow (not self-serve v1).

## 8. Venue/Property Sponsorship (mall, stadium, travel plaza)

Same exclusivity mechanic as City Sponsorship (#7) but at venue grain instead of metro grain — a shopping mall, a stadium, or a highway travel plaza buys sponsorship of every restroom within its own property, useful because the buyer here isn't a single tenant but the property operator wanting "clean, findable restrooms" as an amenity for all their tenants/visitors. Good B2B2C angle: the mall pays, all the food-court tenants benefit, Watrloo gets one deal instead of chasing forty. Rough price shape: **$99–299/mo per venue**, scaled to venue foot traffic/location count.
**Effort:** M
**Touches:** a `venue`/property grouping concept over `bathrooms` (may need a lightweight `venues` table or a shared `venue_id`/address-cluster tag if one doesn't exist), same banner/badge pattern as #7 scoped to venue instead of region.

## 9. "Clean Restroom Guarantee" co-branding

A business opts into a self-reported cleanliness pledge (e.g., "checked every 2 hours," visible check-log) and receives a distinct co-branded badge plus inclusion in a "Guaranteed Clean" filter — framed explicitly as an **operator pledge**, never a Watrloo-verified claim, so it can't be read as buying a rating boost. This is a trust-differentiation product rather than a placement, and it's the one idea here that most needs careful copy review (A1/legal) so "Guarantee" doesn't imply Watrloo audits it. Rough price shape: **$19–29/mo** add-on, Growth+ eligible.
**Effort:** M
**Touches:** a lightweight self-attestation flow (checklist/photo-log upload), a badge component with its own disclosure line, category filter on Browse, legal copy review (A1) before ship.

## 10. Event & Corridor Packages (game day / road-trip corridor)

Two variants of the same underlying mechanic — bundling existing region-scoped placements across either a **time window** (a home-game weekend near a stadium) or a **set of regions** (a highway corridor like I-5 or I-80) into one purchasable package, sold to bars/restaurants near a venue or travel centers/gas chains wanting a multi-metro presence for a road-trip season. Mostly an admin-tooling and preset-bundling problem (define a "corridor" as a saved list of regions, define an "event window" as a saved date range) rather than new ad-serving logic. Rough price shape: **$199 for a 3-day event window**, **$499/mo for a 5–10 region corridor bundle**.
**Effort:** M/L
**Touches:** `ad_campaigns` (a bundle/preset type spanning multiple `featured_placements` rows across regions or a fixed window), admin UI for defining corridor region-sets and event date presets, no new disclosure pattern needed (each placement still labels itself per surface).

## 11. Conquest / Competitive Category Placement

A framing of the existing `SponsorSlot` "Sponsored · nearby" case (§2.3b of INAPP_ADS.md) sold explicitly to chains who want to appear on a *competitor's category* of listing — e.g., a taco chain buying visibility on other fast-food detail pages in the same region. Must stay **region-level, not address-level**, to respect the coarse-targeting constraint (no "target this specific competitor's exact listing" — that's precision-targeting a business, not a contextual region match, and risks feeling predatory rather than contextual). Rough price shape: same unit economics as Featured-in-Category (#4), **$15–25/week**, marketed with "conquest" language in the sales deck only, not in-product copy.
**Effort:** S/M
**Touches:** same RPC/category surface as #4, sales/marketing framing only — no new schema beyond #4's category dimension.

## 12. Starter Ad Pack (bundled discount for Solo advertisers)

Not a new placement — a pricing bundle that pairs one week of Featured-in-Category (#4) with the Storefront upgrade (logo/photos) at a discount versus buying each separately, aimed at the single-location Solo owner who doesn't want to evaluate five ad products and just wants "the ad thing." Mostly a checkout/marketing-page exercise; lowest differentiated value here since it repackages other items on this list, but it's the easiest upsell to put in front of every Solo signup. Rough price shape: **$15/mo bundle** (vs. ~$20 buying pieces separately).
**Effort:** S
**Touches:** checkout/pricing page only; no new ad-serving surface, depends on #4 existing first.

---

**Ranking logic:** #1–3 are ship-first because each is a thin packaging layer over placement primitives A7 already fully specified (creative jsonb, pin rendering, campaign bundling) — days not weeks of net-new surface. #4–8 need one new dimension each (category, brand-wide flag, venue/region exclusivity) but no new consent or trust model. #9–11 need the most care — a legal-copy pass (guarantee framing), multi-region bundling admin tooling, or conquest-framing guardrails — before they're safe to sell.
