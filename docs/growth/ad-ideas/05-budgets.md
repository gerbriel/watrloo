# Budgets, Pricing Models, Pacing & Billing — Feature Ideas

Context this builds on: `PRICING.md` already nails the *subscription* shape (Solo/
Growth/Chain/Enterprise, allowance + opt-in overage, manual-now/Stripe-later). What's
missing is the *ads-specific* layer on top: nothing in the current design gives an
advertiser a dollar-denominated budget, a spend cap, a credit balance, or a CPM/CPC
option — `ad_campaigns` has no `budget_cents` field, overage is "admin invoices it
after the fact," and `ABUSE_AND_LIMITS.md` explicitly flags "CPC/CPM math (A9/Stripe
phase)" as unresolved. These 13 ideas are additive to PRICING.md, not a rewrite of it,
and every one keeps billing manual-first (admin action = ledger/status write) with a
Stripe webhook swapped in later writing the same rows.

---

## 1. Advertiser ad-credit ledger ("ad wallet")

An append-only `ad_credit_entries` table (`business_id`, `delta_cents`, `reason` enum
`'manual_topup'|'promo_redeem'|'referral'|'refund_goodwill'|'overage_debit'|
'committed_drawdown'`, `reference_id`, `created_by`, `created_at`) with balance derived
via `ad_credit_balance(business_id)`. In manual v1, the admin calls
`admin_credit_business_wallet(business_id, cents, note)` after receiving payment
out-of-band — the same motion as flipping `subscriptions.status` today. Overage
consumption (extra blast recipients, extra featured week, extra newsletter slot) now
*debits* the ledger atomically via `debit_ad_credit(...)`, which raises if the balance
would go negative — real server-side enforcement instead of "admin remembers to bill
it later." This is the single substrate that ideas 4 (rate card), 9 (coupons), 12
(goodwill credits), and 13 (Enterprise committed spend) all build on, and the Stripe
upgrade path is trivial: a Checkout "buy $50 ad credit" just calls the same RPC from
the webhook.

**Effort:** M
**Touches:** new table `ad_credit_entries`; RPCs `ad_credit_balance`,
`debit_ad_credit`, `admin_credit_business_wallet`; `assert_can_launch_blast` overage
branch (PRICING.md §5); ADVERTISER_CONSOLE `BillingPlan` component
**Ship-first:** yes

---

## 2. Per-campaign budget cap with server-side auto-pause

Add `ad_campaigns.budget_cents_daily` / `budget_cents_lifetime` (nullable,
advertiser-set like `starts_at`/`ends_at`) plus a `campaign_notional_spend(campaign_id)`
function that translates consumed allowance/overage into cents using the existing
overage rates ($5/1,000 recipients, $15/featured activation, from PRICING.md §5).
`sched_reconcile` — which already runs every 15 min per CAMPAIGNS.md §4 — gains a
check: once notional spend crosses the cap, flip `status → 'paused'` and write a
`moderation_actions` row with `actor_id = NULL, detail.via = 'scheduler'`, exactly
matching how every other scheduler-driven transition is already audited. This is the
direct answer to "spend caps and auto-pause" — enforcement lives in the same
`SECURITY DEFINER` cron function as `sched_activate_due`, never in the client, and
reuses the `running → paused` edge the state machine already has.

**Effort:** M
**Touches:** `ad_campaigns` new columns; `sched_reconcile()` (CAMPAIGNS.md §4);
`moderation_actions`; ADVERTISER_CONSOLE campaign status card
**Ship-first:** yes

---

## 3. Manual invoice line-item ledger

New `business_invoices` (`id`, `business_id`, `period_start/end`, `status`,
`total_cents`) + `invoice_line_items` (`kind` enum `'subscription'|
'overage_recipients'|'overage_featured'|'overage_newsletter'|'extra_location'|
'extra_seat'|'credit_applied'|'adjustment'`, `description`, `quantity`, `unit_cents`,
`amount_cents`). Instead of the admin mentally tracking "what did I actually bill this
business," the system pre-populates a draft invoice each period from the month's
recorded overage events + the plan base price, the admin reviews/adjusts it, arranges
payment out-of-band, and marks it `paid` — an auditable record replaces institutional
memory. It maps 1:1 onto Stripe `Invoice` + `InvoiceItem` for phase 2 (create the
Stripe objects from the same rows instead of Postgres rows), so nothing here is thrown
away when Stripe lands.

**Effort:** S–M
**Touches:** new tables `business_invoices`, `invoice_line_items`; admin CRM UI;
PRICING.md §6 phase-2 Stripe mapping
**Ship-first:** yes

---

## 4. Overage rate card as live config data

Move the hardcoded prices in PRICING.md §5 ($5/1,000 recipients, $15/featured
activation, $25/newsletter slot, $6/$4 per extra location) out of the doc and into an
`overage_rates(feature_key, unit_cents, unit_label, plan_key nullable)` table, read by
the same `entitlement_*` RPC family. Lets the admin retune pricing without a deploy and
grant a negotiated Enterprise rate per business (`plan_key` override). Small and
low-risk, but every dollar-figure idea above (ledger debits, budget-cap conversion,
invoice unit prices) should read from here instead of a magic number baked into three
different places.

**Effort:** S
**Touches:** new table `overage_rates`; `entitlement_int`/`entitlement_text` reader
pattern (PRICING.md §4)
**Ship-first:** no

---

## 5. Pre-flight cost estimate + confirmation gate at submission

Before `advertiser_submit_campaign` (CAMPAIGNS.md §1.3, §2.4) accepts a campaign that
will draw overage, compute the estimated dollar cost using idea 4's rate card and
require an explicit acknowledgment (`p_ack_overage_cost boolean`, stored as
`overage_ack_at`) before it can move to `pending_review`. PRICING.md §5 already states
the goal — "no surprise bills" — this makes it literal by putting the number in front
of the advertiser at the exact decision point instead of burying it in next month's
invoice line item.

**Effort:** S
**Touches:** `advertiser_submit_campaign` RPC; ADVERTISER_CONSOLE submit flow
**Ship-first:** no

---

## 6. Flat-rate city/region sponsorship product

Formalizes the "city sponsorship" idea BUSINESS_ACCOUNTS.md §6 already names but never
specs: sell a whole-region `map` (or `browse`) surface as a fixed-fee bundle — e.g.
"$200 for 4 weeks" — rather than metering per activation. No new pricing math needed:
it's one `invoice_line_items.kind='sponsorship'` row (idea 3) plus a batch insert of
`featured_placements` rows for the committed weeks, reserved through the exclusion-
constraint / advisory-lock anti-oversell path CAMPAIGNS.md §3.3 already built. Cheap to
ship because the scarcity/booking mechanics exist; only the "sell as a bundle" SKU is
new — a good match for PRICING.md's stated preference for predictable, non-metered
pricing over surprise-prone usage billing.

**Effort:** S–M
**Touches:** `featured_placements`, `featured_inventory` (CAMPAIGNS.md §3.3);
`invoice_line_items`; admin booking flow
**Ship-first:** no

---

## 7. Business-level aggregate monthly spend cap

A `business_spend_limits(business_id, monthly_cap_cents)` row — settable by the
business owner (self-protection) or admin (protecting a client from bill shock) —
checked in the same gate family as `assert_can_launch_blast`, summing the month's
`campaign_notional_spend` (idea 2) *across all* the business's campaigns and blocking
new overage-drawing submissions once the aggregate cap is hit, independent of any
single campaign's own budget. This is the portfolio-level counterpart to idea 2's
per-campaign cap: same enforcement pattern, same `(select …)` InitPlan-hoist style
already used everywhere else in the codebase, just a wider scope.

**Effort:** S–M
**Touches:** new table `business_spend_limits`; extends `assert_can_launch_blast`-style
RPC family (PRICING.md §4)
**Ship-first:** no

---

## 8. CPM/CPC "boost" pricing for featured placements

ABUSE_AND_LIMITS.md line 594 explicitly flags "CPC/CPM math (A9/Stripe phase)" as an
open item — this is that design. Offer an alternative to the count-based
`featured_per_week` allowance: an advertiser buys a lifetime budget (e.g. $100) for a
featured slot-week at a fixed effective CPM (e.g. $8/1,000 impressions), the platform
counts impressions already logged to `analytics_events` (A7/CAMPAIGNS.md §5.3) against
that budget, and auto-pauses (idea 2) once the implied impression count is delivered.
Because featured inventory is fixed slot-weeks (§3.3's 1/3/1 capacity model), impression
volume is naturally bounded — CPM here never carries the runaway-cost risk open-ended
ad-network CPM does. Highest effort in this list (new pricing model, impression
reconciliation, interaction with the anti-monopoly fairness cap in ABUSE_AND_LIMITS
§3), but it's the most "real ads platform" feature here and the direct self-serve
answer to Yelp/Nextdoor-style boost spend PRICING.md §0 benchmarks against.

**Effort:** L
**Touches:** `ad_campaigns` (new `pricing_model` enum); `analytics_events` impression
counting; `featured_inventory`; ABUSE_AND_LIMITS.md §3 fairness interaction; idea 2's
auto-pause
**Ship-first:** no

---

## 9. Promo / coupon codes

A `promo_codes` table (`code`, `kind` enum `'trial_extension'|'ad_credit'|
'plan_discount'`, `value`, `max_redemptions`, `expires_at`) plus a
`redeem_promo_code(code)` RPC a business manager calls, server-validated (single-use,
not expired, not already redeemed by this business). Credits idea 1's ledger or extends
the trial by pushing `subscriptions.current_period_end` (a column that already exists).
Cheap acquisition lever ("$50 ad credit on your first campaign," referral rewards) that
rides entirely on rails ideas 1 and the existing `trialing` status machinery already
provide — no new billing concept, just a redemption gate in front of it.

**Effort:** S–M
**Touches:** new table `promo_codes`; RPC `redeem_promo_code`; `ad_credit_entries`
(idea 1); `subscriptions.current_period_end`
**Ship-first:** no

---

## 10. Daily budget pacing (anti-frontload delivery)

Once any dollar budget exists (idea 2 or 8), naive delivery burns the whole daily
allotment in the very first `sched_dispatch_blasts` tick (every 5 min per CAMPAIGNS.md
§4). Pace it: divide `budget_cents_daily` (or featured activations) across the
remaining ticks in the local send window (§4.4's 09:00–20:00) so spend lands roughly
evenly rather than all at 9:00 sharp. This directly mirrors the platform-wide
`claim_platform_send_budget` atomic-claim pattern ABUSE_AND_LIMITS.md already
implements for the daily email quota — same mechanism, scoped to one campaign instead
of the whole platform, so the implementation risk is well-precedented rather than
novel.

**Effort:** M
**Touches:** `sched_dispatch_blasts`; per-campaign budget columns (idea 2);
`claim_platform_send_budget`-style atomic claim, adapted per-campaign
**Ship-first:** no

---

## 11. Dunning / grace-period sequence for `past_due` subscriptions

Because v1 billing is entirely manual (admin hand-sets `subscriptions.status`), a late
or forgotten payment risks either the admin forgetting to revoke (free-service leak) or
forgetting to reinstate promptly (angry customer — `manages_bathroom()` already hard-
gates on `status in ('active','trialing')` per BUSINESS_ACCOUNTS.md §3). Add
`subscriptions.grace_until` and a small cron job that emails the business before a
known renewal lapses, then again when `status` flips to `past_due`, with a short grace
window before paid features actually lock. Purely operational resilience around the
existing manual process — no new billing logic, just a buffer so a human forgetting to
click a button doesn't instantly cost a customer.

**Effort:** S–M
**Touches:** `subscriptions.grace_until`; new small pg_cron job; EMAIL_DELIVERY.md
transactional send path
**Ship-first:** no

---

## 12. Goodwill / refund credit issuance by admin

When a campaign under-delivers (inventory outage, a targeting bug, a takedown
mid-flight), today's only recourse is an out-of-band refund with no record. Once idea
1's ledger exists, `admin_issue_goodwill_credit(business_id, cents, reason,
reference_campaign_id)` credits the wallet with `reason='refund_goodwill'` and audits
to `moderation_actions` in the same transaction — "we owed them a credit for the
outage" becomes a queryable fact instead of an admin's memory. Trivial once the ledger
ships; sequence it immediately after idea 1.

**Effort:** S
**Touches:** RPC `admin_issue_goodwill_credit`; `ad_credit_entries` (idea 1);
`moderation_actions`
**Ship-first:** no

---

## 13. Committed-spend prepaid contracts (Enterprise)

PRICING.md §1 already positions Enterprise as "custom, sold by conversation" but gives
it no mechanism. Let an Enterprise contract prepay a lump sum (e.g. $6,000/quarter)
that draws down against idea 1's ledger with `reason='committed_drawdown'`, and give
the admin CRM a burn-rate view so the account owner can start the renewal conversation
before the balance hits zero — instead of the account silently losing access mid-
quarter or the admin manually tracking a spreadsheet. Operationalizes the existing
"not self-serve" Enterprise story with zero new billing machinery: same ledger,
different label on the entries.

**Effort:** M
**Touches:** `ad_credit_entries` (idea 1); admin CRM Enterprise account view
**Ship-first:** no

---

## Top picks

**#1 Ad-credit ledger, #2 per-campaign budget + auto-pause, and #3 invoice line
items** ship first because they're the load-bearing trio: the ledger turns overage from
"admin remembers to bill it" into a server-enforced balance, the budget cap is the
literal "spend caps and auto-pause" ask with zero new state-machine edges, and the
invoice table makes manual billing auditable today while mapping 1:1 onto Stripe
Invoice objects tomorrow. Every other idea here (coupons, goodwill credits, Enterprise
commits, CPM boost) is a thin RPC on top of these three, not a new subsystem.
