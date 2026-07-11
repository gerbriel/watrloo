# Click & Engagement Analytics — Feature Ideas

Ranked by value-to-effort. All ideas are additive on top of `ANALYTICS.md` (A4) and
`INAPP_ADS.md` (A7): the `analytics_events` table, `analytics_daily`/`campaign_daily`
rollups, the `ad_impression`/`ad_click`/`featured_impression`/`featured_click`/
`campaign_conversion` events, the `active_featured` RPC, and `campaign_metrics(campaign_id)`.
None touch reviews or review ranking; all respect the k-anonymity floor (suppress < 5),
region coarseness, Tier A/B consent split, and rollup-not-raw dashboard reads from
`SCALING_COST.md`.

---

## 1. Organic listing engagement for business owners (close the `BusinessAnalytics.tsx` placeholder)

`BusinessAnalytics.tsx` ends with a literal "we don't collect that telemetry yet" box
promising "listing impressions, 'near me' appearances, and direction taps." A4 already
defines the exact events needed — `bathroom_view` (with `from: 'map'|'browse'|'search'`),
`directions_tap`, and `search` — none of which require the ads system at all. Add a
`listing_daily` rollup (`bathroom_id, day, views, directions_taps, phone_taps, website_taps`)
analogous to `campaign_daily`, and a `SECURITY DEFINER` RPC `listing_metrics(bathroom_id)`
gated by `is_business_member`-style ownership check, k-floored the same way
`campaign_metrics` is. Replace the placeholder card in `BusinessAnalytics.tsx` with real
KPI tiles (views this week, directions taps, trend sparkline) — this is the single
highest-leverage item because it ships a promise already made in the UI, using events
already speced, with no new ad-system dependency.

**Effort:** M. **Touches:** new `listing_daily` rollup table + `roll_up_listings()` cron
job (A2/A13), `listing_metrics(bathroom_id)` RPC, `src/pages/business/BusinessAnalytics.tsx`.
**Ship-first:** yes

---

## 2. Per-surface / per-placement breakdown in the advertiser dashboard

`campaign_daily` today is one row per `(campaign_id, day)` — an advertiser running
placements on browse, map, and detail simultaneously can't tell which surface is earning
its keep. Add a `surface` column to `campaign_daily` (or a sibling `placement_daily`
keyed by `placement_id`) so `roll_up_campaigns()` groups by `(campaign_id, surface, day)`
in addition to the existing campaign-only row. The advertiser console then renders three
mini-CTR cards (browse / map / detail) instead of one blended number — directly actionable
for where to reallocate `featured_per_week` entitlement next cycle.

**Effort:** M. **Touches:** `campaign_daily` schema (add `surface` or new
`placement_daily` table), `roll_up_campaigns()`, `campaign_metrics()` RPC signature,
advertiser console (A10) dashboard component.
**Ship-first:** yes

---

## 3. Click-through funnel visualization (impression → click → view → conversion)

All four stages already exist as discrete rollup numbers (`impressions`, `clicks`,
`bathroom_view` via `campaign_conversion.kind='bathroom_view'`, and `conversions`), but
nothing renders them as a funnel. A single read-only view over `campaign_daily` plus a
simple horizontal funnel chart (impressions → clicks → post-click views → directions/
conversions, with drop-off % between each stage) turns four separate numbers into the
one visualization advertisers actually want. No new events, no new tables — purely a
query (`sum()` over the existing rollup, one UNION for the conversion-kind split) and a
UI component.

**Effort:** S. **Touches:** advertiser console query (reads `campaign_daily` +
`campaign_metrics`), one new funnel chart component. Follow the `dataviz` skill for the
chart itself.
**Ship-first:** yes

---

## 4. Engagement-depth breakdown: directions/phone/website taps attributed to a campaign

Today `campaign_conversion.kind` is `'bathroom_view'|'review'|'signup'|'directions'` —
good, but the advertiser dashboard only shows one aggregate `conversions` number. Split
`campaign_daily.conversions` into per-`kind` columns (or a small `campaign_daily_kind`
side table) so an advertiser can see "142 people viewed the listing after clicking your
ad, 38 tapped directions, 6 tapped the phone/website link." This is the concrete
"engagement depth beyond the click" the domain asks for, and it's a `GROUP BY kind`
away from data that's already flowing through `campaign_conversion`'s 7-day
click-through / 1-day view-through attribution window (§9.4 of `ANALYTICS.md`).

**Effort:** S. **Touches:** `roll_up_campaigns()` (group by `kind`), `campaign_daily`
schema (add kind columns or side table), `campaign_metrics()` RPC, advertiser dashboard.

---

## 5. Time-of-day / day-of-week engagement heatmap

Neither `analytics_daily` nor `campaign_daily` currently bucket by hour, so nobody can
answer "when do people actually tap this ad." Add an `hour` (0–23) dimension to a new
`campaign_hourly` rollup (coarser retention than daily — e.g. 14 days raw-hour, then
collapse into the day-level table) fed by the same `roll_up_campaigns()` job, and render
a 7×24 heatmap (day-of-week × hour) of impressions/clicks/CTR per campaign. This directly
informs campaign scheduling (`starts_at`/`ends_at`) and is standalone valuable to admins
for platform-wide traffic patterns even without any campaign running.

**Effort:** M. **Touches:** new `campaign_hourly` (and optionally `analytics_hourly` for
product-wide use) rollup table, cron job, advertiser console heatmap component (dataviz
skill), a short retention window per `SCALING_COST.md`'s hourly-granularity cost math.

---

## 6. Post-click dwell / bounce quality signal

`ad_click`/`featured_click` tell you someone tapped through, but not whether they then
immediately left the bathroom detail page ("bounced") or actually engaged. Since
`route_view` already fires on route settle, a lightweight client-side dwell timer
(start on `bathroom_view` with `from:'featured'`, stop on `visibilitychange`/route
change, bucketed client-side into `<5s | 5-30s | 30s+` — never raw seconds, to keep
`props` small and non-identifying) added as a new optional prop on `bathroom_view` or a
`bathroom_view_end` event gives advertisers and admins a "click quality" signal distinct
from raw CTR. Cheap because it reuses the existing route-view + visibility-hide plumbing
already sketched in `track.ts`.

**Effort:** M. **Touches:** `src/lib/analytics/track.ts` (dwell bucket capture),
`analytics_events` allow-list (extend `bathroom_view` props or add
`bathroom_view_end`), rollup + advertiser dashboard "engagement quality" tile.

---

## 7. Unique vs. repeat reach: frequency distribution

`campaign_daily.reach` is already "distinct users reached that day," but says nothing
about whether that reach is 1,000 different people or the same 50 people seeing it 20×
each — materially different value for the advertiser. Because the per-user impression
cap (`≤3/placement/day`, `≤10/surface/day` per `INAPP_ADS.md` §5.3) is already enforced
and countable from `analytics_events`, a weekly rollup bucketing users into
`{1x, 2-3x, 4+x}` viewed-impression buckets (k-floored at 5 same as reach) turns the cap
enforcement data you're already computing into a frequency-distribution chart for free.
Anonymous/session-capped viewers fold into their own bucket rather than being dropped.

**Effort:** M. **Touches:** new weekly `campaign_reach_frequency` rollup (user_id/
session_id bucketed, k-floored), advertiser dashboard chart. Depends on the per-user cap
counter already being computed per §5.3.

---

## 8. Regional performance breakdown (k-anonymized)

`campaign_daily` is single-region already in practice (campaigns target one coarse
region per `ad_campaigns.target_region`), but multi-region or radius-based campaigns
(A5's 5–100 km radius targeting) can span more than one coarse region bucket. Group
`roll_up_campaigns()` by `(campaign_id, region, day)` in addition to the campaign total,
apply the same `< 5` suppression floor already used for `reach`, and let the advertiser
see "your CTR in Fresno vs. Clovis" rather than one blended number across the whole
radius. Directly reuses the k-anonymity mechanism already built for `reach`.

**Effort:** M. **Touches:** `campaign_daily` region dimension (or reuse `analytics_daily`
pattern), `roll_up_campaigns()`, `campaign_metrics()` RPC (add region param/breakdown),
advertiser dashboard.

---

## 9. CSV export of campaign metrics (supports manual billing v1)

Manual billing v1 means someone is reconciling "what did this advertiser get for their
money" by hand each cycle. A simple "Export CSV" button on the advertiser dashboard —
client-side `Blob` download of the already-fetched `campaign_metrics()` rows, no new
backend — gives both the advertiser and the ops person doing manual invoicing a
paper trail without building a billing system. Trivial effort, disproportionately useful
given the manual-billing constraint.

**Effort:** S. **Touches:** advertiser console component only (client-side CSV
serialization of existing `campaign_metrics()` response); optionally an admin-side
equivalent for reconciliation.

---

## 10. Admin CTR/click anomaly watch (fraud & bot-click signal)

`ABUSE_AND_LIMITS.md` (A12) owns policing, but analytics can hand it the signal cheaply:
a scheduled query over `campaign_daily` flagging any `(campaign_id, day)` where
`clicks/impressions` exceeds a fixed threshold (e.g. > 15%, well above typical native-ad
CTR) or where `clicks` arrive in an implausibly tight time window (burst detection over
raw `analytics_events` for the flagged day only — cheap because it only runs on the
handful of already-flagged rows, not the full table). Surface flagged campaigns in the
admin CRM (A11) for manual review rather than auto-blocking, keeping this squarely an
analytics signal, not an enforcement mechanism.

**Effort:** S. **Touches:** one SQL view/scheduled query over `campaign_daily` +
targeted `analytics_events` lookup, admin CRM flag list (A11).

---

## 11. Advertiser benchmark context ("your CTR vs. platform average for this surface")

Once #2 (per-surface breakdown) exists, a single additional aggregate query — platform-
wide average CTR per surface per week, computed from all `campaign_daily`/`placement_daily`
rows (admin-only aggregate, never exposing another advertiser's identity or numbers) —
lets the advertiser dashboard show "Your browse CTR: 3.2% (platform median: 2.1%)"
instead of a bare number with no context. This is a strong perceived-value feature (it's
what makes a number feel like insight) for very little marginal engineering once the
per-surface rollup exists.

**Effort:** S (after #2). **Touches:** one platform-wide aggregate rollup/query,
advertiser dashboard comparison tile. Depends on #2.

---

## 12. "Best time to run" scheduling nudge

Once #5's hourly rollup exists, a small derived insight — "your ad's clicks skew
Friday/Saturday evening; consider concentrating your slot-week there" — surfaces
directly from `campaign_hourly` with a `GROUP BY hour, dow ORDER BY ctr DESC LIMIT 3`
query and a one-line UI callout on the campaign creation/scheduling screen. Turns a
descriptive chart into a prescriptive nudge at near-zero extra cost.

**Effort:** S (after #5). **Touches:** one query over `campaign_hourly`, a callout
component on the campaign scheduling flow (A5). Depends on #5.

---

## 13. Served vs. viewable impression rate

`useFeaturedImpression` already only fires `featured_impression` after MRC-style
viewability (≥50% visible, ≥1s) — so today's "impressions" count *is* viewable
impressions, and there's no way to see how many placements rendered but scrolled past
unseen. Adding a cheap, heavily-sampled (e.g. 5%) `featured_render` event fired on mount
(before the viewability gate) gives a `viewable / rendered` ratio per surface — useful
for tuning slot position (e.g. is index-3 in the browse grid actually seen, or is it
below the fold on mobile more often than expected). Lower priority than the others
because current impression counts are already the trustworthy (viewable) number;
this only adds diagnostic depth for placement/layout decisions.

**Effort:** S. **Touches:** `useFeaturedImpression` hook (fire sampled `featured_render`
on mount), `analytics_events` allow-list addition, one rollup column.

---

## 14. Creative-level (per-variant) performance breakdown

If/when `CAMPAIGNS.md` ever supports more than one creative per campaign (A/B rotation),
`ad_impression`/`ad_click` props would need a `creative_id` (today `ad_campaigns.creative`
is a single frozen jsonb blob per campaign, so there's nothing to split yet). Flagging
this now so the event schema reserves the field rather than requiring a breaking change
later: add an optional `creative_id` to the `ad_impression`/`ad_click`/`featured_impression`
props today (defaults to the campaign's single creative), so the day multi-creative
support ships, per-creative CTR comparison is a `GROUP BY` away instead of a schema
migration. Speculative — do this only if A5 confirms multi-creative is on its roadmap.

**Effort:** S now (schema seam) / M later (full breakdown UI). **Touches:**
`ad_impression`/`ad_click` props shape (A4 event taxonomy), `active_featured` RPC
(if creative selection becomes per-variant). Depends on A5 roadmap confirmation.

---

## 15. Organic-vs-featured lift ("halo effect") comparison

For a listing that runs a `detail` or `browse` placement, compare its `bathroom_view`
rate in the weeks immediately before vs. during the campaign (using the same
`listing_daily` rollup from #1) to show a rough "being featured lifted your organic
views by X%" callout. This is explicitly *not* rigorous incrementality (no control group,
seasonal confounds unaddressed) — label it "indicative only," mirroring the existing
honest treatment of email open-rate bias in `ANALYTICS.md` §9.5. Nice-to-have polish for
the advertiser dashboard once #1 and #2 both exist; do it last.

**Effort:** M. **Touches:** query joining `listing_daily` (#1) with `featured_placements`
active windows, advertiser dashboard callout with an explicit "indicative only" caveat.
Depends on #1.

---

## Top picks

**#1** (organic listing analytics) ships the exact promise already sitting in
`BusinessAnalytics.tsx`'s placeholder copy, using events A4 already specs, with zero ad-
system dependency — the clearest win available. **#2** (per-surface breakdown) and **#3**
(funnel visualization) are next: both reshape data the rollups will already contain into
the views advertisers actually need to act on, at S/M effort with no new tracking. Ship
these three first; #4–#9 (engagement-depth split, dwell, frequency distribution, regional
split, CSV export) are the next wave — all cheap extensions of the same rollup machinery.
