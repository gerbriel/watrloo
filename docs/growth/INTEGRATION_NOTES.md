# Integration notes (orchestrator)

Written by the integrating orchestrator after all 14 design agents completed.
Read this alongside `README.md` (index + rollout) and `DATA_MODEL.md` (canonical
schema). It records cross-doc resolutions, known staleness, and the decisions
that belong to the owner — so the implementer doesn't rediscover any of it.

## Canonical resolutions (bind all docs)

| Topic | Resolution | Where |
| --- | --- | --- |
| `campaign_sends` idempotency | Unique on `(campaign_id, user_id, occurrence_key)` — A5's form. A6's earlier 2-column assumption is subsumed (single-occurrence campaigns hold `occurrence_key` constant). | DATA_MODEL.md addendum |
| k-anonymity floor for reach/segment previews | One canonical, config-stored number (see DATA_MODEL.md addendum; recommended 30). A10's UI reads the config; its "default 100" prose is superseded. | DATA_MODEL.md addendum |
| Config table name | `growth_settings` (A5/A2). A12's `growth_config` = the same table; treat as an alias in prose. | DATA_MODEL.md |
| Consent row | FOUR fields beyond location/marketing: `analytics_opt_in` (A4's third toggle) and `newsletter_opt_out` (A8's stream-level opt-out). GPC precedence: a detected GPC signal overrides stored opt-ins for CA "sharing" and kills identified analytics. | DATA_MODEL.md addendum + COMPLIANCE.md |
| Newsletter | A `featured_placements` row with `surface='newsletter'`; a whole edition counts as ONE send toward the user's 3-per-7-days cap; each embedded advertiser slot consumes one `featured_per_week` activation. | NEWSLETTER.md |
| IP-geo source (A14's D4) | **RESOLVED — self-hosted MaxMind GeoLite2** (.mmdb on R2, read in the Edge Function; IP resolved then discarded, never stored; city-centroid only, ≥5km accuracy floor; Tue/Fri refresh; attribution required in policy v2). | LOCATION.md |
| Resend rate limit | 5 req/s with `retry-after` (A6, verified) — supersedes A5's 2 req/s mention. | EMAIL_DELIVERY.md |
| Per-advertiser sub-cap | Within the global 3/7d cap, at most 1 message/7d from the SAME advertiser. | ABUSE_AND_LIMITS.md |
| Featured fairness | Anti-monopoly cap `ceil(slots/2)` per (surface, region, week); waitlist-credit round-robin; tier weight breaks ties but cannot buy 100%. | ABUSE_AND_LIMITS.md |

## Known staleness (minor; addendum + this file are authoritative)

These docs were written or last revised before late relays landed. The gaps are
one-term each; do NOT "fix" them by redesigning — the canonical text lives where
noted above.

- `EMAIL_DELIVERY.md` — predates A5's `occurrence_key`; its claim RPC must
  include `occurrence_key` per the DATA_MODEL addendum. Everything else
  (claim-based flow, batching, RFC 8058, `news.watrloo.com` subdomain,
  Idempotency-Key) stands.
- `COMPLIANCE.md` — covers the three consent toggles and GPC thoroughly, but
  predates A8's `newsletter_opt_out`; the four-field consent row above is
  canonical.
- `ADVERTISER_CONSOLE.md` — its "k floor default 100" is superseded (config
  value); its "newsletter as third builder type" question is answered
  (surface='newsletter').
- `ARCHITECTURE.md` — its D4 (IP-geo) is resolved per LOCATION.md; D5
  (location retention) is resolved by A3's dual bound (90 days AND latest-5).

## Verified platform facts the design rests on (re-verify before build)

- Resend Free = 3,000/mo AND 100/day → **cannot ship email campaigns**; Resend
  Pro $20/mo (50k/mo, no daily cap) is a launch prerequisite for Phase 4.
  Marketing + transactional share ONE quota. Batch ≤100; 5 req/s.
- Supabase Free = 500MB DB / 5GB egress / 500k Edge invocations; Pro $25/mo.
  `analytics_events` is the fastest-growing table (~10×); rollups + 7–30-day
  raw retention keep Free viable to ~1–2k DAU.
- Fixed-cost curve: $0 (today, featured-only possible) → $20/mo (email launch)
  → $45/mo (~1–2k DAU). Break-even ≈ 6 Solo advertisers.
- Unit economics: allowance rule ≈ 278 sends per $ of subscription ≈ 77% gross
  margin. Solo $10 → 2,500 sends/mo. Never offer unlimited email below ~$50/mo.

## Owner decisions — RESOLVED (2026-07-10)

1. **Channel pivot: promotional blasts are IN-APP messages, not email.**
   The owner: "we aren't emailing notifications, we are messaging them in app."
   Consequences, binding on all docs:
   - `ad_campaigns.type` = `'in_app_blast' | 'featured'`. `campaign_sends.channel`
     = `'in_app'`. A message "send" is a row the recipient reads in an in-app
     message center (RLS: users read their own rows — delivery IS the table).
   - CAN-SPAM (an email statute) does not apply to in-app blasts → **no postal
     address needed for launch**. GDPR/ePrivacy direct-marketing consent still
     applies regardless of channel — the opt-in model is unchanged.
   - **The newsletter is ALSO in-app** (owner, same day): editions are
     delivered through the same in-app message center, `newsletter_opt_out`
     gates the stream. There is **no marketing email at all** — Resend remains
     transactional-only (signup confirmation etc.). `EMAIL_DELIVERY.md` is
     retained as reference for a hypothetical future email channel; the postal
     address requirement is gone entirely; `email_suppressions` exists but is
     dormant.
   - The 3/7-days global cap and 1/7-days per-advertiser sub-cap apply to
     in-app promotional messages exactly as designed for email.
   - `email_suppressions` is kept (future newsletter + global kill), but in-app
     eligibility keys on `user_consents.marketing_opt_in` + the caps.
2. **Tiers approved as priced, with one change: NO API access on any tier.**
   `api_access` is removed from the entitlement matrix entirely (Enterprise can
   revisit later). Allowance economics relax for in-app (no per-send vendor
   cost), but `max_recipients_per_blast` is retained as a blast-radius fuse.
3. **Launch mode: GO — featured-first + in-app messaging**, Phase 0 consent
   backbone first, on current $0 infrastructure.
4. **Stripe: hold.** Manual billing via the existing admin approval flow.
5. **EU double opt-in: defer** until EU users matter.

## Standing rule (unchanged)

Nothing in `docs/growth/` is built or deployed. The LIVE privacy policy remains
true because no tracking, location capture, or marketing exists yet. Phase 0
(consent + policy v2 + suppression) must ship before any of that changes, and
policy v2 replaces the live policy only at that moment.
