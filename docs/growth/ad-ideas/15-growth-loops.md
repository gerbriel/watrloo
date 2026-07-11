# Advertiser Growth & Retention Loops — 15 Ranked Ideas

Additive to `docs/growth/{ADMIN_CRM,NEWSLETTER,ADVERTISER_CONSOLE,PRICING,EMAIL_DELIVERY}.md`. Nothing here duplicates the campaign builder, entitlement plumbing, or admin CRM already designed — these are the lifecycle/nudge/CRM-follow-up loops layered on top. Ranked by value-to-effort, highest first.

## 1. Admin CRM — Advertiser sales-signal queue

A new admin-only tab (`/admin/advertiser-signals`, seventh sibling to `ADMIN_CRM.md`'s six) that turns "manual billing v1 = growth means routing a human" into an actual worklist instead of an ideal. One read-only RPC joins `subscriptions`, `entitlement_usage`/`plan_features`, `ad_campaigns`, and `business_access_requests` to surface: trials ending soon with zero campaigns, entitlement near-exhausted (upsell candidate), `past_due` accounts (win-back candidate), high organic traffic with zero spend (expansion candidate), and stalled access requests (>48h open). No new tables — a view/RPC over rows that already exist, styled like `AdminCrm`'s `Kpi`/`Badge`/loading-error-empty idiom. Every other idea below that says "flags to admin" lands here; build this first so those flags have somewhere to go.

**Effort:** M
**Touches:** new `/admin/advertiser-signals` route + `AdminLayout` tab; `admin_list_advertiser_signals()` RPC over `subscriptions`, `plan_features`, `ad_campaigns`, `business_access_requests`, `campaign_daily`.
**Ship-first:** yes

## 2. In-console activation checklist

A small progress widget on the business Overview (`BusinessDashboard`/`BusinessLayout`) — "Verified claim ✓ · Logo added ✓ · First campaign — · First review reply —" — computed from data that already exists (`bathroom_claims.status`, `businesses.logo_url`, any `ad_campaigns` row, any `review_responses` row). No schema change, no cron, no email dependency, so it ships and delivers value immediately, unlike anything routed through Resend. Cheapest item on this list and the natural landing spot for every "go do X" CTA the other ideas generate.

**Effort:** S
**Touches:** `BusinessDashboard` Overview component; client-side derivation or a thin RPC over `bathroom_claims`, `businesses`, `ad_campaigns`, `review_responses`.
**Ship-first:** yes

## 3. "Promote your listing" honest recommendation card

The domain's own headline example, built directly on rollups A4/A5 already spec: a card on `BusinessAnalytics`/Overview that compares a listing's organic `bathroom_view`/`directions_tap` counts (`analytics_daily`) against its ad reach (`campaign_daily`) and only speaks when the data genuinely supports it — real views, no active campaign, entitlement still available. "Your Bakersfield listing got 340 organic views last month and you haven't run a campaign" is a fact, not a nudge manufactured to create urgency, which is what keeps it inside the no-dark-patterns constraint. Deep-links straight into `CampaignBuilder` Step ① prefilled with that listing.

**Effort:** M
**Touches:** new `advertiser_promote_recommendation(business_id)` RPC over `analytics_daily`, `campaign_daily`, `ad_campaigns`; card component on `BusinessAnalytics`/Overview; links into `CampaignBuilder`.
**Ship-first:** yes

## 4. Entitlement-reset / unused-allowance reminder

A factual banner (and later, optional email) when a business's monthly blast or weekly featured allowance is about to reset unused — "2 blasts left, resetting in 4 days." Unused paid allowance is a quiet churn signal (nobody renews what they never touched), and this is the cheapest possible intervention: pure math over `entitlement_usage`, no new inference, no urgency invented. The in-console banner ships standalone; an email variant is possible later but should wait behind item 6's lifecycle-email plumbing rather than being a one-off.

**Effort:** S/M
**Touches:** extends `EntitlementMeter`/`entitlement_usage` (A9/A10) with a computed "resets in N days, M unused" state; optional email reuses item 6's pipeline.
**Ship-first:** no

## 5. Post-campaign performance digest email

When a campaign hits `done` (or weekly while `running`), email the business's manager(s) the real numbers from the already-spec'd `campaign_stats`/`campaign_metrics` RPCs — delivered, reach, clicks, and honestly, `skipped_frequency_cap` too, since "we protect your audience's inbox" is itself a trust signal. Ends with one factual next step ("renew this campaign" / "try Featured next"), not a hard sell. This is the retention loop: proof of value is what keeps a manually-invoiced customer paying. Needs the Resend domain verified (`docs/ops/EMAIL.md`) before it can send to anyone but the account owner — design it now, gate the send on that.

**Effort:** M
**Touches:** cron hook off `ad_campaigns.status='done'` (extends A5's `sched_activate_due`); business-lifecycle send via an A6-pattern Edge Function; `campaign_stats`/`campaign_metrics` (A5/A10) as the data source.
**Ship-first:** no

## 6. Claim → first-campaign activation email sequence

The literal funnel this domain names: a Day 0/3/7/14 sequence keyed off `bathroom_claims.verified_at` and `subscriptions.status='active'`, nudging toward the first campaign the business already paid for (Solo includes 2 blasts/mo — activation here is mostly "help them cash a check they already wrote"). Content branches on the activation checklist (item 2) so a business that's already sent a blast doesn't get "send your first blast." This is B2B account mail, not consumer marketing, so it sits outside the 3-per-7-days consumer frequency cap — but it still needs an unsubscribe/preference control for hygiene and, like every email idea here, is blocked on Resend domain verification until then.

**Effort:** M
**Touches:** new pg_cron job + sibling Edge Function to `send-campaign-batch`; a `business_lifecycle_sends` table (mirrors `campaign_sends` shape) for idempotency; content keyed to item 2's checklist state.
**Ship-first:** no

## 7. Trial-ending conversion nudge + admin alert

Since every paid tier starts with a 14-day trial (`subscriptions.status='trialing'`), a 3-touch nudge (Day 10 / Day 13 / Day 15-past-due) that does double duty: emails the business, and — because there's no self-serve checkout yet — simultaneously writes a row into item 1's sales-signal queue so a human actually invoices them before the trial lapses silently. This is "growth means routing a human" in its most literal form: the email can't close the sale, only a person can, so the design's real deliverable is making sure that person finds out in time.

**Effort:** S/M
**Touches:** cron check on `subscriptions.status='trialing'` + `current_period_end`; writes to item 1's queue; email via item 6's pipeline.
**Ship-first:** no

## 8. Contextual upsell moments tied to entitlement + proof

`EntitlementMeter` already shows usage passively (A10 §5.6) and an "Upgrade" link when exhausted. This sharpens that into evidence-based moments: on `CampaignMetrics`'s `done` state, if the entitlement was fully consumed *and* the metrics show real reach/clicks, show "You used all 3 featured slots this week and reached 4,200 people — Growth gives you 3×." The gate is "did this plan actually deliver," never a countdown timer or manufactured scarcity — pure UI logic over data the console already fetched, no new RPC.

**Effort:** S
**Touches:** conditional card in `CampaignMetrics` `done` state and `EntitlementMeter`, gated on entitlement-exhausted + non-zero delivered metrics.
**Ship-first:** no

## 9. "Promote this listing" CTA on the business's own live page

When a manager views their own claimed listing at `/bathrooms/:id` (gated on `manages_bathroom`), show a private CTA — "This listing isn't running any promotion — boost it" — that deep-links into `CampaignBuilder` prefilled with that bathroom. This is the single highest-intent moment available: the owner is already looking at their own storefront. Small, cheap, and complements item 3 rather than duplicating it (this is placement-triggered, item 3 is data-triggered).

**Effort:** S
**Touches:** `BathroomDetail.tsx`, gated on `manages_bathroom(bathroom_id)`; links to `/business/:businessId/campaigns/new?bathroom_id=...`.
**Ship-first:** no

## 10. Real-inventory-scarcity nudge

Featured slots are genuinely scarce — `featured_inventory`/the exclusion constraints in `CAMPAIGNS.md` §3.3 make oversell physically impossible. Surface that truth in `FeaturedSlotPicker` ("2 of 3 browse slots booked this week in Fresno") instead of leaving it implicit in a disabled calendar cell. Because the scarcity is real (a DB constraint, not a countdown timer), this is honest urgency, not a dark pattern — it's just better copy on an RPC (`list_featured_availability`) that already exists.

**Effort:** S
**Touches:** copy/data-surfacing change in `FeaturedSlotPicker` (A10 §5.4) over the existing `list_featured_availability` output.
**Ship-first:** no

## 11. Win-back sequence for lapsed/canceled subscriptions

When `subscriptions.status` flips to `canceled`, a Day 7/30/90 sequence pulling a *real* number for that business's listings ("still getting X views this month — reactivate to promote again") rather than a generic "we miss you." High-value churned accounts (former Chain tier, multi-location) also drop into item 1's sales-signal queue so a person calls instead of relying on email alone. Shares item 6's lifecycle pipeline and the same domain-verification dependency.

**Effort:** M
**Touches:** cron on `subscriptions.status → 'canceled'` transitions; pulls `analytics_daily`/`bathroom_stats`; feeds item 1's queue for high-value accounts; reuses item 6's send pipeline.
**Ship-first:** no

## 12. Multi-location rollup digest + expansion nudge

For Growth/Chain businesses, a monthly rollup across *all* claimed locations ("across your 5 locations: X views, Y clicks, Z reviews") rather than per-campaign noise — a pride/retention loop for owners managing a portfolio from one dashboard. The expansion nudge ("you're at 4 of 5 locations") only fires when the ratio is genuinely high, mapping straight onto `PRICING.md`'s "adding a location is the upgrade" story rather than inventing a reason to upsell.

**Effort:** M
**Touches:** monthly cron for businesses with `plan_features.max_locations > 1`; aggregates `bathroom_stats`/`analytics_daily` across a business's `bathroom_claims`; reuses item 6's pipeline.
**Ship-first:** no

## 13. Referral credit program

"Refer another business, both get a credit." Since Stripe doesn't exist yet, a credit is a manually-applied ledger row (`referral_credits`: referrer, referred, credit type/amount, status, applied-by-admin) — the same manual-billing shape already used for `subscriptions.status`, not a checkout flow. A "Refer a business" panel in `BillingPlan` generates a code that pre-fills a new `business_access_requests` row with `referred_by`, so admin sees the referral chain right where they already review requests. Strong fit for hyperlocal business clusters (a strip mall, a downtown) where CAC is otherwise word-of-mouth anyway.

**Effort:** M
**Touches:** new `referral_credits` table; panel in `BillingPlan` (A10 §5.8); `referred_by` on `business_access_requests`; admin applies credit by hand.
**Ship-first:** no

## 14. Detractor-triggering satisfaction check-in

A single-question survey ("How likely are you to recommend Watrloo ads to another business owner, 0–10") shown once on a completed campaign's `CampaignDetail`. Scores ≤6 auto-drop into item 1's sales-signal queue for a save call; high scores are exactly the businesses item 13's referral program should target next. Cheap, and it closes the loop between "we think this campaign worked" (item 5's digest) and "did it actually feel worth it to them."

**Effort:** S/M
**Touches:** small `advertiser_feedback` table; one-question component on `CampaignDetail` `done` state; low scores insert into item 1's queue.
**Ship-first:** no

## 15. Unclaimed-listing outreach lead list (supply-side)

Admin-only report joining unclaimed `bathrooms` with high organic `bathroom_view` counts against regions that already have active paying advertisers — "these 12 unclaimed high-traffic bathrooms sit in regions where we already have 3 paying businesses; good cold-outreach targets." This extends the claim funnel from the supply side rather than the activation side: it's the list a human works before the request-to-approve pipeline in `docs/ops/BUSINESS_ACCOUNTS.md` §2 even starts. Lowest urgency of the fifteen — useful once the sales-signal queue (item 1) exists to house it, not before.

**Effort:** M
**Touches:** admin RPC/view joining unclaimed `bathrooms`, `analytics_daily`, and regional `subscriptions` density; surfaces in item 1's queue or its own admin tab.
**Ship-first:** no

---

**Top picks.** Ship the sales-signal queue, the activation checklist, and the promote-your-listing card first — all three are pure in-console reads over data the platform already collects, so none of them wait on the Resend domain-verification fix that gates every email-based idea here. Together they turn "manual billing v1" from a bottleneck into a working growth loop: the checklist and recommendation card create the nudge, the sales-signal queue makes sure a human sees it. Everything else in this list either feeds that queue or extends its email counterpart once domain verification lands.
