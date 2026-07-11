# Custom Tracking Pixel & Conversion Attribution — Feature Ideas

Grounding note: today the only off-platform exit from a Watrloo ad is `ad_campaigns.creative.link`, the optional CTA URL already defined in `INAPP_ADS.md` §6.1 (used by `SponsorSlot`, and extensible to `FeaturedCard`/`FeaturedNearbyStrip`). Everything below hangs a click-ID + postback system off that one existing field rather than inventing a new ad-serving surface. All ideas are additive to `ANALYTICS.md` (A4), `INAPP_ADS.md` (A7), `CAMPAIGNS.md` (A5), `COMPLIANCE.md` (A1), and `ARCHITECTURE.md` (A14) — none re-propose what those docs already own (in-app impression/click events, email pixel/redirect, send-time consent gate, k-anonymity floors, `SECURITY DEFINER`/Edge-Function-as-throat pattern).

## 1. UTM auto-tagging on outbound creative links

Every time `creative.link` is rendered as an `<a href>` (SponsorSlot today; FeaturedCard/strip once they grow off-platform CTAs), append standard `utm_source=watrloo&utm_medium=cpc&utm_campaign=<campaign_id>&utm_content=<placement_id>` before handing the URL to the anchor. This costs zero new infrastructure — no Edge Function, no new table — and gives advertisers attribution in whatever analytics tool they already run (GA4, Shopify analytics, etc.) on day one, while every later idea in this list builds toward richer first-party attribution on top of it. Centralize it as a single `withUtm(link, campaign)` helper next to `disclosure.ts` so it's applied consistently everywhere `creative.link` is used.
**Effort:** S. **Touches:** `src/lib/ads/` (new helper), `FeaturedCard`/`SponsorSlot`/`FeaturedNearbyStrip` (A7). **Ship-first:** yes.

## 2. Watrloo click ID (`wtlclid`) minted and appended at click time

Alongside UTM params, mint a short, random, single-purpose click token (mirrors A4 §9.1's `send_token` and A4 §9.3's signed email-redirect pattern) at the moment `featured_click`/`ad_click` fires, write it to a new `ad_clicks` row (`click_id`, `campaign_id`, `placement_id`, `region`, `occurred_at`, `expires_at`), and append `?wtlclid=<token>` to the outbound `creative.link`. This is the `gclid` analog and the load-bearing primitive every downstream conversion-matching idea depends on — without it there is nothing to match a later conversion back to. Keep the token itself meaningless (random UUID, not derived from `user_id` or any persistent identifier) so it cannot become a cross-site identity graph — see idea 8.
**Effort:** S/M. **Touches:** new `ad_clicks` table (REQUEST TO A2, similar shape to `analytics_events`), `useFeaturedImpression`/click handlers (A7), `analytics-ingest` or a small sibling Edge Function to write the row server-side (client should not be trusted to write its own click_id row, same doctrine as A4 §5.2). **Ship-first:** yes.

## 3. Server-to-server conversion postback endpoint (the privacy-preferred "pixel")

A new Edge Function, `conversion-postback`, that an advertiser's own backend (order-confirmation webhook, CRM, Zapier, etc.) calls directly — no browser involved — passing `{ wtlclid, event_name, value?, currency? }` plus a per-business `webhook_secret` for auth. This is deliberately positioned as the *first* and *preferred* integration path, not the JS snippet (idea 5): it never runs in the converting user's browser, needs no client-side script on the advertiser's site at all, and is immune to ad blockers and browser tracking protections. It is also the cleanest fit for Watrloo's "first-party only, no cross-site tracking" posture (COMPLIANCE.md §6.2) since nothing is *read* from the advertiser's site — only pushed *to* Watrloo, by the advertiser, about their own conversion.
**Effort:** M. **Touches:** new Edge Function `supabase/functions/conversion-postback`, `businesses`/`ad_campaigns` (webhook secret column, REQUEST TO A2), advertiser console docs.
**Ship-first:** yes.

## 4. Click-ID matching + attribution RPC, extending `campaign_conversion`

A `SECURITY DEFINER` RPC (`match_conversion(p_click_id, p_event_name, p_value)`) that looks up the `ad_clicks` row by `wtlclid` within a configurable attribution window (reuse A4 §9.4's existing 7-day click-through / 1-day view-through split), and on a hit inserts a `campaign_conversion` event — extending A4's existing `kind` enum (currently `'bathroom_view'|'review'|'signup'|'directions'`) with a new `'offsite_conversion'` value, `attribution: 'click'`. This is the piece that actually turns raw postbacks/pixel fires into the metric advertisers came for, and it slots directly into `roll_up_campaigns()` and `campaign_daily` — no new rollup machinery needed.
**Effort:** M. **Touches:** `ANALYTICS.md` `kind` CHECK constraint (REQUEST TO A2), `campaign_daily` (+`offsite_conversions` column), `roll_up_campaigns()`. **Ship-first:** yes.

## 5. Lightweight client-side conversion snippet (the actual "pixel" tag)

For advertisers without backend webhook capability (most small single-location businesses — Watrloo's core customer per `PRICING.md`), ship a tiny (<2 KB) JS snippet — `<script src="https://watrloo.com/p.js" data-biz="...">` plus a `watrloo('conversion', {event_name, value})` call — that (a) reads `wtlclid` from the current URL or a short-lived, **first-party-to-the-advertiser** `localStorage` key (never a Watrloo-set cookie, never cross-site storage) and (b) POSTs it to the same `conversion-postback` endpoint from idea 3. Framing this explicitly as "postback preferred, pixel is the fallback for advertisers who can't do server-side" keeps the product honest about which integration is lower-risk and keeps the JS snippet itself dumb (no fingerprinting, no third-party cookie, no reading anything about the visitor beyond the one click-ID Watrloo itself issued).
**Effort:** M. **Touches:** new static asset served from R2 or GH Pages, `conversion-postback` Edge Function (shared with idea 3), advertiser console setup docs.
**Ship-first:** no (ships once 2–4 are proven; postback-only v1 is legitimate).

## 6. Advertiser conversion dashboard — aggregate, k-floored

Extend the existing `campaign_metrics`/`campaign_stats` RPC pattern (ANALYTICS.md §6, CAMPAIGNS.md §7.3) to surface `offsite_conversions`, offsite conversion rate, and (once idea 7 lands) total conversion value — all read from `campaign_daily`, all k-anonymity-floored exactly like every other advertiser-facing number in the codebase. No new access-control pattern needed; this is pure reuse of A4 §6/§7's existing `is_business_member` + floor-of-5 machinery.
**Effort:** S/M. **Touches:** `ADVERTISER_CONSOLE.md` (A10), `campaign_metrics()` RPC.

## 7. Conversion value & event-type taxonomy

Let both the postback (idea 3) and the pixel (idea 5) optionally carry `event_name` (allow-listed: `purchase|lead|signup|booking|custom`) and `value`/`currency`, stored on the `campaign_conversion` event's `props` (same "IDs and enums only" discipline A4 already enforces on every other event). This is what turns "conversions" into something an advertiser can eventually compare against ad spend (cost-per-conversion, and later ROAS once billing exists) — cheap to add once idea 4's matching RPC exists, expensive to bolt on retroactively if the schema doesn't allow for it from day one.
**Effort:** S. **Touches:** `campaign_conversion` props schema (A4 §4), `match_conversion()` RPC signature.

## 8. Click-ID TTL, hashing, and auto-purge (compliance hardening)

Formalize `ad_clicks.click_id` as opaque, random, and *expiring* — auto-purged (or `user_id`-style anonymized) after the attribution window closes (7 days click-through, same cadence as A4's `analytics_events` retention story in §8). This is what keeps the whole feature on the safe side of `COMPLIANCE.md` §6.2's "no cross-context behavioral advertising" conclusion: a click ID that dies after a week and was never derived from a persistent identifier cannot become a cross-advertiser identity graph, which is the single biggest way a feature like this could silently convert Watrloo into something CPRA calls "sharing." Worth calling out explicitly rather than assuming idea 2 gets this right by default — a `pg_cron` purge job here is cheap insurance against the scariest failure mode in this whole domain.
**Effort:** S. **Touches:** `pg_cron` purge job (mirrors A4 §8 / A1 §8.1 retention pattern), `COMPLIANCE.md` retention table (add `ad_clicks` row).

## 9. Postback signature verification + replay protection

HMAC-sign every `conversion-postback` payload with a per-business secret (rotatable from the advertiser console), reject requests without a fresh timestamp + nonce, and rate-limit per business/IP (reuse the shared limiter referenced in A4 §5.2 / `docs/ops/RATE_LIMITING.md`). Without this, a competitor — or the advertiser's own buggy retry logic — can flood fake conversions and either poison the advertiser's own metrics or (once billing is usage-linked) create a billing-fraud vector. This should ship in the same PR as idea 3, not as a later hardening pass.
**Effort:** S/M. **Touches:** `conversion-postback` Edge Function, shared rate limiter, `ABUSE_AND_LIMITS.md` (A12).

## 10. Duplicate-conversion suppression & anomaly flagging

Dedupe on `(click_id, event_name)` so a retried postback or a double-fired pixel counts once, and flag campaigns whose conversion rate or volume spikes anomalously (e.g., >10x trailing average in an hour) into the same admin review surface `ABUSE_AND_LIMITS.md`/`ADMIN_CRM.md` already use for campaign moderation. This is the difference between a metric advertisers trust and one they quietly stop looking at.
**Effort:** M. **Touches:** `match_conversion()` RPC (unique constraint), `ADMIN_CRM.md` (A11) review queue.

## 11. Offline/CRM conversion import (CSV upload)

For advertisers whose conversion is fully offline (walk-in customer, phone booking) and never touches a web postback, let them upload a CSV of `{wtlclid, conversion_date, value}` (or a hashed customer identifier, see idea 14) from the advertiser console; matched through the same `match_conversion()` RPC as everything else. This is a standard feature in every mature ad platform (Google Ads offline conversion import, Meta CRM upload) and is *inherently* lower privacy risk than a live pixel since there's no browser tracking involved at all — just a batch join against Watrloo's own click log.
**Effort:** M. **Touches:** `ADVERTISER_CONSOLE.md` (A10) upload UI, `match_conversion()` batch variant.

## 12. Redirect-chain fallback for blocked pixels

Ad blockers and browser tracking-protection lists increasingly block anything that looks like a third-party pixel domain. As a fallback, offer advertisers a one-time redirect wrapper (`https://watrloo.com/e/conv/<token>`) they point their thank-you-page's *next* redirect at instead of firing JS — the Edge Function records the conversion via a 302 in the same request/response cycle the browser was already making, no separate fetch/pixel required, using the same open-redirect allow-list discipline A4 §9.3 already established for email click redirects.
**Effort:** M. **Touches:** new Edge Function route, reuses A4 §9.3's signed-redirect pattern.

## 13. Snippet/webhook setup wizard in the advertiser console

A guided UI that generates the exact copy-paste snippet or webhook config for common platforms (Shopify order webhook, WordPress plugin snippet, plain-HTML `<script>` tag), pre-filled with the business's own `campaign_id` and webhook secret. Pure integration-friction reduction once ideas 3/5 exist — doesn't add capability, but is very likely the difference between advertisers actually installing this and it sitting unused.
**Effort:** M. **Touches:** `ADVERTISER_CONSOLE.md` (A10) UI only.

## 14. Hashed-identifier server-side matching (CAPI-style backstop)

For advertisers who want conversion matching to survive click-ID loss (URL param stripped by a redirect chain, ITP, etc.), let them optionally POST a SHA-256 hash of a customer identifier they already collect (email/phone) at conversion time as a secondary match key. This is the closest analog to Meta's Conversions API / Google Enhanced Conversions, and it is explicitly the riskiest idea on this list from a compliance standpoint — it means Watrloo would need to receive and (briefly) hold a hashed PII fragment from a third-party site, which brushes directly against the "advertisers never receive/send PII" invariant `COMPLIANCE.md` §9 and §6.2 lean on for the "no sale/share" conclusion. Ship only after explicit A1/counsel sign-off, one-way-hash-only, ultra-short TTL, and probably behind an opt-in flag per advertiser.
**Effort:** L. **Touches:** `COMPLIANCE.md` (A1) — requires new analysis, not just an implementation note; `conversion-postback` payload extension.

## 15. Multi-touch attribution model selector

Let advertisers with high-consideration purchases choose between last-click (default), first-click, or linear attribution when a user has multiple ad clicks before converting. Genuinely useful at scale, but speculative for a launch feature set aimed at single-location small businesses where last-click is almost always sufficient — the highest-effort, lowest-near-term-value idea here.
**Effort:** L. **Touches:** `match_conversion()` RPC (multi-row lookback), `ADVERTISER_CONSOLE.md` (A10) settings UI.

---

**Top picks:** Ship UTM auto-tagging (1) immediately — it's free and works today with zero new infra. Follow with the click-ID mint (2) and the server-to-server postback endpoint (3): together they're the minimum viable "pixel" and, being server-to-server first, the most defensible privacy posture to launch with. The client-side JS snippet (5) and richer dashboards/imports follow once postback attribution (4) is proven and idea 8's TTL/purge hardening is in place alongside it.
