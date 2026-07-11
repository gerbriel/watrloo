# Offline / Foot-Traffic Attribution — Feature Ideas

**Top picks:** Ship the redemption-code mechanic first — it's the only thing that
proves a physical visit, everything else is instrumentation around it. QR is a
thin, near-free layer on top of the same code. Wiring redemption into the
`campaign_conversion` event that `ANALYTICS.md` §9.4 already designed (7-day
click / 1-day view attribution windows, `campaign_daily` rollups) turns a raw
redemption count into a trustworthy advertiser metric for almost no new surface.

Ranked by value-to-effort. Builds additively on `LOCATION.md` (coarse, opt-in,
never stored precisely), `ANALYTICS.md` (event taxonomy, Tier A/B consent,
`campaign_conversion`), `INAPP_ADS.md` (`ad_campaigns`, `featured_placements`,
disclosure rules), and `COMPLIANCE.md` (opt-in-only, admin-only raw data,
k-anonymized aggregates). The existing map "near me" uses a **one-shot**
MapLibre `geolocate.trigger()` — no continuous tracking exists today, and
nothing below adds any.

---

## 1. Single-use redemption codes + a cashier console a gas station can run

The bedrock mechanic: a business running a campaign generates a short (4–6
char), single-use, human-readable code per offer. The customer shows the code
on their phone at checkout; the cashier types it into a **one-field, oversized,
touch-friendly `/business/redeem` screen** already authenticated via the
business's existing staff login. A `SECURITY DEFINER` RPC (`redeem_code`)
validates the code is unexpired, unused, and belongs to a `running` campaign,
marks it consumed atomically, and returns a green "Redeemed" / red "Already
used" — no ambiguity, no PII shown to the cashier. This needs one new table
(`redemption_codes`: code, campaign_id, bathroom_id, issued_to session/user,
status, redeemed_at) and extends `ad_campaigns.type` with a `'redemption'`
kind or a sibling table, mirroring the existing `ad_campaigns`/`featured_placements`
pattern in `DATA_MODEL.md`. This is the only idea on this list that actually
produces "proof of a physical visit" — everything else measures around it.
**Effort:** M. **Touches:** `DATA_MODEL.md` (new table + RPC), `CAMPAIGNS.md`
(campaign type), business console (new route). **Ship-first:** yes

## 2. QR-code redemption (scan instead of type)

Encode the same short code from #1 into a QR that resolves to
`watrloo.com/r/<code>` when scanned by any phone camera — no in-app scanner
needed on the cashier's side, no library, no camera permission prompt for the
business. Opening the link on a device already signed into the business
console one-taps to the same `redeem_code` RPC from #1; opened by anyone else
it shows a harmless "show this to the cashier" page. This removes typos and
speeds up the register interaction to a single glance-and-tap, at almost zero
marginal backend cost since it reuses #1's code and RPC verbatim — the whole
addition is a QR-render component and one public landing route.
**Effort:** S. **Touches:** `src/components/business` (QR render), one public
route, no new tables. **Ship-first:** yes

## 3. Wire redemptions into the `campaign_conversion` attribution model

`ANALYTICS.md` §9.4 already designed a `campaign_conversion` event with a
7-day click-through / 1-day view-through attribution window and a
`campaign_daily.conversions` rollup — it just has no `kind` for a redemption
yet. Add `kind='redemption'` (and `kind='visit_confirmed'` for idea #4) to the
existing enum, and have `redeem_code` emit the event server-side with the
attribution stamped from the session's last `directions_tap`/`ad_click`. This
turns raw redemption counts into a metric an advertiser can actually trust
("142 directions taps → 37 redemptions within the attribution window") using
infrastructure that's already fully specified — it's almost pure wiring, no
new consent surface, no new table beyond a one-line CHECK constraint edit.
**Effort:** S. **Touches:** `ANALYTICS.md` event taxonomy, `DATA_MODEL.md`
CHECK constraint, `roll_up_campaigns()`. **Ship-first:** yes

## 4. Opt-in one-shot "Confirm I'm here" arrival check

An explicit button on the bathroom detail page — never automatic, never
background — that fires a single `navigator.geolocation.getCurrentPosition()`
call (same one-shot posture as the existing map control) and sends the
coordinate to a `confirm-arrival` Edge Function. The function computes
distance to the bathroom's stored lat/lng, returns a boolean match, and
**discards the raw coordinate immediately** — mirroring `LOCATION.md`'s
"resolve then discard the IP" pattern. Only a boolean `visit_confirmations`
row (user/session, bathroom_id, campaign_id, confirmed_at) is stored — never a
point. This is the strongest proof-of-presence signal available without a POS
integration, and it stays inside the "explicit-action, opt-in, no location
history" constraint by construction.
**Effort:** M. **Touches:** new Edge Function, minimal table, `BathroomDetail.tsx`
button. **Ship-first:** no

## 5. Aggregate redemption funnel dashboard for advertisers

Extend the `BusinessAnalytics.tsx` placeholder (which today literally says "we
don't collect that telemetry yet") with a redemption funnel:
impressions → directions taps → redemptions, by day, k-anonymized at the same
floor (`< 5`) `ANALYTICS.md` §6 already applies to `campaign_metrics`. This is
mostly a read-side extension of the `campaign_metrics` RPC and `campaign_daily`
rollup once #3 exists — no new consent question, just a new column and a chart.
**Effort:** M. **Touches:** `campaign_daily` rollup, `campaign_metrics()` RPC,
`BusinessAnalytics.tsx`. **Ship-first:** no

## 6. Two-tier trust label: "claimed" vs. "location-verified" redemption

Once #1 and #4 both exist, tag each redemption as `verified` if a matching
`visit_confirmations` row landed within a tight window (e.g. ±30 min) of the
redemption, else `claimed`. Show advertisers the split ("68% of redemptions
were location-verified") rather than inventing a new mechanic — this is a
join and a percentage on data both other ideas already produce, and it's the
kind of number that makes redemption counts credible to a skeptical advertiser
without ever storing more location data than #4 already discards.
**Effort:** S. **Touches:** redemption RPC output, advertiser dashboard.
**Ship-first:** no

## 7. Post-visit review nudge inside the attribution window

If a session had a `directions_tap` on a bathroom and the app is reopened
within the campaign's attribution window (reuses the 7-day click / 1-day view
split from #3), show a generic "Did you find this bathroom? Leave a review"
prompt — the *same* prompt every listing already could show, just timed off
the tap. This closes the "review-after-visit correlation" ask from the
consented, attributed side, while staying structurally incapable of touching
review content or ranking: the nudge only ever opens the existing review
composer, and `campaign_conversion{kind:'review'}` is the analytics-side
record, never anything written to the review row itself.
**Effort:** S/M. **Touches:** client toast/banner, existing review composer,
event wiring from #3. **Ship-first:** no

## 8. Weekly foot-traffic digest email to advertisers

A scheduled `pg_cron` job rolls the week's `campaign_daily` numbers
(impressions, directions taps, redemptions, verified %) into a short email
sent through the already-designed Resend pipeline (`EMAIL_DELIVERY.md`) to
business members. Cheap to build — it's a template and a query over data
every other idea here already produces — and it's the thing that actually
gets a distracted gas-station owner to open the dashboard instead of churning.
**Effort:** S. **Touches:** new cron job, email template, existing send
pipeline. **Ship-first:** no

## 9. Printable register QR sticker that never needs reprinting

A "Print register sticker" button in the business console generates a QR
pointing at a **stable, bathroom-scoped** URL (`watrloo.com/r/at/<bathroom_id>`)
that server-resolves to *whatever redemption code is currently active* for
that location — so the owner prints one sticker once and every future
campaign just works without a new sticker. Solves the real-world adoption
problem (a cashier taping a fresh QR to the register every week is how this
feature dies in practice) for a small, mostly client-side addition on top of
#1/#2.
**Effort:** S. **Touches:** business console button, one resolver route.
**Ship-first:** no

## 10. Codes expire with the campaign, by construction

`redeem_code` (from #1) rejects any code whose parent `ad_campaigns.status`
isn't `'running'` or whose `now()` falls outside `starts_at`/`ends_at` —
reusing the campaign lifecycle state machine `CAMPAIGNS.md` already owns
instead of inventing separate expiry logic. Prevents stockpiled/screenshotted
codes from working after a campaign ends or is paused, and it's a two-line
WHERE clause, not a new system.
**Effort:** S. **Touches:** `redeem_code` RPC validation only. **Ship-first:** no

## 11. Redemption anti-fraud guardrails

Before redemption counts feed any billing (CPC/CPM is flagged as a future
phase in `ABUSE_AND_LIMITS.md` §6), apply the same posture that section
already uses for click fraud: exclude redemptions triggered by the
advertiser's own `business_members`, rate-cap redemption attempts per
session/business (reusing the `RATE_LIMITING.md` fixed-window primitive), and
flag campaigns whose redemption rate is an implausible multiple of the
region's baseline for admin review rather than silent auto-trust. Cheap
insurance that keeps the metric advertisers are asked to trust actually
trustworthy.
**Effort:** S/M. **Touches:** `ABUSE_AND_LIMITS.md` extension, `redeem_code`
RPC. **Ship-first:** no

## 12. Verified-visit signal as an internal trust input only — never public

A `visit_confirmations` match (#4/#6) is a strong real-world signal that could
help downstream fraud/spam detection (e.g. weighting a review as more likely
genuine for internal moderation heuristics in `RANKS.md`) — but it must never
be displayed on the review itself, never affect review ordering, and never be
disclosed to the business. This keeps the hard "ads never touch reviews"
boundary intact by making the signal purely internal plumbing, useful to
admins/moderation only, structurally invisible to advertisers and readers.
**Effort:** M. **Touches:** internal moderation signal only; explicitly no UI.
**Ship-first:** no

## 13. Before/after foot-traffic lift report

Once enough weeks of `campaign_daily` data exist, compare a bathroom's
redemption/directions-tap rate during an active campaign window against its
own trailing baseline (same listing, weeks without a campaign) and show
advertisers a lift multiple ("directions taps ran 2.4× baseline during your
campaign"). This is the most persuasive number a small advertiser could see,
but it needs real data volume and careful baseline handling to not overclaim
on thin samples — the highest-effort idea here, worth doing once #1–#5 have
been live long enough to have a baseline to compare against.
**Effort:** L. **Touches:** new comparison RPC, advertiser dashboard.
**Ship-first:** no

---

**Summary.** Ship #1–#3 together: a single-use redemption code with a
one-field cashier screen, a QR variant that removes typing, and wiring the
result into the `campaign_conversion` attribution model `ANALYTICS.md`
already designed. That trio is the entire "prove a physical visit happened"
capability; everything after it (#4–#13) is trust-building, fraud-proofing,
or convenience layered on the same three primitives — none of it requires
inventing new consent surfaces or storing anything beyond what `LOCATION.md`
and `COMPLIANCE.md` already permit.
