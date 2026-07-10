# Watrloo — Business Accounts (paid tier)

Design for paid business accounts. Status: **proposal**. Nothing here is
applied. Builds on the roles/moderation system in
`20260710020000_roles_reports_moderation.sql` and the design in
[USERS_AND_ROLES.md](./USERS_AND_ROLES.md) — which explicitly left room for
*scoped* moderation via a future `scope` column. This is that scope.

**Goal.** A company (a cafe, a gas-station chain, a mall) pays to claim the
listings for its locations, keep their facts and amenities accurate, bulk-import
a chain's whole footprint from a CSV, and get advertiser value on top. Restrooms
are a foot-traffic funnel, so the buyer is anyone who wants people to walk in.

---

## 0. The trust landmine (read first)

"Become the moderator for those locations" is the dangerous phrasing. If a
business can delete reviews on its own listings, the ratings become worthless —
every 1-star vanishes and Watrloo turns into an ad platform nobody trusts. The
whole product premise (USERS_AND_ROLES §0) is that *facts* benefit from an owner
but *reviews* must not be owner-controlled.

**So split the two axes:**

| A business CAN | A business CANNOT |
|---|---|
| Edit its listings' **facts**: name, address, hours, amenities, description, photos, logo | Edit or delete **reviews** or ratings |
| **Respond** publicly to a review (owner reply) | Hide/soft-delete a review it dislikes |
| **Report** a review (spam/abuse) into the normal moderation queue | Resolve its own reports |
| See analytics for its own locations | Touch any listing it hasn't verified a claim on |

Review removal stays with **platform** moderators/admins (the existing tier-1
system). A business gets a louder voice on its listing, never a veto over
honest feedback. This is the single most important decision in this doc.

---

## 1. Data model

Businesses are a **separate axis** from platform roles — don't overload
`app_role` (that's for Watrloo staff). A person can be a normal user *and* a
member of one or more businesses.

```
business_access_requests  id, requester_id → profiles, business_name, website,
                    contact_email, message, locations_note, status
                    ('open'|'approved'|'rejected'), created_at, reviewed_by,
                    reviewed_at   -- the "request access" form; entry point (§2)
businesses          id, name, slug, website, logo_url, owner_id → profiles,
                    created_at
business_members    (business_id, user_id) pk, role ('owner'|'manager'|'staff'),
                    invited_by, created_at
bathroom_claims     id, bathroom_id → bathrooms, business_id → businesses,
                    status ('pending'|'verified'|'rejected'),
                    requested_by → profiles, reviewed_by → profiles,
                    created_at, reviewed_at
                    unique (bathroom_id) where status = 'verified'  -- one owner
review_responses    id, review_id → reviews, business_id, author_id → profiles,
                    body, created_at   -- the public owner reply
subscriptions       business_id pk, plan, status
                    ('active'|'past_due'|'canceled'|'trialing'),
                    current_period_end, updated_at,
                    stripe_customer_id, stripe_subscription_id  -- null until §4
```

Key rule: `bathroom_claims` has at most **one verified claim per bathroom**
(the partial unique index). A business's power over a listing flows through a
*verified* claim to a *member* row — never a global grant.

---

## 2. Requesting access & claiming (v1: manual, no self-serve payment yet)

There is **no in-app payment method yet**, so v1 is request-and-approve. The
requester is never shown an admin email — they fill out a form, full stop.

1. A signed-in user clicks **"Request business access"** and fills out the form:
   business name, website, contact, and the location(s) or chain they represent
   (optionally a CSV, §5). Submitting writes a `business_access_requests` row.
2. That submission **notifies the admin by email** — to gabrielriosemail@gmail.com
   via the existing Resend/SMTP setup (see [EMAIL.md](./EMAIL.md); that address is
   the Resend account owner's, so it delivers even without a verified sending
   domain). The request also shows up in the admin portal queue. Send it from a
   DB trigger or a small Edge Function on insert.
3. The admin reviews, **arranges payment out-of-band** (a Stripe invoice or
   payment link, by hand for now), then approves: creates the `businesses` row,
   adds the requester as `owner`, marks the subscription active, and verifies the
   claim(s).

That human approval step *is* the anti-fraud control (someone claiming a
competitor's listing gets caught here). Later phases automate verification
(email-domain match, phone, Google Business OAuth) and add self-serve Stripe
(§4) so approval stops being a bottleneck.

---

## 3. Scoped permissions (RLS)

One security-definer helper, mirroring `is_moderator()`:

```sql
-- true if the caller manages a business with a VERIFIED claim on this bathroom
-- AND that business's subscription is active. Stable + wrapped as
-- (select public.manages_bathroom(id)) at call sites for the InitPlan hoist.
create function public.manages_bathroom(p_bathroom_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$ ... $$;
```

- **Listing edits** go through an RPC `business_update_listing(bathroom_id, …)`,
  not a broad UPDATE policy. The RPC re-checks `manages_bathroom`, writes only
  the fact columns (never `created_by`, `deleted_at`, ratings), and logs to
  `moderation_actions`. Column-scoping in an RPC is cleaner than table-level RLS,
  which can't restrict columns without `REVOKE`/`GRANT (col,…)` gymnastics.
- **Owner responses**: an INSERT policy on `review_responses` gated on
  `manages_bathroom(review's bathroom)`; one response per (review, business).
- **No** review UPDATE/DELETE path for businesses — deliberately absent.

---

## 4. Billing — manual now, Stripe later

**v1: no in-app payments.** The admin is emailed on each request (§2) and sets up
payment manually (Stripe invoice or payment link), then flips the business to
active in the admin portal. The `subscriptions` row exists but its `status` is
set by the admin by hand; `stripe_*` columns stay null for now.

**Later: self-serve Stripe.** Stripe Checkout for signup + Customer Portal for
changes, with a **Supabase Edge Function** (`service_role`) handling the webhook
to write `subscriptions.status` / `current_period_end`. That Edge Function is the
same server-side tier as user-management (USERS_AND_ROLES §6) — the SPA can't hold
`service_role` — so this is the feature that justifies standing up Edge Functions.
Either way, paid capabilities gate on `subscriptions.status in
('active','trialing')`, checked in the DB, never in React.

---

## 5. CSV bulk import (chains)

The headline convenience for a multi-location buyer.

1. Upload CSV: `name, address, lat, lng, amenities…, hours, description`.
   Require lat/lng, or geocode addresses server-side (external geocoder) in the
   Edge Function.
2. **Dedup** each row against existing listings using the `geog` column and
   `nearby_bathrooms` (already built): within ~40 m of an existing bathroom →
   propose **claim** that one; otherwise propose **create**.
3. Show a **preview/diff** (create N, claim M, N conflicts) before committing —
   never silently mass-write.
4. On confirm, the Edge Function creates/claims in a batch, auto-verifies the
   claims to that business (they're paying and importing their own footprint),
   and records an import job for audit/rollback.

Runs in an Edge Function because it's a privileged batch (geocoding, bypassing
the one-at-a-time RLS insert path) and can be large.

---

## 6. Advertiser value — what they're actually paying for

Ranked by build-cost-to-value. Claiming + accuracy is table stakes; the money
is in these:

1. **Verified "Official" badge** on claimed listings. Cheap, high trust signal.
2. **Enhanced listing:** logo, brand color, extra photos, hours, website link,
   "customer restroom — ask staff," detailed accessibility. Turns a listing into
   a mini storefront.
3. **Owner responses** to reviews (§3). Engagement + reputation management.
4. **Analytics dashboard:** listing views, "near me" impressions, direction/route
   taps, rating trend, review sentiment over time. Advertisers buy dashboards.
5. **Sponsored placement:** boosted rank in search/browse, a distinct pin style
   on the map, or **city sponsorship** — reuse the same "feature a city" mechanism
   that currently makes Fresno prominent to let a brand own a metro's slot.
6. **Promotions / coupons** attached to a location ("show this for 10% off").
   Directly monetizes the foot-traffic funnel — the strongest ROI story.
7. **"Nearest [brand] restroom"** priority result for chains.
8. **Amenity freshness / clean-commitment badge** — businesses keep their own
   data current, which is genuinely better data for everyone.
9. **Locations API** for large chains to sync programmatically.

---

## 7. Suggested build order

1. **Request access + manual approval** (`business_access_requests`, the
   "Request business access" form, admin email notification, admin-portal review,
   `businesses` + `business_members` + `bathroom_claims`, `manages_bathroom`,
   `business_update_listing` RPC, verified badge). Admin sets payment up by hand;
   no in-app payment. **This is where the current ask lands.**
2. **Self-serve Stripe billing** (Edge Function + webhook + `subscriptions`; gate
   claiming on active status). Removes the manual step.
3. **CSV bulk import** (dedup via `geog`, preview/confirm, Edge Function).
4. **Advertiser value-adds** (responses → analytics → sponsored/promos).

---

## 8. Open decisions

- **Billing provider:** Stripe (recommended) vs Paddle/LemonSqueezy (merchant-of-
  record, handles global tax) — matters if selling internationally.
- **Claim verification for v1:** admin-approved (safe, manual) vs automated
  (domain/phone) — recommend admin-approved to launch.
- **Can businesses remove reviews?** Recommendation: **no** (§0). Confirm, because
  it's the load-bearing trust call and reverses hard once shipped.
- **Pricing shape:** per-location, per-business flat, or tiered by location count
  — affects the CSV/claim UX (a 500-location chain vs a single cafe).
