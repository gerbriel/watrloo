# Abuse, Fairness & Rate Limiting — A12

**Summary.** This doc defines the guardrails that keep the ad-supported pivot safe:
a **hard global frequency cap of ≤3 promotional messages / 7 days / user** (across
every advertiser *and* the newsletter), enforced server-side at send time; consent
+ suppression + GPC re-checked at the moment of send (never a stale queue); a
**fair, non-gameable** allocation of scarce inventory so no advertiser monopolizes a
region; **cost ceilings + a kill switch** so a bug or bad actor can't fire 100k
emails; and content-abuse / anti-fraud handling that reuses the existing
`reports` + `moderation_actions` machinery.

**Dependencies.** Builds on `docs/ops/RATE_LIMITING.md` (the `rate_limits` /
`check_rate_limit` primitive and the "trigger raising `PT429`" pattern, reused
here for the send-budget guard). References the canonical model owned by **A2**
(`DATA_MODEL.md`) for `campaign_sends`, `ad_campaigns`, `featured_placements`,
`user_consents`, `email_suppressions`, `newsletter_sends`, `plans`/`plan_features`.
Consent/GPC semantics are **A1** (`COMPLIANCE.md`). Send-time worker + scheduling
is **A5** (`CAMPAIGNS.md`); email delivery + bounce/complaint circuit-breaker is
**A6** (`EMAIL_DELIVERY.md`); in-app impression caps are **A7** (`INAPP_ADS.md`);
newsletter is **A8** (`NEWSLETTER.md`); entitlements/tiers are **A9**
(`PRICING.md`); advertiser console UX is **A10**; admin moderation is **A11**
(`ADMIN_CRM.md`); Resend/day ceilings and scaling are **A13** (`SCALING_COST.md`).
Where I need a column that isn't in the canonical model, I write **REQUEST TO A2**
rather than inventing a parallel table.

> Scope note: this is a design. It writes no source and applies no DB changes. All
> SQL is implementation-ready for the orchestrator (A14) to land later.

---

## 0. Principles

1. **The queue is never trusted.** A recipient list assembled at *schedule* time is
   a hint, not a permission. Every guard (consent, suppression, GPC, frequency,
   budget, entitlement) is re-evaluated **inside the send transaction** for that one
   user. A user who opts out, unsubscribes, or crosses the frequency cap between
   scheduling and sending is dropped, silently, with no retry and no queue jumping.
2. **Advertisers can never write the ledger.** `campaign_sends`, `featured_placements`
   activations, and reach counts are written only by `SECURITY DEFINER` RPCs / the
   service-role worker. Advertisers see **aggregate** reach (a server-computed count),
   never a settable number and never individual users — so reach cannot be inflated
   by the advertiser, and the CRM stays admin-only (per the contract's RLS rule).
3. **Caps are hard floors of protection, not billing meters.** Fixed-window counting
   (per `RATE_LIMITING.md §2`) is good enough; we deliberately count *in-flight*
   sends so concurrency can't overshoot (§1.3).
4. **Every enforcement action is auditable.** Pauses, rejections, suspensions, and
   admin overrides write to `moderation_actions` in the same transaction as the act.

---

## 1. User-protection caps (the important one)

### 1.1 The global frequency cap: ≤3 promotional messages / 7 days / user

**Rule.** Across **all advertisers and the newsletter combined**, a user receives at
most **3 promotional messages in any trailing 7-day window** (the contract's pinned
default; configurable — see §1.5). A "promotional message" is any *messaging-channel*
send that reaches the user's inbox: an `email_blast` `campaign_sends` row, or a
`newsletter_sends` row. It explicitly does **not** include transactional/auth mail
(password reset, receipts, review replies) and does **not** include in-app featured
**impressions** — those are a different budget governed in §1.4 / A7.

This is enforced in **one place**: the **send-time eligibility query** that A2's data
model exposes and A5's worker calls. It is a windowed `count(*)` over the send
ledgers. Two layers:

- a **pre-filter** (`campaign_eligible_recipients`) that batches the audience, and
- an **atomic claim** (`claim_send_slot`) that is the *authoritative* gate and closes
  the concurrency race between two campaigns running at once (§1.3).

### 1.2 The windowed count (the SQL you asked for)

A single helper unifies the two ledgers so "3 across everything" is literally one
number. It counts `queued` sends too, so an in-flight blast already reserves the
slot and can't be double-spent (§1.3).

```sql
-- Counts promotional messages that reach a user's inbox in the trailing window.
-- Unifies advertiser blasts (campaign_sends, channel='email') and the newsletter
-- (newsletter_sends). Transactional mail is never logged to either ledger, so it
-- is automatically excluded. 'queued' counts so concurrent sends can't overshoot.
create or replace function public.promo_messages_in_window(
  p_user_id uuid,
  p_window  interval
) returns int
language sql
stable
security definer
set search_path = ''
as $$
  select
      (select count(*)
         from public.campaign_sends s
        where s.user_id = p_user_id
          and s.channel = 'email'                       -- email blasts only
          and s.status in ('queued','sent','delivered') -- not 'failed'/'suppressed'
          and s.sent_at > now() - p_window)
    + (select count(*)
         from public.newsletter_sends n
        where n.user_id = p_user_id
          and n.status in ('queued','sent','delivered')
          and n.sent_at > now() - p_window);
$$;
revoke all on function public.promo_messages_in_window(uuid, interval) from public;
```

> **REQUEST TO A2:** ensure both ledgers carry a `status text` including at least
> `('queued','sent','delivered','failed','suppressed','bounced','complained')` and a
> `sent_at timestamptz` set to `now()` when the row is first inserted as `queued`.
> Add covering indexes: `campaign_sends (user_id, sent_at) where channel='email'`
> and `newsletter_sends (user_id, sent_at)` so the window count is an index range
> scan, not a seq scan, at audience scale.

**The eligibility query** (A2 owns the authoritative version; this is the guard
structure — geo/segment matching is A3's, shown here abbreviated):

```sql
create or replace function public.campaign_eligible_recipients(p_campaign_id uuid)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (select * from public.ad_campaigns where id = p_campaign_id)
  select p.id, p.email
  from c
  join public.user_consents uc on uc.user_id = /* target */ uc.user_id
  join public.profiles       p on p.id = uc.user_id
  -- (A3) coarse region / segment targeting at city granularity — abbreviated:
  join public.user_locations ul on ul.user_id = p.id and ul.ip_region = c.target_region
  where uc.marketing_opt_in                                  -- (1) live consent
    and not uc.gpc_detected                                  -- (2) GPC/sharing opt-out (see A1)
    and not exists (select 1 from public.email_suppressions es  -- (3) unsub/bounce/kill
                     where es.user_id = p.id)
    and public.promo_messages_in_window(p.id, interval '7 days') < 3   -- (4) GLOBAL CAP
    and public.advertiser_slots_used(p.id, c.business_id, interval '7 days')
          < least(coalesce(c.frequency_per_week, 1), 1)       -- (5) per-advertiser fairness (§3.4)
    and not exists (select 1 from public.campaign_sends s     -- (6) idempotency
                     where s.campaign_id = c.id and s.user_id = p.id);
$$;
```

Guards (1)–(3) are §2; (4) is the global cap; (5) is the anti-monopoly per-advertiser
sub-cap (§3.4); (6) stops a re-run from double-sending the same campaign.

### 1.3 What happens when a user is capped — and the concurrency race

**When capped, the user is simply not selected.** No error to anyone, no queue,
no "send it next window and jump ahead." The `< 3` predicate makes them invisible to
the eligibility query; the campaign just reaches fewer people. The advertiser's
aggregate reach reflects only who was actually reachable. There is **no queue-jump
mechanism** by design — a capped user is protected, full stop.

The pre-filter alone has a race: two campaigns evaluating a user at `count = 2`
simultaneously could both send, pushing them to 4. So the pre-filter is *not* the
gate. The gate is an **atomic claim** the worker calls per recipient, which re-checks
the count and inserts the `queued` row **under a per-user lock** in one transaction:

```sql
-- Authoritative send gate. Returns true iff a slot was claimed (row inserted).
-- Serializes per user via advisory lock so concurrent campaigns can't overshoot
-- the global cap. Called by the send worker (service role) for each recipient
-- immediately before handing the message to Resend.
create or replace function public.claim_send_slot(
  p_campaign_id uuid,
  p_user_id     uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  -- one waiter per user; releases at commit/rollback
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select business_id into v_business_id
    from public.ad_campaigns where id = p_campaign_id;

  -- Re-check EVERYTHING at the true moment of send (never trust the queue):
  if exists (select 1 from public.email_suppressions where user_id = p_user_id)
     or not exists (select 1 from public.user_consents
                     where user_id = p_user_id
                       and marketing_opt_in and not gpc_detected)
     or public.promo_messages_in_window(p_user_id, interval '7 days') >= 3
     or public.advertiser_slots_used(p_user_id, v_business_id, interval '7 days') >= 1
     or exists (select 1 from public.campaign_sends
                 where campaign_id = p_campaign_id and user_id = p_user_id)
  then
    return false;                          -- dropped: not selected, no retry
  end if;

  insert into public.campaign_sends (campaign_id, user_id, channel, status, sent_at)
  values (p_campaign_id, p_user_id, 'email', 'queued', now());
  return true;                             -- slot claimed; safe to hand to Resend
end;
$$;
revoke all on function public.claim_send_slot(uuid, uuid) from public;
```

Flow: worker claims the slot → on `true`, sends via Resend → on delivery/bounce
webhook (A6) flips `status` to `delivered`/`bounced`; a `bounced`/`complained`
result also inserts an `email_suppressions` row so the address is dead going
forward. On `false`, the message is dropped for this user and the worker moves on.

### 1.4 Per-user in-app impression caps (A7)

Featured in-app placements are a **separate budget** and do **not** count against the
3/7-day messaging cap (different channel; the user isn't being pushed to). A7 owns
the depth; the interface A12 requires:

- **Per-user, per-placement frequency:** a user sees a given `featured_placement` at
  most *N* times/day (default ~3) — enough to register, not enough to nag.
- **Per-session sponsored density:** at most *M* sponsored items per browse/map
  session (default ~1 in every ~7 organic results) so the app never reads as an ad
  wall.
- **Enforced twice:** the client caps at render for snappy UX, but the
  placement-selection RPC (A7, server-side) is authoritative and also filters on the
  impression ledger, because a client cap is not a security control.
- Impressions/clicks log to `analytics_events` (`event='featured_impression'` /
  `'featured_click'`), which also feeds the anti-fraud checks in §5.

### 1.5 Configurability

The `3` and `7 days` are the pinned defaults but must be settable without a code
change. **REQUEST TO A2:** a single-row `growth_config` table (admin-RLS) holding
`promo_cap_count int default 3`, `promo_cap_window interval default '7 days'`,
`per_advertiser_cap int default 1`, `promotions_enabled bool default true` (the kill
switch, §4.4), and the daily send ceiling (§4.2). The functions above read these
instead of literals in the real implementation; literals are shown for clarity.

---

## 2. Consent / suppression enforcement at send

Consent is **not** a one-time signup fact; it is re-verified at the instant of send.
Three checks, all shown in `campaign_eligible_recipients` **and** re-run in
`claim_send_slot` (belt and suspenders — the claim is the one that legally counts):

1. **`user_consents.marketing_opt_in` must be true right now.** Absence of a row =
   no consent (contract). A user who toggles marketing off mid-campaign has their
   row updated; the next `claim_send_slot` sees `false` and drops them **immediately**
   — even if they were already on the assembled queue.
2. **`email_suppressions` must not contain the address.** This is the global
   kill-switch per user: one-click unsubscribe, hard bounce, or spam complaint all
   insert here (A6 owns the webhook that does it), and a row here excludes the user
   from *everything* promotional, forever, regardless of `marketing_opt_in`.
3. **GPC / "sharing" opt-out (`user_consents.gpc_detected`).** California users who
   send a Global Privacy Control signal are treated as having opted out of "sharing"
   for cross-context targeted advertising. The send guard excludes `gpc_detected`
   users from **advertiser-targeted** blasts. (Whether a GPC user may still receive
   the purely first-party newsletter they opted into is **A1's** call in
   `COMPLIANCE.md`; the send path defers to A1's predicate — err toward exclusion.)

Because the queue is re-checked at send time, **an opt-out mid-campaign is honored on
the next message, not the next campaign.** This is the CAN-SPAM / GDPR / CPRA posture
the contract requires ("checked at send time, not just at signup"), promptly honored.

CAN-SPAM footer requirements (identifiable sender, physical address, working
one-click unsubscribe) are the creative/template concern of **A6/A1**; A12's job is
to guarantee the unsubscribe, once clicked, lands in `email_suppressions` and is
enforced here.

---

## 3. Advertiser fairness — allocating scarce inventory

Two scarce resources when many approved campaigns target the same **region + ISO
week**: (a) **featured placement slots** on a surface, and (b) the **shared user
frequency budget** (each user only accepts 3 promo messages/7d). We need an
allocation that is **explicit, deterministic, and non-gameable**, and that
**prevents any one advertiser from monopolizing a region**.

### 3.1 Rejected approaches (and why)

- **Pure first-come-first-served at send time.** Gameable: an advertiser schedules a
  blast at 00:00 to grab every user's slots before competitors wake up. Starves
  small advertisers. Rejected as the *sole* rule.
- **Highest-tier-takes-all.** A single enterprise advertiser buys out a region and
  small `$10` shops never appear. Violates "keep small owners first-class." Rejected.
- **Pay-per-slot auction.** Requires Stripe + real-time bidding; out of scope
  (money is manual today) and hostile to small owners. Rejected.

### 3.2 The policy: reserved slots, tier-weighted order, anti-monopoly cap, waitlist carryover

Featured inventory is modeled as a fixed, small set of **reservations** per
`(surface, region, iso_week)`, claimed at **scheduling/approval time** (not at
send time — so contention is resolved deterministically up front, not in a
midnight scramble). A reservation is granted only if **all** hold:

1. **Entitlement gate first (A9).** The business's plan allows another featured
   placement this week (`plan_features.featured_per_week` not yet exhausted). No
   entitlement → no reservation, before anything else is considered.
2. **Anti-monopoly regional cap (the key rule).** One business may hold at most
   `ceil(slots_available / 2)` slots in a given region-week, and **never 100% when
   ≥2 slots exist**. With, say, 3 slots, no advertiser gets more than 2; with 2
   slots, no advertiser gets both. This is a hard ceiling **independent of tier or
   money** — you cannot buy your way past it. This is what "prevents one advertiser
   monopolizing a region."
3. **Availability.** Slots remaining > 0 after the above.

**Ordering when oversubscribed** (more qualified requests than slots): sort by

```
(tier_weight DESC, waitlist_credit DESC, booked_at ASC)
```

- `tier_weight` — higher tiers paid for larger allowances and get first pick, but the
  §3.2(2) cap bounds how much they can take, so they can't sweep the region.
- `waitlist_credit` — an advertiser bumped in a prior week for this region carries a
  **+1 credit** (auto-granted, §3.3), so a small advertiser who keeps losing to
  whales eventually wins. This is the fairness-over-time lever.
- `booked_at` — server-stamped booking time breaks remaining ties deterministically.
  It's a *tiebreaker*, not the primary key, so it can't be gamed by racing the clock.

Every input is objective and server-controlled: tier is what you pay for, credit is
automatic, booking time is server-stamped. There is no field an advertiser can set to
jump the queue. **Admin override exists** (a human can force a placement) but is
**audited to `moderation_actions`** (§4.4 / §6) so it's visible and accountable.

### 3.3 Waitlist credit (round-robin fairness over time)

When a qualified reservation request loses (slots full), the worker records a
`waitlist_credit` for that `(business_id, region)`. Next week the credit raises its
sort position above equal-tier competitors who *did* run last week. Credits are
consumed on a win and decay after ~4 weeks so they don't accumulate forever. Net
effect: **round-robin across advertisers within a tier**, weighted so paying more
still helps, but no advertiser is perpetually starved and none is perpetually
dominant.

> **REQUEST TO A2:** `featured_placements` needs `region`, `iso_week` (or derive from
> `starts_at`), `booked_at timestamptz default now()`, and a `status`
> (`reserved`/`live`/`done`/`bumped`). Add a small `featured_waitlist_credits`
> table `(business_id, region, credit int, updated_at)`, admin-RLS. `plans`/
> `plan_features` (A9) supplies `tier_weight` and `featured_per_week`.

### 3.4 Fairness inside the shared frequency budget

The 3/7d cap is itself a contended resource: if five advertisers target the same
user's region, at most 3 messages get through. Who wins? To stop one advertiser from
consuming all three of a user's weekly slots, we add a **per-advertiser per-user
sub-cap of 1 message / 7 days** (guard (5) in §1.2 / the `>= 1` check in
`claim_send_slot`). Consequences:

- A user hears from **up to 3 *different* advertisers** per week, never 3× the same
  one — better UX *and* fairer competition in one rule.
- `ad_campaigns.frequency_per_week` is respected but hard-clamped to the sub-cap
  (`least(frequency_per_week, 1)`), so an advertiser can't self-authorize more of a
  user's budget by setting a big number.
- Because sends are claimed atomically per user (§1.3) and the pre-filter processes
  campaigns fairly (order by `tier_weight`, then `booked_at`, same as §3.2), the
  three slots are distributed by the same non-gameable ordering, not by whoever's
  cron fires first.

```sql
-- Messages this business has sent this user in the window (fairness sub-cap).
create or replace function public.advertiser_slots_used(
  p_user_id uuid, p_business_id uuid, p_window interval
) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)
  from public.campaign_sends s
  join public.ad_campaigns c on c.id = s.campaign_id
  where s.user_id = p_user_id
    and c.business_id = p_business_id
    and s.channel = 'email'
    and s.status in ('queued','sent','delivered')
    and s.sent_at > now() - p_window;
$$;
```

---

## 4. Platform / cost protection — no bug or bad actor fires 100k emails

Defence in depth, each layer independently sufficient to stop a runaway.

### 4.1 Entitlement check is the FIRST gate (A9)

Before a campaign can leave `draft` → `pending_review` → `approved` → `running`, the
transition RPC checks the business's plan entitlements from `plan_features` (A9):
`blasts_per_month`, `featured_per_week`, and a plan-level `max_recipients_per_blast`.
A business with no active `subscriptions` row (`status in ('active','trialing')`) or
an exhausted allowance **cannot start a send at all**. This gate runs before any
audience is assembled, so an un-entitled campaign never touches the send path.

### 4.2 Per-campaign max recipients + per-day platform send ceiling

- **Per-campaign hard cap.** Recipients for one campaign are capped at
  `min(plan.max_recipients_per_blast, ABSOLUTE_CAMPAIGN_MAX)`. `ABSOLUTE_CAMPAIGN_MAX`
  is a platform constant (e.g. **50,000**) that applies **even to admins/enterprise**,
  so a mis-targeted "everyone" segment or a compromised account can't blast the whole
  user base in one shot. The eligibility query is `LIMIT`ed to this number and the
  worker refuses a campaign whose claimed count would exceed it.
- **Per-day platform ceiling (tie to Resend).** Resend's free tier is **100
  emails/day (3,000/month)** (per `docs/ops/EMAIL.md §(b)` and A13). *All* mail —
  auth/transactional + newsletter + blasts — shares that quota. So we reserve
  headroom: a promotional daily budget of **~60/day** on the free tier, leaving ~40
  for signups/password-resets, and we **raise this only when a paid Resend tier is
  active** (A13 owns the number). The budget is a global atomic counter (below); when
  exhausted, further sends defer to the next day — they do not fail the user, they
  just wait, and the cap physically prevents a 100k blast because the 60,001st send
  of the day is refused.

This is a hard, testable ceiling: even if every other guard were bypassed by a bug,
the daily budget counter caps total volume at the Resend quota we can actually pay
for.

### 4.3 The send-ceiling guard (the second SQL you asked for)

Reuses the atomic fixed-window counter pattern from `RATE_LIMITING.md §2` — an
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` bumps and reads under one row lock,
so concurrent workers can't race past the ceiling.

```sql
-- Global per-day send budget, keyed by (day, channel). One row per day.
-- REQUEST TO A2: create this table (admin-RLS, no client policies).
create table if not exists public.platform_send_counters (
  day     date not null,
  channel text not null,               -- 'promotional' (blasts+newsletter share it)
  count   int  not null default 0,
  ceiling int  not null,               -- seeded from growth_config / A13
  primary key (day, channel)
);
alter table public.platform_send_counters enable row level security;

-- Atomically claim p_n sends against today's promotional budget.
-- Returns the number ACTUALLY granted (may be < p_n at the boundary; 0 if exhausted).
-- The worker sends only as many messages as it was granted.
create or replace function public.claim_platform_send_budget(
  p_n       int,
  p_channel text default 'promotional'
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ceiling int;
  v_before  int;
  v_granted int;
begin
  -- ceiling comes from config; default keeps ~40/day headroom under Resend's 100/day
  select coalesce((select promo_daily_ceiling from public.growth_config), 60)
    into v_ceiling;

  insert into public.platform_send_counters (day, channel, count, ceiling)
  values (current_date, p_channel, 0, v_ceiling)
  on conflict (day, channel) do nothing;

  -- Lock today's row, compute headroom, grant up to that.
  select count into v_before
    from public.platform_send_counters
   where day = current_date and channel = p_channel
   for update;

  v_granted := greatest(0, least(p_n, v_ceiling - v_before));

  if v_granted > 0 then
    update public.platform_send_counters
       set count = count + v_granted
     where day = current_date and channel = p_channel;
  end if;

  return v_granted;   -- 0 => budget exhausted; worker parks the rest for tomorrow
end;
$$;
revoke all on function public.claim_platform_send_budget(int, text) from public;
```

The worker claims budget in batches, then claims per-user send slots (§1.3) within
that grant; the two counters together bound both *who* gets messaged and *how many*
messages exist platform-wide per day.

### 4.4 Kill switch + automatic circuit breaker

- **Manual kill switch.** `growth_config.promotions_enabled bool`. An admin-only RPC
  flips it; every send path checks it first and, when `false`, all promotional
  sending halts instantly (transactional/auth mail is unaffected — different path).
  The flip is written to `moderation_actions`. This is the "stop everything" lever
  for an incident.
- **Per-campaign pause.** `ad_campaigns.status = 'paused'` stops one campaign without
  touching others; admin or the auto-breaker sets it.
- **Automatic circuit breaker (A6 owns the signal).** If a campaign's bounce or
  spam-complaint rate crosses a threshold (industry rule of thumb: complaints
  **≥0.1%**, hard bounces **≥2–5%**), it is auto-`paused` and flagged for admin
  review, and the platform breaker can trip if aggregate complaint rate spikes.
  Protecting domain reputation is also cost protection: a burned sending domain ends
  the whole channel. A6 measures; A12 defines that crossing the threshold ⇒ pause +
  `moderation_actions` row.

---

## 5. Advertiser content abuse

### 5.1 Pre-publication: admin approval is mandatory (A11)

No creative reaches a user without passing through `ad_campaigns.status =
'pending_review'` → admin approval → `'approved'`. A11 owns the review console; the
guarantee A12 relies on is that the **send path refuses any campaign not in
`approved`/`running`**, so approval cannot be skipped. Creative (subject/body/image/
link) is reviewed for policy compliance, destination-URL safety, and truthfulness
before approval.

### 5.2 Post-publication: user report path (reuse `reports`)

Users can report a running ad or featured listing, reusing the existing `reports`
table + flow. Today `reports` targets `review_id` or `bathroom_id` only (with a
"exactly one target" check). To let it also target ads:

> **REQUEST TO A2:** extend `public.reports` with nullable FK targets
> `campaign_id uuid references ad_campaigns(id) on delete cascade` and
> `featured_placement_id uuid references featured_placements(id) on delete cascade`,
> and widen the existing `check (...= 1)` so exactly **one** of
> `{review_id, bathroom_id, campaign_id, featured_placement_id}` is non-null. Add an
> optional `reason_category text` (`'misleading'|'offensive'|'spam'|'scam'|'other'`).
> Keep the current `authenticated` insert grant so any signed-in user can report.

An open ad report surfaces in the admin queue (A11) alongside review/bathroom
reports — one moderation surface, not a new one.

### 5.3 Repeat-offender handling (business-level strikes)

Abuse is tracked at the **business** level (an advertiser can't dodge by making a new
campaign). A business accrues a **strike** each time an ad report against it is
**upheld** by a moderator. Escalation ladder (defaults, admin-tunable):

- **1 upheld report:** warning; the specific creative is rejected.
- **2:** all of the business's `running` campaigns auto-`paused` pending re-review.
- **3+ within 90 days:** business suspended from advertising — new campaigns blocked
  at the entitlement gate (§4.1) until an admin lifts it.

Each step writes to `moderation_actions`.

> **REQUEST TO A2:** extend `moderation_actions` — its `action` check currently
> allows only review/bathroom/report/role verbs, and `target_type` only
> `('review','bathroom','report','profile')`. Add actions
> `'approve_campaign','reject_campaign','pause_campaign','resume_campaign',
> 'uphold_ad_report','dismiss_ad_report','suspend_business','reinstate_business',
> 'override_placement','toggle_promotions'` and target types
> `'campaign','featured_placement','business'`. The strike count is derived by
> counting `uphold_ad_report` rows per business; no new counter table needed. Use the
> existing `detail jsonb` for reason/threshold context.

### 5.4 Consistency with existing moderation

This deliberately mirrors the review/bathroom moderation already built
(`20260710020000_roles_reports_moderation.sql`): `SECURITY DEFINER` RPCs that
re-check `is_moderator()`/`is_admin()`, perform the act, and write the audit row in
the **same transaction** so the log can't be skipped. We are extending that system,
not building a parallel one (contract rule).

---

## 6. Anti-fraud

The threat is an advertiser (or a bot they hire) manufacturing engagement to look
more valuable — which matters more once billing (Stripe) becomes CPC/CPM. Detections
are first-party, in Postgres over `analytics_events` + the send ledgers.

### 6.1 Fake reach inflation

- **Reach is server-computed, never advertiser-settable.** Advertiser-visible reach =
  `count(distinct user_id) from campaign_sends where campaign_id = ? and status in
  ('sent','delivered')` — computed by an RPC, exposed as an aggregate only.
  Advertisers have **no** write access to `campaign_sends` (RLS: no client policy),
  so they cannot inflate it. Reach counts **delivered**, not `queued`/`failed`, so a
  bounced blast doesn't pad the number.
- **Reach is opt-in users only.** Padding reach with fake accounts is throttled
  upstream: every account needs a confirmed email + explicit `marketing_opt_in`, and
  account minting is rate-limited (`RATE_LIMITING.md §3/§6`). Sybil is dampened, not
  free.

### 6.2 Click fraud on featured placements / self-clicking

Featured impressions/clicks land in `analytics_events`. Raw counts are cleaned before
they're shown to the advertiser (and, later, before they can bill):

1. **Exclude the advertiser's own people.** Drop clicks whose `user_id` is a
   `business_members` row of the same business (self-clicking to inflate CTR).
2. **De-dupe.** Count at most **1 click per (session_id, placement, day)** and **1
   impression per (session_id, placement, render)** — a user hammering refresh or
   double-tapping counts once.
3. **Rate-cap per session/region.** Sessions emitting an implausible number of clicks
   (e.g. >20 featured clicks/hour) are flagged and their clicks excluded — the same
   fixed-window primitive from `RATE_LIMITING.md §2`, keyed by `session_id`.
4. **Bot filter.** Ignore events with no consented session, known-crawler UAs, or
   impossible timing (click < ~1s after impression across many placements).
5. **Anomaly flag for humans.** A campaign whose CTR is a wild multiple of the
   surface's rolling baseline (e.g. >5×) is auto-flagged to the admin queue (A11) —
   detection, not silent auto-billing. Cleaned counts, not raw, feed any future
   CPC/CPM math (A9/Stripe phase).

### 6.3 Notes

- **Self-review / self-boost** of the underlying listing is already covered by
  existing review moderation and the claim model (a business controls listing facts
  but cannot edit/delete reviews). Nothing new here.
- **IP-level fraud** is limited by the same constraint noted in `RATE_LIMITING.md §4`:
  the client IP isn't reliably available to SQL. We key fraud heuristics on
  `session_id` + coarse `region` (from `analytics_events`) rather than IP, which is
  good enough for anomaly detection given the data is first-party and the stakes
  (vanity CTR today, CPC later) are moderate.

---

## 7. What ships first (prioritized)

1. **The global frequency cap** — `promo_messages_in_window` + `claim_send_slot`
   (§1.2–1.3). Nothing else in the pivot is safe to launch without this; it is the
   single most important user-protection control and gates every send.
2. **Send-time consent/suppression/GPC re-check** (§2) — folded into the same claim,
   so it's the same shipment. Legally required.
3. **Entitlement gate + per-campaign cap + daily send ceiling + kill switch** (§4).
   Cost/blast-radius protection; cheap, high-leverage.
4. **Advertiser fairness** — the per-advertiser per-user sub-cap (§3.4) first (it's
   one predicate already in the query), then featured-slot reservations + anti-monopoly
   cap + waitlist (§3.2–3.3) when featured inventory actually goes on sale.
5. **Content-abuse reporting + strikes** (§5) — extends existing moderation; lands
   with A11's console.
6. **Anti-fraud cleaning** (§6) — needed before any usage-based billing; a nice-to-have
   for vanity metrics, a must-have the moment money is per-click.

## 8. Open items for A2 (consolidated REQUESTs)

- `status` + `sent_at` + covering indexes on `campaign_sends` & `newsletter_sends` (§1.2).
- `growth_config` single-row admin table for the tunable caps/ceiling/kill-switch (§1.5, §4).
- `platform_send_counters` table (§4.3).
- `featured_placements`: `region`, `iso_week`/derivable, `booked_at`, richer `status`;
  `featured_waitlist_credits` table (§3.3).
- Extend `reports` with `campaign_id` / `featured_placement_id` targets + widened
  one-target check + `reason_category` (§5.2).
- Extend `moderation_actions` `action` and `target_type` check constraints for ad/
  business verbs (§5.3).

## Sources

- Resend free tier **100/day, 3,000/mo** — `docs/ops/EMAIL.md §(b)`; https://resend.com/pricing
- Fixed-window atomic-counter pattern, `PT429`, `pg_advisory_xact_lock` rationale —
  `docs/ops/RATE_LIMITING.md §2`
- Existing `reports` / `moderation_actions` schema being extended —
  `supabase/migrations/20260710020000_roles_reports_moderation.sql`
- `businesses` / `subscriptions` / `bathroom_claims` model —
  `supabase/migrations/20260711000000_business_accounts.sql`
- Canonical growth data model & consent semantics — `docs/growth/DATA_MODEL.md` (A2),
  `docs/growth/COMPLIANCE.md` (A1)
- CAN-SPAM one-click unsubscribe / prompt-honoring, GDPR/ePrivacy opt-in, CPRA GPC —
  per contract; depth owned by A1
```
