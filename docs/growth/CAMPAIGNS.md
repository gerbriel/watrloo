# Watrloo Growth — Campaigns & Scheduling (A5)

**Summary.** Advertisers compose `email_blast` and `featured` campaigns that move
through a reviewed state machine (draft → pending_review → approved → running →
paused/done/rejected). A pg_cron scheduler wakes on a fixed cadence, activates due
campaigns, and idempotently enqueues batches of eligible `user_id`s + a frozen
creative snapshot for the email (A6) and in-app (A7) senders to execute. Two caps
coexist: a per-campaign cadence the advertiser sets, and a hard per-user global cap
(default 3 promo messages / 7 days across ALL advertisers) enforced at send by A2's
eligibility query.

**Dependencies.** `DATA_MODEL.md` (A2 — `ad_campaigns`, `campaign_sends`,
`featured_placements`, `plan_features`, and the eligibility query), `LOCATION.md`
(A3 — segments, coarse region/city centroids), `EMAIL_DELIVERY.md` (A6 — Resend send
+ suppression + unsubscribe footer), `INAPP_ADS.md` (A7 — rendering featured slots and
in-app promo inbox), `PRICING.md` (A9 — entitlements per plan), `ADMIN_CRM.md` (A11 —
the review queue + moderation audit), `COMPLIANCE.md` (A1 — consent/CAN-SPAM/GPC at
send time), `ABUSE_AND_LIMITS.md` (A12 — fairness/anti-oversell). This doc owns the
*lifecycle*, the *scheduler*, and the *scheduler→sender interface*; it defers channel
delivery to A6/A7, entitlement pricing to A9, and consent semantics to A1.

---

## 0. Platform facts this design rests on (verified, not from memory)

| Fact | Value | Why it matters here | Source |
| --- | --- | --- | --- |
| `pg_cron` availability | All Supabase tiers; resource-bound, not plan-gated | The scheduler is Postgres-native, no external worker | [Supabase pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron), [discussion #37405](https://github.com/orgs/supabase/discussions/37405) |
| `pg_cron` granularity | Standard cron (≥1 min) **plus** sub-minute seconds syntax, e.g. `cron.schedule('job','30 seconds', $$…$$)` | We run the dispatcher every 1–5 min; seconds granularity is available if needed | [Supabase pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron) |
| `auth.uid()` under cron | Returns **NULL** for cron / service-role / SQL-editor writes | Scheduler RPCs must NOT depend on `auth.uid()`; audit rows they write use `actor_id = NULL` + `detail.via = 'scheduler'` | [Supabase RLS helpers](https://supabase.com/docs/guides/database/postgres/row-level-security) |
| `pg_net` | Available (installed per contract) | Lets a cron SQL job invoke the A6 Edge Function asynchronously over HTTP | contract §"Existing system" |
| Resend batch API | **≤100 emails per call**, account rate limit **2 req/s** | Sizes the dispatcher batch (100) and inter-batch pacing; A6 owns the actual call | [Resend — Send Batch Emails](https://resend.com/docs/api-reference/emails/send-batch-emails) |
| Postgres tz database | IANA tz built in (`pg_timezone_names`, `now() at time zone tz`) | Local-daytime send windowing needs no third party | Postgres core |

Nothing here needs a third-party ad network, scheduler, or analytics SaaS.

---

## 1. Campaign types & lifecycle

### 1.1 Types (`ad_campaigns.type`)

- **`email_blast`** — a geo/segment-targeted promotional email. Consumes the
  advertiser's monthly blast allowance. Executed by A6 (Resend). A run produces one
  `campaign_sends` row per recipient.
- **`featured`** — a time-boxed placement on an in-app surface (`map` | `browse` |
  `detail`). Consumes the weekly featured allowance **and** a scarce inventory slot
  (§3.3). Executed by A7 (renders `featured_placements`); no per-recipient send.

Both share one lifecycle. The differences are in what "running" *does* (enqueue sends
vs. flip a placement live) and which entitlement/inventory it draws down.

### 1.2 State machine (`ad_campaigns.status`)

States are exactly the contract's enum: `draft`, `pending_review`, `approved`,
`running`, `paused`, `done`, `rejected`.

```
                 advertiser submits
      draft ───────────────────────────▶ pending_review
        ▲   ◀───────────────────────────      │  │
        │      advertiser withdraws            │  │ admin rejects (reason)
        │                                      │  └──────────────▶ rejected  (terminal)
        │                          admin approves                     │
        │                                      ▼            clone ────┘ (→ new draft)
        │                                  approved
        │                                      │  scheduler: now ≥ starts_at
        │                                      ▼
        │  advertiser/admin pause ◀───────  running  ──────▶ done  (terminal)
        │        │        ▲                   │  ▲     scheduler: now ≥ ends_at,
        │        ▼        │ resume            │  │     or allowance/inventory exhausted,
        │     paused ─────┘                   │  │     or advertiser cancels
        │        │                            │  │
        │        └── advertiser cancels ──────┼──┴──▶ done
        │                                     │
        └─────────────── admin takedown ──────┘  (policy violation mid-flight → rejected, audited)
```

Terminal states: `done`, `rejected`. A rejected or done campaign is never re-opened —
the advertiser **clones** it into a fresh `draft` (copies creative + target, resets
status). This keeps the audit trail append-only.

### 1.3 Who transitions each edge

| From → To | Actor | Mechanism | Notes |
| --- | --- | --- | --- |
| — → draft | advertiser (business manager) | `advertiser_create_campaign` | starts in draft |
| draft → pending_review | advertiser | `advertiser_submit_campaign` | pre-checks entitlement (§6) + reach floor (§2.4) |
| pending_review → draft | advertiser | `advertiser_withdraw_campaign` | to edit after submitting |
| pending_review → approved | **admin** (A11 review queue) | `admin_review_campaign(…, approve=true)` | reserves inventory if `featured`; freezes creative snapshot |
| pending_review → rejected | **admin** | `admin_review_campaign(…, approve=false, reason)` | reason enum + note; audited |
| approved → running | **scheduler** | `sched_activate_due()` cron | automatic when `now() ≥ starts_at` |
| approved → done | scheduler | `sched_activate_due()` | edge: `ends_at` passed before it ever started |
| running → paused | advertiser **or** admin | `advertiser_pause_campaign` / `admin_halt_campaign(reversible=true)` | no new batches enqueue |
| paused → running | advertiser or admin | `advertiser_resume_campaign` | only if `now() < ends_at` |
| running → done | scheduler | `sched_activate_due()` | `now() ≥ ends_at`, or allowance/inventory drained |
| running/paused → done | advertiser | `advertiser_cancel_campaign` | early stop, releases inventory |
| running → rejected | **admin** | `admin_halt_campaign(reversible=false, reason)` | emergency policy takedown; releases inventory; audited |

**Only the scheduler flips into and out of `running` on time boundaries.** Humans
never manually "start" a campaign; approving it and setting `starts_at` is the start
signal. This keeps windowing/idempotency in one place.

### 1.4 What is editable in each state

| Field group | draft | pending_review | approved | running | paused | done/rejected |
| --- | --- | --- | --- | --- | --- | --- |
| creative (subject/body/image/link) | ✅ | ❌* | ❌ (frozen) | ❌ (frozen) | ❌ | ❌ |
| targeting (region/radius/segment) | ✅ | ❌* | ❌ | ❌ | ❌ | ❌ |
| `starts_at` | ✅ | ❌* | ✅ delay only, still future | ❌ | ❌ | ❌ |
| `ends_at` | ✅ | ❌* | ✅ shorten only | ✅ shorten only | ✅ shorten only | ❌ |
| `frequency_per_week` | ✅ | ❌* | ❌ | ❌ | ❌ | ❌ |
| status (pause/resume/cancel) | — | withdraw | — | ✅ | ✅ | — |

\* In `pending_review`, nothing is editable in place — the advertiser must
`withdraw` back to `draft` (which re-opens the full form and invalidates the pending
review). Rationale: **the admin reviews an immutable creative + target + reach quote.**
Anything material changing after approval requires re-review, so we only permit
*narrowing* (delay start, end early) post-approval; any *widening* forces a clone →
new review. This closes the classic "approve a benign creative, then swap in the real
one" bait-and-switch.

The creative the admin approved is snapshotted into `ad_campaigns.creative` and never
mutated thereafter; the scheduler always sends the snapshot, not a live-editable field.

---

## 2. Targeting & reach preview

### 2.1 Targeting inputs (all coarse — city granularity, never street-level)

An advertiser specifies **geography and/or a saved segment**, and the two compose as
an intersection:

- **Geography** — `target_region` (text, e.g. `"Waterloo, ON"`) resolved to
  `target_geog` (a **city centroid** point, from A3's IP→geo city table) plus
  `radius_km`. Radius operates at city granularity: enforce a **floor of 5 km** and a
  **ceiling of 100 km**, and snap to city centroids — there is no sub-city precision to
  target. "Near me" for an advertiser means "cities within N km of this city," not GPS.
- **Segment** — optional `segment_id` referencing a saved `user_segments` predicate
  owned by A3 (region + consent + activity filters). If both geography and segment are
  set, the eligible set is `geography ∩ segment`.

Consent is **implicit and non-negotiable**: the eligible set is *always* filtered to
`user_consents.marketing_opt_in = true`, not in `email_suppressions`, and not
`gpc_detected` — the advertiser never sees or toggles a consent knob. Only opted-in,
non-suppressed users are ever reachable. (Semantics owned by A1; A5 just calls the
eligibility function.)

### 2.2 The eligibility query is A2's, not A5's

There is exactly **one** place that decides "who is reachable for this campaign right
now": A2's eligibility query (call it `public.campaign_eligible_users(p_campaign_id)`).
It encapsulates: consent + suppression + GPC + the geography/segment predicate + the
**per-user 7-day global cap** (§3.2) + the per-campaign cadence de-dupe (§3.1). A5
*consumes* it in two shapes:

- **count-only** for the reach preview (returns an integer, never rows) — advertiser-
  facing.
- **row set of `user_id`s** for the dispatcher — admin/scheduler-only, never exposed to
  advertisers.

> **REQUEST TO A2:** expose the eligibility logic as (a)
> `campaign_estimated_reach(target…) returns int` — `SECURITY DEFINER`, count only,
> callable by business managers; and (b) `campaign_eligible_users(p_campaign_id, p_limit,
> p_region_filter) returns setof uuid` — `SECURITY DEFINER`, **not** granted to
> `authenticated`, called only by the scheduler. Same predicate, two return shapes, so
> the reach number an advertiser saw and the recipients we actually send to can never
> diverge in logic.

### 2.3 Reach preview — aggregate only, k-anonymous

The advertiser console (A10) shows an **estimated reach** as they tune geography/
filters. Rules:

- Returns a single integer (or a bucketed range), computed live via
  `campaign_estimated_reach`. **Never** a list, never individual locations — RLS +
  `SECURITY DEFINER` guarantee only a scalar leaves the DB.
- **k-anonymity floor:** if the count is below a threshold (default **30**), display
  `"<30"` and **block submission** (§2.4). This prevents an advertiser from narrowing a
  target until it identifies a handful of people. Round displayed counts to 2
  significant figures (e.g. `1,200`, not `1,187`) so the preview can't be used as an
  oracle to probe individuals by differencing.
- It is an *estimate*: it counts eligibility at preview time; the true send count is
  whatever eligibility yields at send time (consent/suppression/cap can move). The
  console must label it "estimated."

### 2.4 Submission gates

`advertiser_submit_campaign` refuses (clear error, campaign stays `draft`) when:

1. estimated reach `< 30` (k-anonymity) — for `email_blast`;
2. the advertiser's entitlement for that campaign type is exhausted (§6);
3. `starts_at` is in the past, `ends_at ≤ starts_at`, or window `> 90 days`;
4. for `featured`, no inventory slot is available in the requested (surface, region,
   week) (§3.3) — offer the next open week instead.

---

## 3. Scheduling & frequency

### 3.1 Per-campaign cadence (`frequency_per_week`) — advertiser-facing pacing

`frequency_per_week` is how often *this one campaign* may touch a given user within a
rolling 7 days. Defaults: `email_blast` → **1** (a blast is usually one-shot per
window); `featured` → interpreted as max slot **activations/week** (§3.3). The
dispatcher enforces it by keying idempotency on a per-occurrence bucket (§4.2): a user
who already has a `campaign_sends` row for this campaign in the current bucket is
skipped. This is *pacing the advertiser chose*, and it is always subordinate to:

### 3.2 Per-user GLOBAL cap — the user-protection cap (hard, non-negotiable)

**Default: 3 promotional messages per rolling 7 days per user, across ALL advertisers
and channels**, configurable in one place (a `growth_settings` row / `plan_features`
platform default). This is the contract's frequency cap and it belongs to the *user*,
not the advertiser.

- **Enforced at send time inside A2's eligibility query**, by counting the user's
  `campaign_sends` in `now() - interval '7 days'` (any campaign, any advertiser) and
  excluding users already at the cap. Checked at *send*, not just at compose — because
  another advertiser's blast may have consumed the user's budget in between.
- It is a **ceiling that wins over cadence**: even if three advertisers each set
  `frequency_per_week = 3`, a user still receives at most 3 total in 7 days. Fairness/
  arbitration of *which* 3 (first-come vs. round-robin across advertisers) is A12's
  call; A5 just honors whatever ordering the eligibility query returns and stops at the
  cap. Default ordering: oldest-`starts_at` campaign first (fair queueing), so a
  campaign can't jump the line by paying more.

Two counters, one truth: cadence lives in the campaign; the cap lives in the eligibility
query. The dispatcher can never exceed the cap because it only ever sends to the rows
the eligibility query returns.

### 3.3 Featured inventory model — scarce, sellable, time-boxed

Featured placements must be scarce to be sellable, so inventory is a **fixed number of
slots per surface per region per week**. A "slot-week" is the sellable unit.

**Default inventory per region per ISO week:**

| Surface | Concurrent slots | Sellable slot-weeks/week | What the user sees |
| --- | --- | --- | --- |
| `map` | 1 | 1 | one sponsored pin/badge, rotated into view |
| `browse` | 3 | 3 | up to 3 "Featured" cards pinned atop the list |
| `detail` | 1 | 1 | one "Sponsored nearby" card on a listing page |

So a region offers **5 featured slot-weeks/week** total. These numbers live in a config
table (below) and are tunable per region (a dense metro can carry more than a small
town). Scarcity is the product: when a week sells out, `advertiser_submit_campaign`
offers the next open week.

Within a booked slot-week, a featured campaign may **activate at most a few times/week**
— `frequency_per_week` caps activations (default/ceiling **3**), matching the contract's
"a few activations per week per advertiser slot." (Use-case: a lunch promo that surfaces
Mon/Wed/Fri rather than sitting live continuously.)

**Anti-oversell enforcement.** Inventory is *reserved at approval* (not at compose), so
a slot isn't held hostage by an unreviewed draft:

- For **capacity-1 surfaces** (`map`, `detail`): a `btree_gist` **exclusion constraint**
  on `featured_placements (surface WITH =, region WITH =, tstzrange(starts_at,ends_at)
  WITH &&)` makes the DB physically reject any second overlapping booking. Cleanest
  possible guarantee.
- For **capacity-N surfaces** (`browse`, N=3): an exclusion constraint can't express
  "at most N overlaps," so `admin_review_campaign` reserves under a **per-(surface,
  region) advisory lock** and counts overlapping active bookings `< capacity` before
  inserting. Serialize the check; the lock scope is tiny.

```sql
-- config: how much inventory each surface/region carries per week
create table public.featured_inventory (
  surface   text not null check (surface in ('map','browse','detail')),
  region    text not null,
  capacity  int  not null check (capacity between 0 and 20),
  primary key (surface, region)
);
-- exclusion guard for capacity-1 surfaces
alter table public.featured_placements
  add constraint featured_no_overlap_cap1
  exclude using gist (
    surface WITH =, region WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) where (surface in ('map','detail'));
```

> **REQUEST TO A2:** add `featured_inventory` (above) and the exclusion constraint on
> `featured_placements`. `featured_placements` already exists in the canonical model;
> this only adds the scarcity guardrails.

---

## 4. The scheduler (pg_cron)

Three small cron jobs, each a `SECURITY DEFINER` SQL/plpgsql function owned by the
`postgres`/service role and **not granted to `authenticated`** (they run as the cron
job, where `auth.uid()` is NULL). Each takes a **transaction-level advisory lock** so a
slow run never re-enters concurrently.

| Job | Cadence | Does |
| --- | --- | --- |
| `sched_activate_due` | every **1 min** | approved→running at `starts_at`; running→done at `ends_at` / exhaustion; activate & expire `featured_placements` |
| `sched_dispatch_blasts` | every **5 min** | for each `running` `email_blast`, enqueue the in-window shard of eligible recipients (idempotent), then poke A6 |
| `sched_reconcile` | every **15 min** | retry stuck `queued` sends, expire abandoned `sending` claims, roll up per-campaign counters, release inventory for done/rejected |

```sql
select cron.schedule('sched_activate_due',    '* * * * *',   $$ select public.sched_activate_due(); $$);
select cron.schedule('sched_dispatch_blasts',  '*/5 * * * *', $$ select public.sched_dispatch_blasts(); $$);
select cron.schedule('sched_reconcile',        '*/15 * * * *',$$ select public.sched_reconcile(); $$);
```

### 4.1 Activation (`sched_activate_due`)

```
lock pg_try_advisory_xact_lock('sched_activate_due')   -- skip if already running
-- start due campaigns
update ad_campaigns set status='running'
  where status='approved' and starts_at <= now() and ends_at > now();
-- finish expired campaigns
update ad_campaigns set status='done'
  where status in ('approved','running','paused') and ends_at <= now();
-- featured: mirror campaign state into placements
--   activate placements whose window has opened; expire those past ends_at
-- release inventory + write audit rows (actor_id NULL, detail.via='scheduler')
```

Featured needs no per-recipient work: A7 renders `featured_placements` where
`now() ∈ [starts_at, ends_at)` directly via RLS, so "going live" is just a state the
placement is already in. `sched_activate_due` only ensures the `campaign_sends`
impression accounting (if A7 logs impressions) and inventory release happen.

### 4.2 Dispatch + idempotency (`sched_dispatch_blasts`) — never double-send

The **`campaign_sends` row is the idempotency token.** Enqueue is a single
`INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`, so concurrent/overlapping cron
runs, retries, or a crash mid-batch can never produce a duplicate:

```sql
insert into public.campaign_sends
      (campaign_id, user_id, channel, occurrence_key, status, unsubscribe_token)
select c.id, u.user_id, 'email', public.occurrence_key(c.id, now()), 'queued',
       encode(extensions.gen_random_bytes(16),'hex')
from   public.ad_campaigns c
cross  join lateral public.campaign_eligible_users(c.id, 5000, :region_in_window) u
where  c.status='email_blast_running_predicate'          -- running email_blasts, window open
on conflict (campaign_id, user_id, occurrence_key) do nothing
returning id;                                             -- only truly-new rows come back
```

- **Unique key** `(campaign_id, user_id, occurrence_key)` where `occurrence_key`
  encodes the cadence bucket: for `frequency_per_week=1` it is a constant (`'once'`) →
  a user gets the campaign **at most once, ever**; for `>1` it is the ISO-week +
  occurrence ordinal → at most `frequency_per_week` per 7 days. This makes de-dupe a DB
  invariant, not application logic.
- The dispatcher only acts on rows it *actually inserted* (the `RETURNING` set), so a
  re-run enqueues nothing already queued.
- `campaign_eligible_users` already excludes anyone at the global 7-day cap and anyone
  suppressed/de-consented **as of now**, so the enqueue itself is the send-time consent
  gate. A6 re-checks suppression once more at claim time (defense in depth — §5.3).

### 4.3 Pausing

`sched_dispatch_blasts` selects only `status='running'` campaigns. A `paused` (or
`done`/`rejected`) campaign is simply not selected on the next tick → **no new batches
enqueue within ≤5 min of pausing.** Already-`queued` rows for a paused campaign are
held: A6's claim RPC (§5.2) filters to sends whose campaign is still `running`, so a
pause also stops queued-but-unsent rows from going out. Resuming re-includes the
campaign; its unsent `queued` rows flush on the next dispatch tick. No send is ever
lost or duplicated across a pause/resume because the unique key persists.

### 4.4 Windowing — don't email at 3am (recipient's coarse-region local daytime)

Send only when it is daytime where the recipient is. We have coarse region + city
centroid, which is enough for an approximate local hour with **no third party**
(Postgres ships the IANA tz database):

- A static `region_timezones(region text pk, iana_tz text)` map assigns each coarse
  region a representative IANA zone (e.g. `"Waterloo, ON" → America/Toronto`). Postgres
  computes `now() at time zone iana_tz` for the local hour.
- **Allowed window: local 09:00–20:00** (configurable). The dispatcher shards eligible
  recipients by region and, each tick, only enqueues the shards whose region is
  currently in-window; out-of-window shards wait for a later tick. Because it runs every
  5 min all day, every region's window is covered as it arrives in local time.
- A geo-targeted blast usually targets **one** region, so typically the whole campaign
  fires in a single in-window burst. A multi-region segment campaign naturally spreads
  across the day, region by region — which also smooths load (A13).
- Featured has no windowing (a placement is passively visible; the user pulls it).

> **REQUEST TO A2:** add `region_timezones(region, iana_tz)` and a `growth_settings`
> singleton for `{global_cap_per_7d:3, send_window_local:[9,20], k_anon_floor:30}`.

---

## 5. Scheduler → sender hand-off (interface to A6 email & A7 in-app)

The scheduler's job ends at "a batch of eligible `user_id`s + the frozen creative
exists in `campaign_sends`, and the sender has been poked." The senders own the wire.

### 5.1 What the scheduler PRODUCES

- Rows in **`campaign_sends`**: `(campaign_id, user_id, channel, occurrence_key,
  status='queued', unsubscribe_token, batch_id)`. `channel ∈ ('email','in_app')`.
- The **creative snapshot** lives on `ad_campaigns.creative` (frozen at approval); the
  sender joins to it by `campaign_id`. Nothing recipient-identifying beyond `user_id`
  ever leaves the DB toward the advertiser.
- A **poke**: after enqueue, `sched_dispatch_blasts` calls the A6 Edge Function via
  `pg_net` with `{batch_id}` (fire-and-forget). If the poke fails, `sched_reconcile`
  re-pokes any batch with stale `queued` rows — so delivery is never dependent on the
  HTTP call succeeding; the queue is the source of truth.

### 5.2 What A6 (email) CONSUMES — pull, don't push

A6 pulls work rather than receiving a payload, so it controls Resend's 100/batch and
2 req/s limits:

```sql
-- A6 calls this (service-role). Claims up to 100 queued email sends, marks them
-- 'sending' so a second worker can't grab them, returns everything needed to render.
claim_email_batch(p_batch_id uuid, p_limit int default 100)
  returns table(
    send_id uuid, user_id uuid, email text,
    subject text, body_html text, image_url text, link text,
    unsubscribe_token text, business_name text, business_address text
  );
-- After the Resend call, A6 reports outcomes:
mark_send_results(p_results jsonb)   -- [{send_id, status:'sent'|'failed', provider_id, error}]
```

- `claim_email_batch` **re-checks suppression + consent at the last moment** (a user
  may have unsubscribed between enqueue and claim) and silently drops now-ineligible
  rows to `status='suppressed'` instead of returning them. This is the second consent
  gate (A1).
- It returns `business_name/address` and an `unsubscribe_token` so A6 can build the
  CAN-SPAM footer (identifiable sender, physical address, one-click unsubscribe). A6
  owns footer rendering and the unsubscribe endpoint; A5 only guarantees the token and
  sender identity are present.
- `status` lifecycle owned jointly: A5 writes `queued`; A6 writes
  `sending → sent | failed | suppressed`; delivery webhooks (A6) later write
  `delivered | bounced | complained`, and a bounce/complaint feeds `email_suppressions`
  (A6/A1). A5 reads terminal statuses only for counters.

### 5.3 What A7 (in-app) CONSUMES

Two distinct in-app things:

1. **Featured placements** — A7 reads `featured_placements` where the window is open
   (RLS-public for active rows). There is no "send." The scheduler's only duty is the
   state/inventory flips in §4.1. A7 logs impressions/clicks to `analytics_events`
   (A4).
2. **In-app promotional messages** (if a campaign targets the in-app inbox rather than
   email): identical enqueue path with `channel='in_app'`. A7 pulls with a parallel
   `claim_inapp_batch(p_batch_id, p_limit)` and surfaces items in the user's notification
   feed; marking a row `sent` = "delivered to the feed." The **same global 7-day cap**
   applies across email + in-app because the cap counts all `campaign_sends` regardless
   of `channel`.

### 5.4 The contract in one line

> Scheduler → Sender = **idempotent `campaign_sends` rows (eligible `user_id` +
> `channel` + `unsubscribe_token` + `batch_id`) pointing at a frozen
> `ad_campaigns.creative`, plus a `pg_net` poke.** Senders claim, render, transmit, and
> write back terminal statuses. Consent is verified at enqueue *and* re-verified at
> claim. Advertisers never receive a recipient row — only aggregate counters (§7.3).

---

## 6. Budgets & limits by plan

Campaigns draw down the advertiser's plan entitlements. The entitlement *values* are
A9's (PRICING) and are stored in A2's `plan_features` (e.g. `blasts_per_month`,
`featured_per_week`, `max_locations`). A5 *enforces* them at two checkpoints.

| Entitlement | Consumed by | Checked at | On exhaustion |
| --- | --- | --- | --- |
| `blasts_per_month` | each `email_blast` that reaches `approved` | `advertiser_submit_campaign` + `admin_review_campaign` | **block** submit with a clear message + reset date; optionally **queue** with `starts_at` in the next cycle |
| `featured_per_week` | each `featured` booking, per ISO week reserved | submit + approve | block; offer next open week |
| inventory slot-week | `featured` reservation (§3.3) | approve (reserve) | block; offer next open week |
| global 7-day per-user cap | every send (all advertisers) | **send time**, in eligibility query | recipient skipped (user protection, not advertiser billing) |

- **Entitlement counting.** For `blasts_per_month`, count the business's `email_blast`
  campaigns that entered `approved`/`running` in the current calendar month (from
  `ad_campaigns`), not the number of *emails* — one blast to 10k people is one blast.
  Reference `plan_features.blasts_per_month` for the ceiling.
- **Where the check lives.** A shared helper (A2/A9) `plan_allows(p_business_id,
  p_feature, p_needed int) returns boolean` re-checks the live `subscriptions.plan` →
  `plan_features` join. A5 calls it; it does not hard-code numbers. This is the same
  pattern as `manages_bathroom()` — the paywall + a live subscription check in one place.
- **Block vs. queue.** Default is **block at submit** (fail fast, transparent). Queueing
  ("schedule for next period") is offered only when the advertiser explicitly opts in,
  and such a campaign sits in `approved` with a future `starts_at`; the scheduler starts
  it when the window and a refreshed entitlement both allow. A canceled/past-due
  subscription (`subscriptions.status not in ('active','trialing')`) blocks all submits
  and pauses `running` campaigns on the next `sched_reconcile` tick.

> **REQUEST TO A9/A2:** confirm `plan_features` columns `blasts_per_month`,
> `featured_per_week`, and a `plan_allows()` (or equivalent) entitlement helper. A5
> assumes these exist and reads them; it does not define the price/tier mapping.

---

## 7. Review / approval & policy

### 7.1 Every campaign is admin-reviewed before it can run

There is no auto-approve. A submitted campaign sits in `pending_review` in the A11
admin CRM review queue until an admin acts. `approved` is the *only* state
`sched_activate_due` will promote to `running`. This mirrors the existing
claim-verification pattern (`admin_review_claim`): an admin-gated RPC that both flips
state and writes the audit row in one transaction.

### 7.2 Creative policy & rejection reasons

Reviewers check for: deceptive/misleading claims, illegal or prohibited goods, adult/
hateful/harassing content, impersonation/trademark misuse, broken or off-platform
deceptive links, and low-quality/spam creative. Email specifically must be truthful in
subject and sender (CAN-SPAM); the unsubscribe + physical-address footer is *added by
A6*, but the reviewable body must not itself be deceptive.

Rejection carries a structured reason so the advertiser can fix and clone:

```
reject_reason ∈ ('deceptive','prohibited_content','impersonation_or_trademark',
                 'adult_or_hateful','broken_or_deceptive_link','low_quality',
                 'policy_other')   -- + free-text note (≤1000 chars)
```

### 7.3 Audit — to `moderation_actions`, like everything else

Every review decision, pause, resume, cancel, and takedown writes a
`moderation_actions` row in the same transaction as the state change (so a decision can
never happen without a record) — reusing the existing audit table, `is_admin()` gate,
and `detail jsonb` convention. Scheduler-driven transitions also audit, with
`actor_id = NULL` and `detail.via = 'scheduler'`.

> **REQUEST TO A2:** extend `moderation_actions` vocabulary:
> - `target_type` add `'campaign'`;
> - `action` add `'approve_campaign','reject_campaign','pause_campaign',
>   'resume_campaign','cancel_campaign','halt_campaign','activate_campaign',
>   'complete_campaign'`.
> (Same `alter … drop constraint … add constraint` shape as the
> `business_accounts` migration used to widen the action check.)

**Advertiser visibility is aggregate-only.** Advertisers read their own
`ad_campaigns`/`featured_placements` rows (RLS via `is_business_member`) and campaign
*counters* — `sent`, `delivered`, `bounced`, `unsub`, `estimated_reach`, featured
`impressions`/`clicks` — served by a `SECURITY DEFINER` RPC
`campaign_stats(p_campaign_id)` that returns only aggregates. They have **no** row-level
read on `campaign_sends` (that would leak the recipient list and, joined to locations,
individual users). Admins read everything.

---

## 8. Schema deltas (A5 needs from A2)

These extend the canonical model; A2 owns the authoritative DDL. Summary of A5's asks:

1. `ad_campaigns` — add `reject_reason text`, `review_note text`, `reviewed_by uuid`,
   `reviewed_at timestamptz`, `creative jsonb` (frozen snapshot), `paused_at`,
   `cloned_from uuid`. (Core columns already in the canonical model.)
2. `campaign_sends` — add `occurrence_key text` and `batch_id uuid`; unique index
   `(campaign_id, user_id, occurrence_key)`; `channel ∈ ('email','in_app')`; extend
   `status ∈ ('queued','sending','sent','failed','suppressed','delivered','bounced',
   'complained')`. Index `(user_id, sent_at)` to make the 7-day cap count cheap, and
   `(batch_id) where status in ('queued','sending')` for claims.
3. `featured_placements` — add `featured_inventory` config table + the
   `btree_gist` exclusion constraint (§3.3).
4. New: `region_timezones`, `growth_settings` (§4.4).
5. `moderation_actions` — widen `action` + `target_type` (§7.3).

### RLS posture (matches the codebase)

- `ad_campaigns`: `select` for `is_business_member(business_id)` (own) or `is_admin()`
  (all); **no** direct insert/update policy — all writes go through the RPCs below.
- `campaign_sends`: `select` for `is_admin()` only; advertisers get aggregates via RPC.
- `featured_placements`: public `select` for currently-active rows (so anon/A7 render
  them); owner/admin see all of theirs. Writes via RPC only.
- `featured_inventory`, `region_timezones`, `growth_settings`: admin read; writes
  service-role/admin RPC.

### RPC catalog (all `security definer`, `set search_path=''`, re-check role/entitlement)

| RPC | Caller | Effect |
| --- | --- | --- |
| `advertiser_create_campaign(business_id, type, target…, creative, starts_at, ends_at, frequency_per_week)` | business manager | insert `draft` |
| `advertiser_update_campaign(campaign_id, …)` | manager | edit `draft` (or approved-narrowing per §1.4) |
| `advertiser_submit_campaign(campaign_id)` | manager | `draft → pending_review`; gates §2.4/§6 |
| `advertiser_withdraw_campaign(campaign_id)` | manager | `pending_review → draft` |
| `advertiser_pause_campaign` / `advertiser_resume_campaign` / `advertiser_cancel_campaign` | manager | pause/resume/end |
| `advertiser_clone_campaign(campaign_id)` | manager | new `draft` from a done/rejected one |
| `campaign_estimated_reach(target…)` | manager | count only (§2.3) |
| `campaign_stats(campaign_id)` | manager | aggregate counters only (§7.3) |
| `admin_review_campaign(campaign_id, approve, reject_reason, note)` | admin | approve (reserve inventory, freeze creative) or reject; audit |
| `admin_halt_campaign(campaign_id, reversible, reason)` | admin | pause or takedown; release inventory; audit |
| `sched_activate_due()` / `sched_dispatch_blasts()` / `sched_reconcile()` | **cron only** (not granted to authenticated) | §4 |
| `claim_email_batch(batch_id, limit)` / `mark_send_results(results)` | **A6** (service role) | §5.2 |
| `claim_inapp_batch(batch_id, limit)` | **A7** (service role) | §5.3 |

---

## 9. Seams for A14 (integration) & open questions

- **Ordering/fairness under the global cap** (which 3 messages win when demand > cap) is
  A12's policy; A5 honors the eligibility query's ordering and defaults to oldest-
  `starts_at`-first. Confirm with A12.
- **Timezone map fidelity.** `region_timezones` is coarse (one zone per region); a
  region spanning a tz boundary just picks a representative zone. Acceptable given
  coarse-location-only; A3 to sanity-check the region list.
- **Newsletter featured slots** (A8) may sell the same `featured_placements` inventory
  on a `newsletter` surface — if so, add `'newsletter'` to the surface enum and a row in
  `featured_inventory`. Coordinate with A8.
- **Stripe-free today.** Entitlements read `subscriptions.plan` which admins set
  manually; the design is unchanged when Stripe later drives `subscriptions` — the
  `plan_allows()` seam already isolates it.
- **Batch size vs. Resend 2 req/s.** A6 owns pacing; A5 sizes batches at 100 to match
  the batch endpoint. If a single blast is very large, many 100-row batches are poked
  and A6 paces them — the queue (not the scheduler) absorbs the backlog.

Sources: [Resend Send Batch Emails](https://resend.com/docs/api-reference/emails/send-batch-emails),
[Supabase pg_cron](https://supabase.com/docs/guides/database/extensions/pg_cron),
[Supabase pg_cron availability (discussion #37405)](https://github.com/orgs/supabase/discussions/37405),
[Supabase RLS helper functions](https://supabase.com/docs/guides/database/postgres/row-level-security).
