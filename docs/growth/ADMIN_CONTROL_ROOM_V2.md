# Admin Control Room v2 — build plan (5 Opus agents)

**Status: plan, 2026-07-11.** Upgrade the `/admin` portal from a set of
moderation queues into an operations control room for the ad platform,
using what the OSS research ([oss-research/](./oss-research/)) and the idea
survey ([AD_PLATFORM_IDEAS.md](./AD_PLATFORM_IDEAS.md)) surfaced — and the
data that the ad-serving foundation (migration `20260713000000`) now
actually produces (`ad_events` with `is_valid`/`flag_reason`,
`ad_daily_stats`, `ad_offers`, delivery knobs on `featured_placements`,
five `ads_*` cron jobs).

## Why now / what's missing

Today's `/admin` has queues (reports, reviews, bathrooms, campaigns,
requests, claims, roles) but no *instruments*:

- The promotions kill switch, slot capacities, and frequency cap live in
  `growth_settings` — **editable only via the SQL editor**.
- Placement `weight` / `daily_impression_cap` (Revive knobs) have **no UI**.
- `ad_events` invalid-traffic flags (`bot_ua`, `self_click`,
  `click_velocity`, `daily_volume`) are recorded but **invisible**.
- `moderation_actions` audits every privileged act — **no viewer exists**.
- No admin-side ads revenue/performance view at all.
- Cron health, rollup freshness, partition state: unobservable.

## Structure: one spine, five Opus agents

I (the coordinator) build the spine first so all five agents work against a
fixed contract, exactly like the previous fan-outs: migration + RPCs applied
to live, API modules, `AdminLayout` nav restructure (grouped: **Moderation |
Business | Ads | System**), routes, and compiling stubs. Agents then own
disjoint files; I integrate, verify, deploy.

### Spine (coordinator, before agents launch)

Migration `20260713010000_admin_control_room.sql`:
- `admin_set_growth_setting(key, value)` — is_admin-gated, whitelisted keys,
  audited to `moderation_actions` (new action `set_growth_setting`).
- `admin_update_placement_delivery(placement_id, weight, daily_cap)` —
  audited (`update_placement`).
- `admin_ops_snapshot()` — one RPC returning: cron jobs + last run status
  (from `cron.job`/`cron.job_run_details`), `ad_daily_stats` max
  `updated_at` (rollup freshness), today's event counts, `ad_events`
  partition list, offers backlog. SECURITY DEFINER, admin-only.
- `admin_ad_overview(p_since date)` — platform-wide per-campaign aggregates
  (admin can already read `ad_daily_stats` via RLS; this joins campaign +
  business labels in one round trip).
- Widen `reports` with an `ad_campaign_id` target + CHECK rearrangement
  ("report this ad", idea 09 #2) and the audit-action vocabulary.
- API: `src/lib/api/adminOps.ts` (typed wrappers for all of the above).
- Nav: `AdminLayout` grouped tabs + routes + stubs for every new page.

### Agent 1 — Ads Command Center (`AdminAdsOverview.tsx`)
The revenue dashboard (ideas 03 #2/#10, 08 #2/#8; CodeFund rollup design).
Platform-wide campaign table from `admin_ad_overview`: impressions, clicks,
CTR **with credible intervals** (reuse `src/lib/ads/stats.ts`), unique
sessions, invalid-event share, per-surface split, 14v14 deltas, CSV export.
Anomaly chips ("CTR down 40%", "invalid share > 10%"). Sort by spend-proxy
(impressions) — the "who's actually getting value" view that manual billing
conversations need (idea 15 #1's data source).

### Agent 2 — Delivery Controls (`AdminDelivery.tsx`)
The Revive knobs, live (research 5-revive §2 "the 20% worth keeping").
`growth_settings` editor: promotions kill switch (big, red, audited),
per-surface `featured_capacity`, `ad_frequency_cap_per_day`,
`k_anonymity_floor` (one number everywhere — idea 10 #3). Placement table:
weight slider + daily-impression-cap editor per active placement, with
delivered-today vs cap pacing bars. Every write via the audited spine RPCs.

### Agent 3 — Trust & Safety Console (`AdminTrust.tsx`)
The IVT console (research 6-ivt layers 2–3; ideas 09 #1/#3/#9).
Flag-reason breakdown by day and campaign (from `ad_events` where
`not is_valid`), top offending session-hashes (aggregate only — no user
data), suspended-business list with suspend/unsuspend (`admin_suspend_business`
exists), and the incoming "report this ad" queue rows (new target type).
A "business strike" summary: campaigns rejected + ads reported + IVT rate,
per business — the strike-ladder precursor.

### Agent 4 — Campaign Review Suite (upgrade `AdminCampaigns.tsx`)
Owns the existing 310-line file (ideas 06 #9/#11/#14, 01 #5/#6).
Structured rejection reasons (taxonomy dropdown + free text, stored in
`reject_reason` as `code: note`), policy checklist surfaced beside the
creative, cross-surface creative preview (render the actual `FeaturedCard`
at browse/detail sizes), bulk approve/reject with per-row status, repeat-
rejection flag (this business's prior rejections shown inline), and an
audit timeline per campaign from `moderation_actions`.

### Agent 5 — Audit Log & Ops Health (`AdminAudit.tsx` + `AdminOps.tsx`)
Two thin pages, one agent (ideas 06 #6; USERS_AND_ROLES §5.3's promise).
Audit: filterable `moderation_actions` viewer (actor, action, target type,
date; detail jsonb pretty-printed) — makes the "everything is audited"
guarantee inspectable. Ops: `admin_ops_snapshot` rendered as health tiles —
each `ads_*` cron with last-run status and a red state when overdue,
rollup freshness ("stats current as of…"), today's event volume, partition
list, offers backlog. The "is the machine on?" page.

## Sequencing

1. Spine: migration → apply to live → smoke-test RPCs → API module → nav +
   routes + stubs → `tsc` green. (Coordinator; nothing parallel yet.)
2. Launch agents 1–5 in parallel (Opus, file-isolated, fixed contracts).
   Shared-file rule: only agent 4 touches an existing page
   (`AdminCampaigns.tsx`); all other shared-file edits happen in the spine.
3. Integrate: reconcile, `tsc` + oxlint + build, live smoke of each new RPC
   as admin + as anon (must 403/hide), commit, deploy, verify bundle.

## Risks / notes

- **Concurrent sessions**: another Claude session has been editing this
  repo (a stray `git stash` half-reverted the tree once already). Commit
  the spine before launching agents; re-verify integration points after.
- **Session limits**: agents died mid-write once at 15-wide; five Opus
  agents is deliberately narrower. Resume via SendMessage if cut off.
- `cron.job_run_details` access from an RPC needs care (owned by postgres);
  the snapshot RPC is SECURITY DEFINER so it works, but keep it admin-only.
- Everything admin-facing keeps the house rule: the UI hides buttons, the
  database enforces — every new write path is an audited `is_admin` RPC.
