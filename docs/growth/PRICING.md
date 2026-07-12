# Watrloo — Pricing & Packaging (A9)

> **Display names.** The tiers ship under themed names on the pricing page and
> in `plans.name`: Solo = **Lone Throne**, Growth = **Royal Flush**, Chain =
> **Porcelain Empire**, Enterprise = **Grande Armée**. This doc (and the
> `plans.key` values everywhere in code and SQL) keep the internal names.

**Summary.** Four subscription tiers — **Solo ($10/mo), Growth ($39/mo), Chain
($149/mo), Enterprise (custom)** — where a single-location shop gets the *whole*
toolkit (claim + manage listing, respond to reviews, a modest blast + featured
allowance, basic analytics) and the ONE thing that unlocks higher tiers is
**scale**: more locations, higher blast/featured volume, team seats, deeper
analytics, bulk import, and API. Blasts & featured placements are an **included
monthly allowance with optional pay-as-you-go overage**, with recipient ceilings
sized so worst-case email cost never eats a tier's margin. Billing is **manual
invoicing in phase 1** (admin flips `subscriptions.status` today) and a **Stripe
Checkout + metered-overage + webhook** design for phase 2.

**Dependencies.** Builds on `docs/ops/BUSINESS_ACCOUNTS.md` and
`supabase/migrations/20260711000000_business_accounts.sql` (`subscriptions`,
`bathroom_claims`, `business_members`, `manages_bathroom()`). Consumes the
canonical model from **A2 DATA_MODEL** (`plans`, `plan_features`, `ad_campaigns`,
`campaign_sends`, `featured_placements`, `newsletter_editions`). Coordinates email
cost ceilings with **A6 EMAIL_DELIVERY** and **A13 SCALING_COST**; the per-user
frequency cap with **A1 COMPLIANCE** / **A12 ABUSE_AND_LIMITS**; featured inventory
with **A7 INAPP_ADS**; newsletter inventory with **A8 NEWSLETTER**; analytics depth
with **A4 ANALYTICS**; and plan/usage surfacing with **A10 ADVERTISER_CONSOLE**.
Campaign creation is gated by **A5 CAMPAIGNS** calling the entitlement RPCs in §4.

> Everything here is a DESIGN. No live prices, no Stripe account, no DB changes.
> Numbers are USD; cents are the storage unit.

---

## 0. What we are actually selling (and the price frame)

Watrloo isn't selling "listing management" — Google Business Profile gives that
away free (claim, edit facts, respond to reviews, basic insights, all $0
[[Google]](https://business.google.com/us/business-profile/)). We're selling
**reach into Watrloo's opted-in, location-aware audience**: featured placements
in-app, geo-targeted promotional email blasts, and newsletter slots — bundled with
the listing tools so a small owner never has to think about it. That framing sets
the anchors:

| Comparable | What it costs | Read-across for us |
|---|---|---|
| **Google Business Profile** | Free listing + reviews + basic insights [[src]](https://business.google.com/us/business-profile/) | We must bundle listing tools cheaply — they're table stakes, not the product. |
| **Nextdoor** | Free business page (2 posts/mo, 2-mi reach); Local Deals from **$1/day**, avg deal ~**$75**; neighborhood sponsorship **$32–$150/mo per ZIP** [[src]](https://business.nextdoor.com/en-us/small-business) | A recurring **$10/mo bundle** sits right at Nextdoor's low end, but recurring and all-inclusive. |
| **Yelp Ads** | ~**$5/day** minimum; SMBs typically **$300–$1,000/mo**; full-feature average ~**$899/mo**; CPC **$2–$20** [[src]](https://business.yelp.com/resources/articles/ad-cost/) | Our whole **Solo year ($100)** costs less than **one day** of an average Yelp campaign. That's the pitch. |
| **Agency GBP management** | **$125–$475/mo** just to *manage* a free profile [[src]](https://www.merchynt.com/post/google-my-business-management-pricing) | Confirms SMBs already pay low-hundreds/mo for local presence; $10–$39 is friendly, not cheap-looking. |

**Design stance:** price the small owner like a friend ($10, most features), price
scale like a business input (locations, seats, volume, API). We never withhold a
*core tool* to force an upgrade — we gate *quantity*.

---

## 1. The tiers

Monthly, billed monthly. **Annual = 10× monthly (two months free, ~17% off).**
All paid tiers start with a **14-day trial** (`subscriptions.status = 'trialing'`,
already supported) — full features, capped at Solo allowances until the first
invoice clears.

### Solo — **$10/mo** ($100/yr)
- **Positioning:** "Your restroom is a front door. Own it." The complete toolkit
  for one location at the price of two coffees.
- **Target buyer:** an independent cafe, gas station, gym, bar, boutique — a
  single-location owner-operator.
- **Includes:** 1 location; claim + verified "Official" badge; full listing/facts
  editing; **respond to reviews**; **2 email blasts/mo** (≤2,000 recipients each);
  **1 featured placement/week**; **basic analytics**; 2 team seats.
- **The one gate:** cannot add a second location. Adding a location *is* the
  upgrade to Growth (see §3). Nothing else about Solo feels second-class.

### Growth — **$39/mo** ($390/yr)
- **Positioning:** "A few doors, one dashboard." For the owner whose one shop
  became three.
- **Target buyer:** a local mini-chain, a small franchise group, a regional
  operator with **2–5 locations**.
- **Adds over Solo:** up to **5 locations** (+$6/mo per extra location, up to 15,
  then move to Chain); **6 blasts/mo** (≤5,000 each); **3 featured/week**;
  **1 newsletter slot/mo**; **standard analytics** (trends, near-me impressions,
  blast open/click, CSV export of your own aggregates); **CSV bulk import**;
  **5 seats**; email support.
- Per-location math: **<$8–$13/location/mo**, an order of magnitude under Yelp's
  mid-range ($1,000–$2,500/mo [[src]](https://business.yelp.com/resources/articles/ad-cost/)).

### Chain — **$149/mo** ($1,490/yr)
- **Positioning:** "Every location, programmatically." Bulk tools, seats, and an
  API for operators who manage locations as a portfolio.
- **Target buyer:** a regional/multi-metro chain, a franchisor, a facilities/
  marketing team with **6–25 locations**.
- **Adds over Growth:** up to **25 locations** (+$4/mo per extra, up to 100, then
  Enterprise); **20 blasts/mo** (≤15,000 each); **3 featured/week per location**
  (still subject to the platform's global weekly fairness cap — A12);
  **3 newsletter slots/mo**; **advanced analytics** (per-location comparison,
  review sentiment, funnel, longer retention); **read API access**;
  **15 seats**; **priority support**.
- Per-location math at 25 locations: **~$6/location/mo** — cheaper than a single
  Nextdoor neighborhood sponsorship [[src]](https://business.nextdoor.com/en-us/small-business).

### Enterprise — **custom (from ~$500/mo)**
- **Positioning:** "National footprint, your terms." Volume pricing, SLA,
  onboarding, and data pipes.
- **Target buyer:** national chains, large franchisors, agencies reselling to many
  brands — **25+ (often hundreds) of locations**.
- **Adds over Chain:** unlimited locations; **custom blast/featured/newsletter
  allowances**; **advanced analytics + raw/warehouse export**; write/bulk API;
  SSO/SAML (future); dedicated IP for deliverability (Resend $30/mo add-on for
  senders >3k/day [[src]](https://resend.com/pricing)); named support + contract
  SLA; custom seats.
- **Not self-serve.** `plans.is_public = false`; sold by conversation, priced to
  the footprint and blast volume (email cost dominates at this scale — see §5).

### Why bucketed tiers, not pure per-location (answers BUSINESS_ACCOUNTS §8)

Pure per-location pricing punishes exactly the buyer we want most (chains) and
makes the CSV-import UX hostile (a 500-row upload = a 500-line invoice). A **flat
base per tier + a small per-location overage inside each bucket** keeps invoices
predictable, rewards scale with a declining per-location rate ($10 → ~$8 → ~$6),
and gives a natural, non-punitive nudge to the next tier when a bucket fills.

---

## 2. Feature matrix

Rows are capabilities; the differentiator is **scale/volume**, never withholding a
core tool. Everything a Solo owner needs to run one listing well is in Solo.

| Capability | **Solo** $10 | **Growth** $39 | **Chain** $149 | **Enterprise** custom |
|---|---|---|---|---|
| **Locations** (claimed listings) | **1** | up to **5** (+$6/extra→15) | up to **25** (+$4/extra→100) | **unlimited** |
| Claim + verified "Official" badge | ✅ | ✅ | ✅ | ✅ |
| Edit listing facts / enhanced storefront | ✅ | ✅ | ✅ | ✅ |
| **Respond to reviews** (owner reply) | ✅ | ✅ | ✅ | ✅ |
| Report reviews into mod queue | ✅ | ✅ | ✅ | ✅ |
| **Email blasts / month** | **2** | **6** | **20** | custom |
| Max recipients / blast (cost ceiling) | 2,000 | 5,000 | 15,000 | custom |
| **Featured placements / week** | **1** | **3** | **3 per location** | custom |
| **Newsletter slots / month** | 0¹ | 1 | 3 | custom |
| **Analytics depth** | Basic | Standard | Advanced | Advanced + export |
| **Team seats** (`business_members`) | 2 | 5 | 15 | custom |
| **CSV bulk import** (already built) | — | ✅ | ✅ | ✅ |
| **API access** | — | — | Read | Read/Write + bulk |
| **Priority support** | Community/email | Email | Priority | Dedicated + SLA |
| **Overage credits** (§5) | ✅ | ✅ | ✅ | contract terms |

¹ Newsletter slots are **scarce, curated ad inventory** (A8), not a core listing
tool — reserving them for higher tiers is a scale differentiator, not a
withheld feature. Solo owners can still *buy* a one-off slot as overage when
inventory allows.

**Two caps that override any allowance above** (both server-enforced, both owned
elsewhere — restated so nobody double-designs):
- **Per-user frequency cap:** a user receives **≤3 promotional messages per 7
  days** regardless of how many businesses target them (A1/A12). A blast's
  *effective* reach is post-suppression, post-frequency-cap — always ≤ the
  recipient ceiling above.
- **Global featured fairness cap:** featured activations are also limited per
  advertiser slot per week platform-wide (A7/A12); a tier's `featured_per_week`
  is a ceiling *within* that, not on top of it.

**Analytics tiers** (A4 owns the metrics; this is the packaging):
- **Basic** — listing views, review count, current rating, blast delivered/sent
  counts.
- **Standard** — the above + 90-day trends, "near me" impressions, blast
  open/click rates, CSV export of your own aggregates.
- **Advanced** — the above + per-location comparison, review sentiment over time,
  view→direction-tap funnel, 13-month retention.
- **+ Export** (Enterprise) — scheduled CSV / warehouse sync of your own
  aggregates (never other advertisers', never raw user rows — that's admin-only
  per the contract's RLS rule).

---

## 3. Entitlements as data (`plans` + `plan_features`)

The matrix compiles to two tables the code reads at runtime. **A2 owns the final
schema** — this is the PRICING spec of it (`REQUEST TO A2`: add these two tables
and FK `subscriptions.plan → plans.id`; today `subscriptions.plan` is free text
defaulting `'standard'`, so also migrate existing `'standard'` rows → `'solo'`).

```sql
-- One row per tier. Prices in cents. Enterprise is is_public = false.
create table public.plans (
  id                text primary key,           -- 'solo' | 'growth' | 'chain' | 'enterprise'
  name              text not null,
  monthly_cents     int  not null,
  annual_cents      int,                         -- null for custom/enterprise
  sort              int  not null,               -- display order
  is_public         boolean not null default true,
  stripe_price_id_monthly text,                  -- null until phase 2 (§6)
  stripe_price_id_annual  text
);

-- EAV of entitlements the code checks. One typed column is used per key.
-- unlimited = true  ->  "no cap" (callers treat the numeric value as null/∞).
create table public.plan_features (
  plan_id     text not null references public.plans (id) on delete cascade,
  key         text not null,                     -- see the key list below
  int_value   int,
  bool_value  boolean,
  text_value  text,
  unlimited   boolean not null default false,
  primary key (plan_id, key)
);
grant select on public.plans, public.plan_features to anon, authenticated;
-- RLS: plans/plan_features are world-readable reference data (the pricing page
-- and the advertiser console both render them); writes are service_role/admin only.
```

**The entitlement keys the code checks** (stable contract for A5/A7/A8/A10):

| key | type | meaning |
|---|---|---|
| `max_locations` | int / unlimited | verified claims a business may hold |
| `blasts_per_month` | int | `email_blast` campaigns launchable per billing period |
| `max_recipients_per_blast` | int | hard recipient ceiling per blast (email-cost guard) |
| `featured_per_week` | int | featured activations per week (within A7/A12 global cap) |
| `newsletter_slots_per_month` | int | newsletter ad slots per period |
| `seats` | int / unlimited | `business_members` rows allowed |
| `analytics_tier` | text | `'basic' \| 'standard' \| 'advanced' \| 'advanced_export'` |
| `api_access` | text | `'none' \| 'read' \| 'read_write'` |
| `csv_import` | bool | CSV bulk-import enabled |
| `priority_support` | text | `'community' \| 'email' \| 'priority' \| 'dedicated'` |
| `overage_enabled` | bool | may exceed allowances via pay-as-you-go credits (§5) |

**Seed data (the matrix, as rows):**

```sql
insert into public.plans (id, name, monthly_cents, annual_cents, sort, is_public) values
  ('solo',       'Solo',        1000,  10000, 1, true),
  ('growth',     'Growth',      3900,  39000, 2, true),
  ('chain',      'Chain',      14900, 149000, 3, true),
  ('enterprise', 'Enterprise', null,    null, 4, false);

-- helper legend: (plan, key, int, bool, text, unlimited)
insert into public.plan_features (plan_id, key, int_value, bool_value, text_value, unlimited) values
  -- Solo
  ('solo','max_locations',              1,    null, null,               false),
  ('solo','blasts_per_month',           2,    null, null,               false),
  ('solo','max_recipients_per_blast',   2000, null, null,               false),
  ('solo','featured_per_week',          1,    null, null,               false),
  ('solo','newsletter_slots_per_month', 0,    null, null,               false),
  ('solo','seats',                      2,    null, null,               false),
  ('solo','analytics_tier',             null, null, 'basic',            false),
  ('solo','api_access',                 null, null, 'none',             false),
  ('solo','csv_import',                 null, false,null,               false),
  ('solo','priority_support',           null, null, 'email',            false),
  ('solo','overage_enabled',            null, true, null,               false),
  -- Growth
  ('growth','max_locations',            5,    null, null,               false),
  ('growth','blasts_per_month',         6,    null, null,               false),
  ('growth','max_recipients_per_blast', 5000, null, null,               false),
  ('growth','featured_per_week',        3,    null, null,               false),
  ('growth','newsletter_slots_per_month',1,   null, null,               false),
  ('growth','seats',                    5,    null, null,               false),
  ('growth','analytics_tier',           null, null, 'standard',         false),
  ('growth','api_access',               null, null, 'none',             false),
  ('growth','csv_import',               null, true, null,               false),
  ('growth','priority_support',         null, null, 'email',            false),
  ('growth','overage_enabled',          null, true, null,               false),
  -- Chain
  ('chain','max_locations',             25,   null, null,               false),
  ('chain','blasts_per_month',          20,   null, null,               false),
  ('chain','max_recipients_per_blast',  15000,null, null,               false),
  ('chain','featured_per_week',         3,    null, null,               false), -- per location; see A7
  ('chain','newsletter_slots_per_month',3,    null, null,               false),
  ('chain','seats',                     15,   null, null,               false),
  ('chain','analytics_tier',            null, null, 'advanced',         false),
  ('chain','api_access',                null, null, 'read',             false),
  ('chain','csv_import',                null, true, null,               false),
  ('chain','priority_support',          null, null, 'priority',         false),
  ('chain','overage_enabled',           null, true, null,               false),
  -- Enterprise (all limits unlimited/custom; provisioned per contract)
  ('enterprise','max_locations',        null, null, null,               true),
  ('enterprise','blasts_per_month',     null, null, null,               true),
  ('enterprise','max_recipients_per_blast', null, null, null,           true),
  ('enterprise','featured_per_week',    null, null, null,               true),
  ('enterprise','newsletter_slots_per_month', null, null, null,         true),
  ('enterprise','seats',                null, null, null,               true),
  ('enterprise','analytics_tier',       null, null, 'advanced_export',  false),
  ('enterprise','api_access',           null, null, 'read_write',       false),
  ('enterprise','csv_import',           null, true, null,               false),
  ('enterprise','priority_support',     null, null, 'dedicated',        false),
  ('enterprise','overage_enabled',      null, true, null,               false);
```

> Per-location & seat *overage prices* (the "+$6/extra") live as plan metadata for
> phase-2 Stripe metering (§6), not as `plan_features` limits. In phase 1 the admin
> just picks the right tier when approving; overages are a manual invoice line.

---

## 4. Enforcement pattern (the code checks entitlements in the DB)

Same rule as the rest of the platform: **checks live in `SECURITY DEFINER` RPCs in
Postgres, never in React** (the SPA can be bypassed). Three small readers plus
per-action "assert" gates that A5's campaign RPCs and the seat/location RPCs call
*before* doing work. All wrapped as `(select …)` at call sites for the InitPlan
hoist, matching the existing `manages_bathroom()` style.

```sql
-- Resolve a numeric entitlement for a business's ACTIVE plan. NULL = unlimited or
-- no active subscription (callers must distinguish; see has_active_subscription).
create or replace function public.entitlement_int(p_business_id uuid, p_key text)
returns int language sql stable security definer set search_path = '' as $$
  select case when pf.unlimited then null else pf.int_value end
  from public.subscriptions s
  join public.plans p         on p.id = s.plan
  join public.plan_features pf on pf.plan_id = p.id and pf.key = p_key
  where s.business_id = p_business_id
    and s.status in ('active', 'trialing');
$$;

create or replace function public.entitlement_text(p_business_id uuid, p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select pf.text_value
  from public.subscriptions s
  join public.plans p         on p.id = s.plan
  join public.plan_features pf on pf.plan_id = p.id and pf.key = p_key
  where s.business_id = p_business_id and s.status in ('active', 'trialing');
$$;

-- Boolean feature flags (csv_import, api_access<>'none', overage_enabled, …).
create or replace function public.has_entitlement(p_business_id uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
             when pf.unlimited then true
             when pf.bool_value is not null then pf.bool_value
             when pf.text_value is not null then pf.text_value <> 'none'
             when pf.int_value  is not null then pf.int_value > 0
             else false end
    from public.subscriptions s
    join public.plans p         on p.id = s.plan
    join public.plan_features pf on pf.plan_id = p.id and pf.key = p_key
    where s.business_id = p_business_id and s.status in ('active', 'trialing')
  ), false);
$$;
```

**Usage gates** count consumption *this billing period* and raise when exhausted
(or fall through to overage when `overage_enabled`). Example for blasts — A5 calls
this inside `campaign_launch()` before flipping a campaign to `running`:

```sql
-- Raises unless the business may launch another blast of p_recipients this period.
-- Returns 'included' or 'overage' so the caller can meter/bill (§5,§6).
create or replace function public.assert_can_launch_blast(
  p_business_id uuid, p_recipients int)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_allow int := public.entitlement_int(p_business_id, 'blasts_per_month');
  v_cap   int := public.entitlement_int(p_business_id, 'max_recipients_per_blast');
  v_used  int;
begin
  -- No active plan at all → nothing may launch.
  if not exists (select 1 from public.subscriptions
                 where business_id = p_business_id
                   and status in ('active','trialing')) then
    raise exception 'no active subscription' using errcode = '42501';
  end if;

  -- Hard recipient ceiling is never bypassable, even with overage (email-cost guard).
  if v_cap is not null and p_recipients > v_cap then
    raise exception 'recipient count % exceeds plan ceiling %', p_recipients, v_cap
      using errcode = '22023';
  end if;

  select count(*) into v_used
  from public.ad_campaigns
  where business_id = p_business_id
    and type = 'email_blast'
    and status in ('approved','running','done')
    and created_at >= date_trunc('month', now());   -- swap for the sub's period start

  if v_allow is null or v_used < v_allow then
    return 'included';
  elsif public.has_entitlement(p_business_id, 'overage_enabled') then
    return 'overage';                                -- A5 records a billable credit
  else
    raise exception 'monthly blast allowance (%%) exhausted', v_allow
      using errcode = '53400', hint = 'Upgrade or enable overage.';
  end if;
end;
$$;
```

Analogous asserts (same shape, cheap to write): `assert_can_add_location()` →
counts verified `bathroom_claims` vs `max_locations` (**wire into
`admin_review_claim` before it flips a claim to `verified`**, and into the CSV
import job so a 30-row upload on a Solo plan is refused with a clear upgrade
message, not a silent 1-of-30); `assert_can_add_seat()` → counts `business_members`
vs `seats` (**wire into `business_add_member`**, which today has no seat check —
`REQUEST TO A2/orchestrator`: add the gate there); `assert_can_feature_this_week()`
→ counts `featured_placements` in the current ISO week vs `featured_per_week`
(A7 calls it). Every gate also writes to `moderation_actions`/an audit table when
it *denies*, so support can see "hit their cap" without guessing.

`api_access` and `analytics_tier` are read by their consumers (A10 console, the API
edge function) via `entitlement_text()`; no separate gate needed.

---

## 5. Ad/blast economics: allowance + optional overage

**Recommended model: an included monthly allowance per tier, plus optional
pay-as-you-go overage credits** — not pure allowance (frustrates a business having
a good month) and not pure credits (unpredictable, and hides the recurring value).
This mirrors how Resend itself works: a plan bucket, then a per-1,000 overage rate
[[src]](https://resend.com/pricing).

### Why the ceilings are safe (the email-cost math)

Watrloo sends via **Resend**. Marginal send cost is roughly **$0.90 per 1,000
emails** at our early volume, dropping toward **$0.46/1,000** at millions/mo
[[src]](https://resend.com/pricing). Worst-case monthly email volume per tier =
`blasts_per_month × max_recipients_per_blast` (and real reach is *lower* after
suppression + the ≤3/7-day frequency cap):

| Tier | Worst-case emails/mo | ≈ Resend cost @ $0.90/1k | Sub revenue | Email cost as % of rev |
|---|---|---|---|---|
| Solo | 2 × 2,000 = **4,000** | **$3.60** | $10 | 36% (worst case; typically far less) |
| Growth | 6 × 5,000 = **30,000** | **$27** | $39 | 69% worst case — but the recipient cap is a *ceiling*, not the expected send |
| Chain | 20 × 15,000 = **300,000** | **$270** | $149 | see note |

The Growth/Chain worst-case looks scary only because it assumes every business
maxes every blast to a full-size city audience every month. It won't — coarse
targeting is **city/region granularity** (contract), so a blast's real audience is
the opted-in-marketing users in the targeted metro, usually a few hundred to low
thousands early on, well under the ceiling. Two structural protections keep us out
of the red regardless:

1. **The recipient ceiling is never bypassable** (see `assert_can_launch_blast`),
   even via overage — it is the email-cost guardrail, coordinated with **A13
   SCALING_COST** and **A6 EMAIL_DELIVERY**. `REQUEST TO A13`: confirm/own a
   platform-wide absolute monthly email budget cap that trips before any tier's
   theoretical max; A6 owns the actual send + Resend plan sizing (note: Resend
   bills *marketing* email by **contacts**, not sends
   [[src]](https://resend.com/docs/knowledge-base/what-is-resend-pricing) — A6
   decides broadcast vs transactional send mode; PRICING assumes the ~$0.90/1k
   marginal figure for allowance sizing only).
2. **Overage is priced above cost with margin.** Overage credits are the release
   valve *and* a profit line, never a loss:

| Overage credit | Price | Our marginal cost | Gross margin |
|---|---|---|---|
| Extra email-blast recipients | **$5 per +1,000** ($0.005/recipient) | ~$0.0009/recipient | ~82% |
| Extra featured-placement week | **$15 / activation** | ~$0 (in-app, no send) | ~100% |
| One-off newsletter slot (Solo/Growth beyond allowance) | **$25 / slot** (subject to A8 inventory) | ~$0 | ~100% |
| Extra location (within tier bucket) | Growth **+$6/mo**, Chain **+$4/mo** | ~$0 | ~100% |

Overage requires `overage_enabled` (all paid tiers) and is off unless the business
opts in — no surprise bills. In phase 1 the admin adds overage as an invoice line;
in phase 2 it's a Stripe metered price (§6). Featured/newsletter overage is capped
by the same global fairness limits (A7/A8/A12) — you can *buy* more only while
inventory and the per-week cap allow.

**Bottom line recommendation:** ship **allowance + opt-in overage**, keep the
recipient ceiling as the hard cost fuse, and let A13 own the absolute platform
email budget. Small owners never see a surprise; heavy users pay us more at healthy
margin.

---

## 6. Billing — manual now (phase 1), Stripe later (phase 2)

### Phase 1 — manual invoicing (works today, no new code)

The existing flow already supports this end to end:
`admin_approve_access_request(request_id, plan)` creates the business, owner, and a
`subscriptions` row with `status = 'active'` and the chosen `plan`; `stripe_*`
columns stay null (`BUSINESS_ACCOUNTS §2/§4`). To go live on pricing we only need
to:

1. Pass a real tier id to that RPC — change its default from `'standard'` to
   `'solo'` and constrain to `plans.id` (`REQUEST TO A2`).
2. Seed `plans` + `plan_features` (§3) so the entitlement RPCs (§4) resolve.
3. Admin arranges payment out of band (Stripe **invoice** or **payment link** —
   available without any in-app integration), then sets/keeps `status = 'active'`.
4. Renewals & overage are manual invoice lines; a `past_due`/`canceled` set by the
   admin instantly revokes paid power because `manages_bathroom()` already checks
   `status in ('active','trialing')`.

That's the whole phase-1 billing system: pick a tier, invoice, flip status. No
Stripe dependency for launch.

### Phase 2 — self-serve Stripe (design, not built)

Turns the manual step into self-serve; nothing above has to change shape.

- **Catalog:** one **Stripe Product per tier** (Solo/Growth/Chain), each with a
  **monthly** and **annual** recurring **Price**; store the Price ids in
  `plans.stripe_price_id_monthly/_annual`. Enterprise stays off-catalog (custom
  quote / manual invoice). Per-location, extra-seat, extra-blast-recipient, and
  featured/newsletter overage become **metered Prices** reported via Stripe usage
  records from the same gates in §4 (the gate returns `'overage'` → record usage).
- **Signup:** **Stripe Checkout** (subscription mode) from the advertiser console
  (A10); on success the webhook provisions the business (or upgrades its plan) and
  starts the claim flow.
- **Self-service changes:** **Stripe Customer Portal** for upgrade/downgrade/cancel
  and card updates — no bespoke UI.
- **Source of truth stays the DB.** A **Supabase Edge Function** with `service_role`
  handles the webhook (the SPA can't hold `service_role` — this is the same
  server-side tier as user-management, and the feature that justifies standing up
  Edge Functions, per `BUSINESS_ACCOUNTS §4`). It writes only:
  `subscriptions.status` (`active`/`past_due`/`canceled`/`trialing`),
  `plan` (mapped from the Price → `plans.id`), `current_period_end`,
  `stripe_customer_id`, `stripe_subscription_id`.

| Stripe event | Effect on `subscriptions` |
|---|---|
| `checkout.session.completed` | provision/attach `stripe_customer_id` + `stripe_subscription_id`; `status='active'` (or `trialing`) |
| `customer.subscription.updated` | remap `plan` from the new Price; refresh `current_period_end`, `status` |
| `customer.subscription.deleted` | `status='canceled'` → paid power drops at next `manages_bathroom()` check |
| `invoice.paid` | `status='active'`; extend `current_period_end` |
| `invoice.payment_failed` | `status='past_due'` (dunning; grace before revoke) |

- **Security:** verify the Stripe webhook signature; make the handler idempotent on
  Stripe event id; never trust plan/price from the client — only from the webhook.
- **Merchant of record (open, from `BUSINESS_ACCOUNTS §8`):** Stripe direct is the
  recommendation for a US launch; revisit Paddle/Lemon Squeezy only if selling
  internationally where global sales-tax/VAT handling earns its cut.

**Phasing is clean:** phase 1 and phase 2 write the *same* `subscriptions` columns
and read the *same* `plans`/`plan_features`; the only change at phase 2 is *who*
sets `status` (admin hand vs webhook). Entitlement checks (§4) never change.

---

## 7. Open items / requests to other agents

- `REQUEST TO A2`: add `plans` + `plan_features` (§3) to the canonical model; FK
  `subscriptions.plan → plans.id`; migrate `'standard'` → `'solo'`; change
  `admin_approve_access_request` default plan to `'solo'`.
- `REQUEST TO A2/orchestrator`: add a seat gate to `business_add_member`
  (`assert_can_add_seat`) and a location gate to `admin_review_claim` +
  the CSV import job (`assert_can_add_location`).
- `A13 SCALING_COST`: own the absolute platform-wide monthly email budget cap that
  trips before any tier's theoretical worst case; confirm the ~$0.90/1k figure and
  Resend plan sizing with `A6 EMAIL_DELIVERY`.
- `A7 INAPP_ADS` / `A12`: `featured_per_week` is a per-tier ceiling *within* the
  global weekly fairness cap — confirm interaction.
- `A8 NEWSLETTER`: newsletter slots are curated inventory; a paid allowance is a
  *right to be considered*, still bounded by available editions/slots.
- `A10 ADVERTISER_CONSOLE`: render the pricing page from `plans`/`plan_features`,
  show live usage-vs-allowance meters (via the §4 readers), and the upgrade CTA
  when a gate denies.
