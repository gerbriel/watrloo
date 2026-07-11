# A/B Testing & Creative Optimization — Ideas

**Reality check (read this before the list):** Watrloo's ad inventory is 5
slot-weeks/region/week (INAPP_ADS.md §5.1) capped at ≤3 impressions/placement/day
per viewer (§5.3). A single local campaign will realistically see **tens to a
few hundred clicks over its whole run**, not the thousands a naive two-sample
z-test or "95% significant" badge assumes. At n=80 clicks split two ways, a
fixed-horizon p-value is close to a random number generator, and "peeking" at a
dashboard that recomputes p daily will produce false positives constantly (the
optional-stopping problem). Every idea below is chosen to be **honest at this
volume**: Bayesian Beta-Binomial posteriors instead of p-values, priors
borrowed across campaigns instead of assuming each new advertiser starts from
zero information, bandits instead of fixed 50/50 splits (bandits waste less
budget finding out what a hypothesis test would need thousands of clicks to
"prove"), and UI that says "not enough data yet" instead of manufacturing false
confidence. Nothing here touches reviews, ratings, or per-user profiles — all
variant selection is contextual (surface + region, same as INAPP_ADS.md §3) and
all stats are aggregate/campaign-level, computed in Postgres.

**Top 3 picks:** (1) store 2+ creative variants per campaign with a
session-seeded split — the primitive everything else needs; (2) replace
raw CTR% with Beta-Binomial credible intervals so the console never lies about
certainty; (3) a Thompson Sampling bandit for variant traffic, because at this
volume a bandit out-earns a fixed split and out-honests a p-value.

---

## 1. Two-variant creative storage + session-seeded split

`ad_campaigns.creative` today (per `Campaigns.tsx`, `src/lib/api/growth.ts`) is
a single `{title, body, link}` jsonb blob — there is no variant concept at all.
Add `creative_variants jsonb[]` (2–3 entries, same shape as today's `creative`
plus a `variant_id`) alongside the existing single `creative` field (kept as
the frozen fallback for non-tested campaigns, zero migration risk). Selection
reuses the exact pattern INAPP_ADS.md §5.2 already specifies for rotating
advertisers into one browse cell: a session-seeded hash (`hash(session_id) %
n`) picks a variant, stable within a session so nobody sees a card flip
between headlines on re-render, spread evenly across sessions. This is the
foundation — nothing else on this list works without a place to put a second
creative and a stable way to show it. Extend `active_featured`'s returned
`creative` to include the chosen variant's `variant_id` so impression/click
events can be attributed per-variant.

**Effort:** S
**Touches:** `ad_campaigns.creative_variants` (new column), `active_featured`
RPC (INAPP_ADS.md §6.1), `src/lib/api/featured.ts` (`FeaturedItem.variantId`),
`pickRotated`/session-seed helper (§5.2), `src/pages/business/Campaigns.tsx`
composer (add a second creative form), `src/lib/api/growth.ts`
**Ship-first:** yes

## 2. Bayesian Beta-Binomial posteriors + credible intervals (kill the naive %)

Every place a CTR is shown to an advertiser today would naturally render
`clicks/impressions` as a bare percentage. Don't. Model each variant's
click-through as Beta(prior_α + clicks, prior_β + impressions − clicks) and
show a posterior mean with a 90% credible interval ("~4.1% clicks, likely
2.1%–6.8%") instead of a point estimate or a red/green "winner" badge. This is
a `SELECT` over `campaign_daily` (ANALYTICS.md §7.1, already tracks
impressions/clicks per campaign/day) — no new infra, just an
`inverse_incomplete_beta`-style quantile function (Postgres has no native
beta-inverse, but a ~20-line Newton's-method plpgsql function over the regularized
incomplete beta, or a lookup-table approximation, is enough for 90%/50%/10%
quantiles). This directly satisfies the "keep advertiser-facing stats honest"
constraint and is cheap relative to the trust it buys.

**Effort:** S/M
**Touches:** new `campaign_variant_daily` rollup (extends `campaign_daily`
pattern with `variant_id`), a `beta_quantile()` SQL helper, `campaign_metrics()`
RPC (ANALYTICS.md §6) extended to return `{mean, ci_low, ci_high}` per variant,
advertiser console (`BusinessAnalytics.tsx` / `Campaigns.tsx`)
**Ship-first:** yes

## 3. Thompson Sampling bandit for variant traffic allocation

Once §1's variants exist, offer (or default to, see #9) allocating traffic by
**Thompson Sampling** instead of a fixed split: on each selection, draw a
sample from each variant's current Beta posterior and show the variant with
the highest draw. This is the textbook honest answer to "low volume" — a
bandit minimizes *regret* (clicks lost to showing the losing variant) without
ever needing a significance threshold, and it naturally degrades to
near-50/50 when variants are statistically indistinguishable and converges
fast when one is clearly better. Because selection must stay client-cheap and
stateless (static SPA + Supabase, no server-side session), compute is a
lightweight RPC: `select_variant(campaign_id, surface, region)` reads current
`(clicks, impressions)` per variant from `campaign_variant_daily`, samples
Beta via Postgres's `random()` + inverse-CDF approximation, and returns the
chosen `variant_id` — called once per page load and cached for the session
(same cadence as `active_featured`).

**Effort:** M
**Touches:** `select_variant()` RPC (new), `campaign_variant_daily` rollup
(shared with #2), `src/lib/api/featured.ts` (call bandit RPC when
`creative_variants.length > 1`), `useFeaturedImpression.ts` (tag events with
chosen `variant_id`)
**Ship-first:** yes

## 4. Minimum-exposure floor before the bandit is allowed to converge

A pure Thompson Sampling bandit can prematurely starve a variant that had one
unlucky early streak — at n=10 impressions a Beta(1,1) prior is still mostly
noise. Add a hard floor: each variant must accumulate **≥50 impressions**
(configurable) before the bandit's sampling is allowed to drift past a
70/30-ish split; below the floor, force an even split regardless of what the
posteriors say. This is a guardrail on #3, not a separate system — cheap to
add, and it's the difference between "bandit" and "bandit that looks
scientific but is actually just recency bias at n=8."

**Effort:** S
**Touches:** `select_variant()` RPC (add floor check before sampling)
**Ship-first:** no

## 5. Pooled priors — borrow strength across campaigns (empirical Bayes)

A brand-new campaign starts with zero data and, worse, a flat Beta(1,1) prior
implies "anywhere from 0% to 100% CTR is equally likely," which is absurd —
we already know roughly what CTR looks like for `browse` cards in general.
Instead, set each variant's *prior* from the platform-wide rolled-up CTR for
that `(surface, region_tier)` bucket (computed nightly from all campaigns'
`campaign_variant_daily`, weighted by recency), e.g. prior ≈ Beta(k·p̄, k·(1−p̄))
with a small effective sample size k (~10–20) so real data quickly dominates.
This is what makes posteriors and the bandit *honest* at low N — instead of
pretending we know nothing, we start from "similar ads on this surface
usually get ~X%," which shrinks noisy small-sample estimates toward a
sensible baseline rather than either extreme.

**Effort:** M
**Touches:** new `surface_ctr_prior` rollup (pg_cron, mirrors
`roll_up_campaigns()`, ANALYTICS.md §7.2), `campaign_metrics()` and
`select_variant()` both read it as the prior instead of a hardcoded Beta(1,1)
**Ship-first:** no

## 6. "Not enough data yet" — an explicit honest floor state in the UI

Below some minimum sample size (e.g. <30 total clicks across variants — the
same k-anonymity-style floor ANALYTICS.md already uses elsewhere, §2.3/§6),
the console shows **only raw counts** ("Variant A: 4 clicks / 210 views,
Variant B: 7 / 198 — too early to tell") with zero rates, zero intervals, zero
"leading" language. This is a UI-only rule sitting on top of #2's numbers, but
it's the single cheapest way to stop an advertiser (or a future dashboard
widget) from over-reading noise as a trend, and it costs almost nothing to
build since the data's already there.

**Effort:** S
**Touches:** advertiser console component (wherever #2's numbers render);
pure client-side threshold logic, no new backend
**Ship-first:** no

## 7. Auto-promote winner via expected-loss stopping rule, not p<0.05

For advertisers who want the system to just pick a winner and stop splitting
traffic, define "done" as a Bayesian decision rule instead of a p-value:
stop when `P(variant A is best) > 0.95` **and** the expected loss from
picking A if wrong is below a small tolerance (e.g. <0.5 percentage points of
CTR) — both computable by Monte Carlo sampling from the two Beta posteriors
(a few thousand draws in a plpgsql/pg_cron job is trivial). This is the
correct generalization of "statistically significant" for decision-making
under small samples, and unlike a fixed-horizon p-value it's valid to check
on every cron tick without inflating false-positive rate (no "peeking"
problem — the criterion is a posterior probability, not a repeated
significance test).

**Effort:** M
**Touches:** pg_cron job (daily) reading `campaign_variant_daily`, writes
`ad_campaigns.winning_variant_id` when criteria met; `select_variant()` short-
circuits to the winner once set; audit row in `moderation_actions`-style log
(actor=`scheduler`) so an advertiser can see *why* it converged
**Ship-first:** no

## 8. Frequency-cap-aware exposure accounting

INAPP_ADS.md §5.3 caps a viewer at ≤3 impressions/placement/day and ≤10/surface/
day. That's good for spam prevention but it quietly biases naive CTR: a viewer
who would have clicked on their 4th daily exposure never gets the chance, and
heavy browsers (who see more repeat impressions of the *same* ad) pull the
denominator up without a matching pull on clicks, since most people who'll
click do so on a first or second view. Before trusting variant CTR numbers,
dedupe: compute CTR from **unique-viewer-days** as the impression denominator
(available from `analytics_events`' `session_id`/`user_id` grouping) rather
than raw impression rows, so a single engaged session hitting the frequency
cap doesn't dilute the rate. Small fix, meaningfully more honest.

**Effort:** S/M
**Touches:** `campaign_variant_daily` rollup query (ANALYTICS.md §7.2 style,
`count(distinct session_id/user_id, day)` instead of `count(*)`)
**Ship-first:** no

## 9. Advertiser-facing toggle: "Optimize automatically" vs "Even split"

Some advertisers want max clicks (bandit, #3); some want a clean, explainable
comparison to learn which message resonates ("which of these two taglines do
locals prefer") — a converging bandit answers the first question well but
under-samples the loser, weakening the *comparison* itself. Expose both modes
in `Campaigns.tsx`'s composer: `optimize` (Thompson Sampling) or `even_split`
(fixed 50/50 for the campaign's duration, only using #2's posteriors to
*report*, never to reallocate). Default to `optimize` since most local
advertisers care about performance, not research rigor, but the honest thing
is to let them choose and explain the tradeoff in one sentence.

**Effort:** S
**Touches:** `ad_campaigns.split_mode` enum column, `Campaigns.tsx` composer
UI, `select_variant()` branches on it
**Ship-first:** no

## 10. Creative fatigue detection (CTR decay over a placement's lifetime)

Track each variant's daily CTR as a short trailing series from
`campaign_variant_daily` and flag decay: if a 7-day trailing average CTR drops
below ~60% of its first-week average (and the variant still has meaningful
daily impressions, so this isn't just low-N noise), surface "This creative's
click rate has faded — consider refreshing the message" in the console. Local
directory ad audiences are small and get repeat exposure fast (same city,
same 3/day cap), so fatigue is a real and fast-moving risk here, more than for
a large national campaign with constant audience turnover. Purely descriptive
— no auto-pause — since decay could also just be a fading novelty effect
worth living with.

**Effort:** S/M
**Touches:** `campaign_variant_daily` rollup (already exists for #2), a
trend-detection query or small pg_cron job, console flag/badge
**Ship-first:** no

## 11. Pre-submission expectation calculator ("how long until we're confident")

Before an advertiser submits a two-variant campaign, use the region's
historical impression volume (already computed for `campaign_estimated_reach`,
CAMPAIGNS.md §2.2/§2.3) plus the pooled prior CTR (#5) to show: "At this
region's typical traffic (~X views/week), expect ~Y clicks/week split across
2 variants — usually 3–5 weeks before we're confident which one wins." This
sets expectations honestly at compose time rather than leaving the advertiser
to discover for themselves, mid-campaign, that 40 clicks isn't enough to tell
anything apart — a direct, low-effort application of the reality-check this
whole ideation domain rests on.

**Effort:** S
**Touches:** `campaign_estimated_reach()` RPC (CAMPAIGNS.md §2.2, already
exists), `surface_ctr_prior` (#5) or a flat platform-average fallback if #5
isn't built yet, `Campaigns.tsx` composer
**Ship-first:** no

## 12. Cross-advertiser creative-pattern benchmarks (privacy-safe feature buckets)

Aggregate *coarse features* of creative — not raw text — across all campaigns
platform-wide: has_image (bool), tagline_length_bucket (short/medium/long),
has_discount_percent (bool), has_cta_verb (bool). Roll these into a
`creative_feature_daily` table joined against `campaign_variant_daily`'s
clicks/impressions, k-anonymized the same way ANALYTICS.md floors advertiser
metrics (<5 distinct businesses contributing to a bucket ⇒ suppressed). Surface
as a one-line platform benchmark in the composer: "Sponsored cards with a
photo get ~30% more clicks on browse, platform-wide." This gives every new
advertiser — even one who's never run a test before — an informed starting
prior, and it's the natural extension of #5 from "CTR baseline" to "which
*kind* of creative tends to win," while staying strictly aggregate (no raw
creative text stored beyond what's already in `ad_campaigns.creative`, no
per-user anything).

**Effort:** M/L
**Touches:** new `creative_feature_daily` rollup + feature-extraction step
(regex/heuristics over `creative_variants` at write time, not per-user data),
pg_cron aggregation, composer UI benchmark strip
**Ship-first:** no

## 13. Contextual bandit sharing learning across surfaces

Today's design (rightly) treats `map`/`browse`/`detail` as separate
placements with separate inventory (INAPP_ADS.md §5.1). If the *same*
creative variant runs on more than one surface (a business buying both a
browse and detail slot-week), a per-surface-isolated bandit (#3) throws away
information — 40 browse clicks and 15 detail clicks about the same tagline
are both evidence about that tagline's pull. Extend `select_variant()` to a
lightly contextual bandit: pool clicks/impressions for the same
`(business_id, variant creative hash)` across surfaces, with a
surface-specific offset term (browse structurally gets more traffic than
detail) rather than fully separate posteriors. Meaningful lift only for
advertisers running multi-surface campaigns, hence lower priority than the
single-surface primitives above.

**Effort:** L
**Touches:** `select_variant()` RPC (generalize to pool by variant content
hash, not just campaign_id), `campaign_variant_daily` schema (add a
surface-offset term or hierarchical model)
**Ship-first:** no

## 14. Shadow-mode simulated preview for first-time advertisers

For an advertiser who has never run a test before, let them preview what a
2-variant test *would* look like using synthetic draws from the pooled prior
(#5) at their chosen budget/region before they spend anything — "Here's a
simulated 4-week run at your traffic level" showing a plausible (not real)
sequence of daily clicks/impressions and how the credible interval in #2
would have narrowed over time. Purely educational — clearly labeled as
simulated, never blended with real data — but it makes the "low volume"
reality tangible instead of abstract, and it's a natural teaching surface for
why a bandit (#3) beats a naive 50/50 read for their specific traffic level.

**Effort:** M
**Touches:** client-side Monte Carlo simulation using #5's prior params
(no new backend if the prior RPC already exists), composer UI (preview panel)
**Ship-first:** no

---

**Top-picks summary:** Ship #1 (two-variant storage + session-seeded split)
first since every other idea depends on having a second creative to compare;
pair it immediately with #2 (Beta-Binomial credible intervals) so the console
never shows a bare, misleading CTR%; then #3 (Thompson Sampling bandit) turns
the low click volume from a liability into the reason to prefer a bandit over
a fixed split in the first place.
