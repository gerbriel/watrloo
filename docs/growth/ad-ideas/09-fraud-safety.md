# Ad Review, Click Fraud Prevention & Brand Safety — Feature Ideas

Grounding note: the ad product actually running today is smaller than the design docs describe. `ad_campaigns` / `campaign_sends` / `featured_placements` / `growth_settings` / the admin pause-suspend RPCs (`admin_set_campaign_status`, `admin_suspend_business` in `supabase/migrations/20260712030000_growth_admin_controls.sql`) are real and live. **`analytics_events` (ANALYTICS.md) and `rate_limits`/`check_rate_limit` (RATE_LIMITING.md) do not exist in any migration yet** — they're designs, not code. Only one surface is wired up client-side: `FeaturedCard` on `Explore.tsx` via `activeFeatured('browse')` (`src/lib/api/growth.ts`), and it logs **nothing** — no impression, no click, no session id. `reports` (from `20260710020000_roles_reports_moderation.sql`) targets only `review_id`/`bathroom_id` today via the `Target = {review_id} | {bathroom_id}` union in `src/components/moderation/ReportButton.tsx`. Every idea below is scoped to that reality: several are prerequisites the docs assumed already existed.

---

## 1. Ad interaction ledger — the missing foundation

There is currently no record of an ad ever being seen or clicked anywhere in the schema. Add a small, purpose-built `ad_events` table (`event text check in ('impression','click')`, `campaign_id`, `placement_id`, `surface`, `session_id`, `region`, `user_id nullable`, `created_at`) plus a `log_ad_event` `SECURITY DEFINER` RPC, in the spirit of `active_featured()` — public, anonymous-safe, zero consent gate needed because it's contextual/aggregate, not behavioral profiling. Wire `FeaturedCard.tsx` to call it on render (debounced/visibility-gated) and on click. This doesn't have to become — or block on — A4's full `analytics_events`; it can converge with that table later by column-compatible design. Every other idea in this doc depends on this existing.

**Effort:** M. **Touches:** new migration (`ad_events` + `log_ad_event`), `src/lib/api/growth.ts`, `src/components/growth/FeaturedCard.tsx`. **Ship-first:** yes.

## 2. "Report this ad" — extend the existing report button, don't build a new one

`ReportButton`'s `Target` union and `fileReport()`/`NewReport` already generalize cleanly. Widen `reports` with a nullable `campaign_id uuid references ad_campaigns(id) on delete cascade`, loosen the "exactly one target" check to admit it, add `reason_category text check in ('misleading','offensive','spam','scam','other')`, and add `{ campaign_id: string }` to the `Target` type. Render `<ReportButton target={{ campaign_id }} />` on `FeaturedCard`. `AdminReports.tsx`'s `Target` component gets one more branch (mirroring the existing `review`/`bathroom` blocks) so ad reports land in the **same queue** moderators already use — no new surface, no new training. This is the single cheapest, highest-leverage brand-safety control available.

**Effort:** S. **Touches:** new migration (widen `reports`), `src/types/db.ts`, `src/components/moderation/ReportButton.tsx`, `src/pages/admin/AdminReports.tsx`, `src/lib/api/reports.ts`. **Ship-first:** yes.

## 3. Business strike ladder, wired to the admin controls that already exist

`admin_set_campaign_status` and `admin_suspend_business` are already built and already write to `moderation_actions`. This idea is purely the missing glue: when a moderator resolves an ad report as upheld (a new `uphold_ad_report` verb, added the same way `20260712030000` widened the action-check constraint), count upheld reports per `business_id` over a trailing 90 days and auto-escalate — 1 upheld → warn + reject that creative; 2 → call `admin_set_campaign_status(..., 'paused')` on every running campaign for that business; 3+ → call `admin_suspend_business(..., true)`. No new counter table: the strike count is `count(*) from moderation_actions where action='uphold_ad_report' and target_id=business_id`. This turns "report this ad" (#2) from a queue into an actual enforcement loop using controls that shipped weeks ago.

**Effort:** S/M. **Touches:** migration widening `moderation_actions` action check + a `resolve_ad_report` RPC that calls the existing admin RPCs internally, `src/pages/admin/AdminReports.tsx`. **Ship-first:** yes.

## 4. Billable/cleaned-traffic view, built before there's any billing to protect

The hard constraint is "billed metrics must exclude invalid traffic" — the cheapest way to guarantee that forever is to never let a raw count reach an advertiser's eyes in the first place. Once `ad_events` (#1) exists, add a view `ad_events_clean` that already applies the exclusions from #5/#6/#10 (self-clicks, session dupes, bot UAs), and make it the **only** thing any future reach/CTR/billing query reads — `ad_events` itself stays internal. Building this now, while the numbers are still vanity metrics on the Explore page, means CPC/CPM billing can be bolted on later without a retrofit or a "oops we billed on raw clicks for six months" incident.

**Effort:** S (given #1). **Touches:** one migration (a view + supporting indexes), any future advertiser-facing reach RPC reads from it instead of `ad_events`.

## 5. Self-click / employee-click exclusion

A business's own staff clicking their own featured card inflates CTR for free. Once a click is logged with an opportunistic `user_id` (set only when the viewer is authenticated — this is fraud-signal, not marketing attribution, so it doesn't need `marketing_opt_in`), exclude clicks where `user_id` is a `business_members` row (`20260711000000_business_accounts.sql`) of the campaign's `business_id` from `ad_events_clean`. This is a single `not exists` predicate but it's the textbook first fraud vector and directly protects billed metrics per the hard constraint.

**Effort:** S (given #1/#4). **Touches:** predicate in the `ad_events_clean` view definition.

## 6. Session velocity cap + de-dup on ad events

Reuses the exact fixed-window counter shape from `RATE_LIMITING.md §2` (`rate_limits` + `check_rate_limit`, `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`) — if that primitive has landed by the time this ships, call it directly, keyed on `session_id` instead of `user_id` since ad viewers are frequently anonymous; if not, a scoped copy of the same pattern works identically. Cap at roughly 1 click/(session, placement, day) for de-dup and ~20 clicks/hour/session as a hard ceiling; over-cap events are flagged `is_flagged=true` on the row rather than silently dropped, so the admin can see what got excluded and why.

**Effort:** S (given #1). **Touches:** migration adding a `check_ad_event_velocity` function or `rate_limits` reuse, called from `log_ad_event`.

## 7. Structured rejection-reason taxonomy + policy checklist in the review queue

`AdminCampaigns.tsx`'s `ApprovalQueue` today takes a freeform `reason` string for rejection. Replace/augment it with a fixed checklist (misleading claim, prohibited category, unsafe destination link, low-quality creative, wrong bathroom/business, other) that writes a `reject_reason_category` alongside the existing freeform `reject_reason` on `ad_campaigns`. This makes rejection reasons consistent enough to be queryable (which categories cause the most rejections — useful both for tightening the advertiser-facing policy doc and for spotting a moderator who's rubber-stamping). Small, standalone, no dependency on anything else in this list.

**Effort:** S. **Touches:** migration adding the column + check constraint, `src/pages/admin/AdminCampaigns.tsx` (`ApprovalQueue`'s reject form), `src/lib/api/growth.ts` (`reviewCampaign`).

## 8. Automated pre-screen at submission: destination URL + prohibited-category check

Before a campaign can even reach `pending_review`, run cheap, self-contained checks inside `submit_campaign` (or a wrapper called by it): destination link is `https://`, not a bare IP, not a known-bad TLD pattern, no punycode/homograph host (`xn--`), and creative text doesn't hit a small admin-maintained denylist table (`ad_policy_denylist`: adult, gambling, weapons, unverifiable health claims — the actual content rules doc lives here as data, not prose). Failures don't auto-reject — they attach a `flags jsonb` array the reviewer sees front-and-center in `ApprovalQueue`, cutting the cases where an obviously bad submission wastes a full human review cycle. Deliberately no third-party Safe Browsing/WHOIS API call — that's a paid-service dependency the repo's stated constraints (see `docs/ops/RATE_LIMITING.md §10`'s rejected-CAPTCHA reasoning) would reject the same way.

**Effort:** M. **Touches:** migration (`ad_policy_denylist` table, `flags` column on `ad_campaigns`), `submit_campaign` RPC, `src/pages/admin/AdminCampaigns.tsx` (surface flags in `CreativePreview`).

## 9. CTR/impression anomaly flag surfaced to the admin queue

Once #1 and #4 exist, add a rollup comparing each running campaign's cleaned CTR to the trailing 7-day median CTR for its surface (`browse`/`map`/`detail`). A campaign running >5x the surface baseline gets a row in a new `flagged_campaigns` admin view (not an automatic pause — detection, not silent enforcement, matching the "never auto-bill on raw counts" posture). Surface it as a badge on the existing `LiveAdRow` in `AdminCampaigns.tsx` so the same admin who can already pause/suspend sees the signal right where they'd act on it.

**Effort:** M (given #1/#4). **Touches:** migration (rollup view or materialized view + `pg_cron` refresh), `src/pages/admin/AdminCampaigns.tsx` (`LiveAdRow` badge), `src/lib/api/growth.ts`.

## 10. Bot/crawler filter in the logging path

Fold into `log_ad_event` (#1): reject or flag events with no `session_id`, a known-crawler pattern in a client-supplied UA hint, or impossible timing (a click logged with no prior impression for that `placement_id`+`session_id`, or a click <300ms after the impression insert — faster than a human can register the card). This is the same class of heuristic as `ABUSE_AND_LIMITS.md §6.2.4`, scoped down to what's checkable without IP (which, per `RATE_LIMITING.md §4`, isn't reliably available to Postgres here either).

**Effort:** S (given #1). **Touches:** `log_ad_event` RPC logic, `src/components/growth/FeaturedCard.tsx` (send the impression-then-click ordering client-side).

## 11. Report-brigading protection

The report queue itself is an abuse surface once ads exist inside it — a competitor could mass-file baseless reports hoping raw count pressures a pause. The existing model already resists this structurally (strikes in #3 only accrue on **moderator-upheld** reports, never on raw filing volume), but add a cheap filing-rate guard: reuse `check_rate_limit`/`rate_limits` (or the scoped equivalent from #6) on `reports` inserts — a handful per user per day is plenty for genuine reporting and blocks a script from flooding the queue and burying real reports under noise.

**Effort:** S. **Touches:** trigger or check on `reports` insert (mirrors `RATE_LIMITING.md §3`'s `AFTER INSERT` pattern for `reviews`).

## 12. Submission flood guard on the review queue

`create_campaign`/`submit_campaign` have no rate limit today — a compromised or bad-faith business account could submit dozens of draft campaigns to bury the moderator queue in noise (distinct from #11, which is about *reports*, not *campaigns*). A small cap — a handful of `pending_review` campaigns per business at once, enforced inside `submit_campaign` itself as a `count(*) where business_id=... and status='pending_review'` check — keeps the queue tractable with zero new infrastructure.

**Effort:** S. **Touches:** one guard clause added to the existing `submit_campaign` RPC in `20260712000000_growth_phase0_featured.sql`.

## 13. Duplicate/near-duplicate resubmission detector

An advertiser whose creative gets rejected can resubmit the same (or cosmetically tweaked) copy immediately, forcing the same review work repeatedly. At `submit_campaign` time, compare the new `creative` jsonb against the business's own `rejected` campaigns from the last 30 days (exact match cheaply via a hash of the normalized creative text; near-duplicate via trigram similarity on `title`/`body` if `pg_trgm` is available) and attach a `previously_rejected: true` flag the reviewer sees in `ApprovalQueue`, with a link to the prior rejection reason. Doesn't block the resubmission — just stops the reviewer from re-deriving the same verdict from scratch.

**Effort:** M. **Touches:** migration (hash/trigram check in `submit_campaign`), `src/pages/admin/AdminCampaigns.tsx` (show prior rejection inline).

## 14. Advertiser-facing "flagged for review" transparency banner

When a business's campaign has an open (unresolved) ad report against it, show a quiet, factual banner on `Campaigns.tsx` ("This ad is under review following a user report") — no reason detail (that stays internal to avoid tipping off exactly what to game), just status. Reduces "why did my ad get paused" support load and is consistent with how `LiveAdRow` already surfaces `suspended_at` state to admins; this is the same transparency one layer down, to the advertiser themselves.

**Effort:** S. **Touches:** `src/pages/business/Campaigns.tsx`, a read-scoped RPC or RLS-safe query for "does my business have an open ad report."

---

## Top picks

1. **#1 (ad interaction ledger)** unlocks every fraud-detection idea below it — nothing else in this domain has data to work with until it ships.
2. **#2 (report this ad)** and **#3 (strike ladder)** are nearly free: they wire a two-line union-type extension and a resolver RPC into admin controls (`admin_set_campaign_status`, `admin_suspend_business`) that are already live in production.
3. Everything else layers cleanly on top once those three land — most are S/M effort because they're predicates and views on tables the first three ideas create, not new subsystems.
