# Ad Platform — Feature Ideas (15-domain survey)

**Status: idea corpus + synthesis, 2026-07-11.** Fifteen parallel research
agents each owned one domain of the ad platform, read the existing
`docs/growth/` designs *and the actually-shipped code*, and produced a ranked,
effort-tagged idea list. The full lists — **208 ideas** — live in
[`ad-ideas/`](./ad-ideas/) (one file per domain, preserved verbatim). This
document is the synthesis: what the survey converged on, and a build order.

| # | Domain (file) | Ideas | Top ship-first pick |
|---|---|---|---|
| 01 | [Creative & formats](./ad-ideas/01-creative.md) | 13 | Render the logo badge already in the data |
| 02 | [Tracking pixel & attribution](./ad-ideas/02-pixel.md) | 15 | UTM auto-tagging on outbound creative links |
| 03 | [Click & engagement analytics](./ad-ideas/03-click-analytics.md) | 16 | Close the `BusinessAnalytics` placeholder with real organic engagement |
| 04 | [Targeting & placement](./ad-ideas/04-targeting.md) | 10 | Real PostGIS radius targeting on `active_featured` |
| 05 | [Budgets, pacing & billing](./ad-ideas/05-budgets.md) | 14 | Advertiser ad-credit ledger ("ad wallet") |
| 06 | [Campaign lifecycle UX](./ad-ideas/06-lifecycle.md) | 14 | Edit a rejected campaign (impossible today) |
| 07 | [A/B testing & optimization](./ad-ideas/07-ab-testing.md) | 14 | Two-variant creative + session-seeded split |
| 08 | [Reporting & exports](./ad-ideas/08-reporting.md) | 15 | CSV export off the existing rollup |
| 09 | [Fraud & brand safety](./ad-ideas/09-fraud-safety.md) | 15 | The ad-event ledger (the missing foundation) |
| 10 | [Privacy-first measurement](./ad-ideas/10-privacy.md) | 13 | "Why am I seeing this ad?" affordance |
| 11 | [Local-SMB ad products](./ad-ideas/11-smb-products.md) | 12 | Coupons & offers ("show this for 10% off") |
| 12 | [Foot-traffic attribution](./ad-ideas/12-foot-traffic.md) | 13 | Single-use redemption codes + cashier console |
| 13 | [Serving architecture](./ad-ideas/13-serving-arch.md) | 14 | Server-side ad selection/rotation |
| 14 | [Creative asset pipeline](./ad-ideas/14-asset-pipeline.md) | 15 | `campaign-creatives` bucket + business-scoped RLS |
| 15 | [Advertiser growth loops](./ad-ideas/15-growth-loops.md) | 15 | Admin CRM sales-signal queue (manual billing, operationalized) |

---

## What the survey converged on (reality checks)

Multiple agents, working independently, hit the same findings. These gate
everything else:

1. **The design docs are far ahead of the shipped code.** `ANALYTICS.md`
   designs an `analytics_events` pipeline and `RATE_LIMITING.md` a
   `check_rate_limit` — **neither exists in any applied migration**.
   `FeaturedCard` logs zero impressions and zero clicks. There is currently
   no data behind any CTR number we might show.
2. **The live `active_featured()` RPC doesn't actually pick ads.**
   `Explore.tsx` renders `featured[0]` from a `starts_at`-ordered list: no
   rotation, no region matching, no capacity enforcement. Map and detail
   surfaces exist only as enum values.
3. **Campaign lifecycle has real holes:** a rejected campaign cannot be
   edited or resubmitted (no update RPC exists); advertisers cannot pause
   their own campaign; the create RPC accepts `starts_at`/`ends_at` but the
   UI never sends them, so the "scheduled" state is unreachable.
4. **The privacy docs disagree with each other:** three different
   k-anonymity floors (5 / 25 / 30) appear across `ANALYTICS.md`,
   `COMPLIANCE.md`, and `CAMPAIGNS.md`. Pick one number before shipping any
   advertiser-facing count.
5. **Low volume changes the statistics.** Local campaigns get tens-to-
   hundreds of clicks. Naive CTR percentages and p-value A/B tests will lie;
   Bayesian credible intervals and bandits are the honest tools (07).
6. **Manual billing shapes the products.** Flat-rate packages, a credit
   ledger, and an invoice line-item table (Stripe-ready but human-driven)
   beat any auction mechanics for v1 (05, 11, 15).

## Synthesized build order

**Phase 0 — fix what's already shipped (days).**
Edit-rejected-campaign RPC, advertiser self-pause/resume, wire the date
pickers (06 #1–3); render the logo badge (01 #1); extend the existing
ReportButton to ads (09 #2).

**Phase 1 — the measurement foundation (the unblocker).**
`ad_events` table + `record_ad_event` RPC + daily rollups and short raw
retention (09 #1, 13 #2, 13 #8); move selection server-side with rotation
and capacity (13 #1, #6); then the first honest dashboards: per-surface
breakdown, CSV export, date-range comparison (03 #2, 08 #1, #3). Everything
in phases 2–4 reads from this.

**Phase 2 — creative & placement (make ads worth buying).**
`campaign-creatives` bucket + uploader + admin image approval, mirroring the
review-photos pipeline (14 #1–3); controlled CTA vocabulary + link preflight
(01 #3, #9); PostGIS radius targeting and the detail-page `SponsorSlot`
(04 #1–2); auto-fallback creative from the listing's own photos (01 #2).

**Phase 3 — attribution & optimization (prove it works).**
UTM auto-tagging + `wtlclid` click ID (02 #1–2); conversion postback Edge
Function (02 #3); two-variant A/B with Bayesian intervals and a
Thompson-sampling toggle (07 #1–3); coupons + single-use redemption codes
with the cashier console (11 #1, 12 #1–3) — the foot-traffic proof that
closes local sales.

**Phase 4 — monetization & growth machinery.**
Credit ledger, budget caps with auto-pause, invoice line items (05 #1–3);
packaged SMB products: pin skins, grand-opening boost, featured-in-category,
city sponsorship (11 #2–4, #7); sales-signal CRM queue + activation
checklist + the honest "promote your listing" card (15 #1–3).

**Cross-cutting, do alongside:** one k-anonymity floor everywhere (10 #3);
"why am I seeing this ad" (10 #1); invalid-traffic filtering before any
billed metric (09 #4–6).

## Constraints every idea respects

Static SPA + Supabase (RLS enforced; anon key public; Edge Functions are the
only private compute). Ads are contextual, always labeled "Sponsored", never
push. **Ads never touch, reorder, or influence reviews and ratings.** No
behavioral profiles — contextual signals only, and that's a marketing
strength. Manual billing v1 with a clean Stripe upgrade path.
