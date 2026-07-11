# Watrloo Growth — Scaling & Cost (A13)

**Author:** A13 Scaling & Cost · **Date:** 2026-07-10

**Summary (3 lines).**
1. The **email quota is the whole ballgame**: Resend Free (3,000/mo, **100/day**) cannot send even one real blast; the ad product is unshippable until Resend Pro ($20/mo, 50k/mo, unlimited daily). Every marketing email costs **$0.0009** at the margin, so allowances must be capped or a Solo advertiser goes underwater.
2. On the Supabase side, **`analytics_events` is the fastest-growing table by ~10×** and blows the 500 MB Free DB at roughly **1,000–2,000 DAU within a quarter** unless A4 ships rollup + retention; `campaign_sends` and `user_locations` are secondary. Pro ($25/mo) buys 16× DB headroom and removes the 1-week idle pause but does **not** replace rollup.
3. Unit economics stay positive at every tier if email COGS is held to **~25% of price** (≈ `price × 278` emails/mo). This doc sets the max blast allowances that keep every tier ≥ ~75% gross margin and hands them to A9.

**Dependencies.** `docs/ops/SCALING.md` (existing free-tier photo/egress analysis — this doc extends it to the ad platform, does not repeat it). Assumes the canonical data model in `GROWTH_CONTRACT.md` (`analytics_events`, `campaign_sends`, `user_locations`, `plans`). Coordinates with: **A4 Analytics** (rollup/retention of `analytics_events`), **A9 Pricing** (consumes the allowance table in §4/§5), **A5 Campaigns** & **A6 Email delivery** (throughput ceiling in §7), **A12 Abuse/limits** (allowances are enforced as `plan_features` entitlements), **A1 Compliance** (retention windows double as a privacy control).

> **Scope discipline.** This is the money/scale math only. It does **not** design the sender, the scheduler, the schema, or the pricing tiers — it sets the *numbers* those docs must respect so nobody designs something that bankrupts the free tier or loses money per advertiser. Every platform figure is cited and tagged **[VERIFIED]** (fetched from the vendor's own page on the date shown) or **[MODELED]** (our arithmetic on top of verified caps — assumptions stated inline).

---

## 0. Verified platform numbers (fetched 2026-07-10)

Do not take these from memory — they move. Re-verify before a pricing change.

### Resend — email (source: <https://resend.com/pricing>, fetched 2026-07-10)

| Tier | Price/mo | Emails/mo | Daily cap | Overage |
|---|---|---|---|---|
| **Free** | $0 | **3,000** | **100/day** | none (hard cap) |
| **Pro** | $20 | **50,000** | unlimited | **$0.90 / 1,000** |
| Pro (slider) | $35 | 100,000 | unlimited | $0.90 / 1,000 |
| Scale | $90 | 100,000 | unlimited | $0.90 / 1,000 |
| Scale | $160 | 200,000 | unlimited | $0.80 / 1,000 |
| Scale | $350 | 500,000 | unlimited | $0.70 / 1,000 |
| Scale | $650 | 1,000,000 | unlimited | $0.65 / 1,000 |
| Enterprise | custom | custom | unlimited | custom |

- **Marginal email cost = $0.90 / 1,000 = `$0.0009` per email** [VERIFIED overage rate]. Within the Pro included 50k, the *blended* cost is `$20 / 50,000 = $0.0004`/email — we use the **higher $0.0009** as the honest unit COGS so every number below is conservative.
- **Batch send:** max **100 emails per API request**; max **50 addresses in a single `to`**; `attachments` and `scheduled_at` **not supported** in batch. (source: <https://resend.com/docs/api-reference/emails/send-batch-emails>, fetched 2026-07-10) [VERIFIED]
- **Rate limit:** **5 requests/second per team**, shared across all API keys; `429` on exceed; increasable for trusted senders by request. (source: <https://resend.com/docs/api-reference/introduction>, fetched 2026-07-10) [VERIFIED] — this is shared with **transactional** email (signup confirmations, password resets), so blasts and auth mail compete for the same 5 rps.

### Supabase (source: <https://supabase.com/pricing>, fetched 2026-07-10)

| Resource | Free | Pro ($25/mo base) |
|---|---|---|
| Database size | **500 MB** | **8 GB** included, then $0.125/GB |
| File storage | 1 GB | 100 GB incl., then $0.0213/GB |
| Egress | **5 GB** (+5 GB cached, separate) | 250 GB incl., then $0.09/GB |
| Monthly active users | 50,000 | 100,000 incl., then $0.00325/MAU |
| **Edge Function invocations** | **500,000/mo** | **2,000,000/mo** incl., then $2/1M |
| Compute | Nano (shared, 500 MB RAM) | $10/mo compute credit (one Micro) |
| Idle pause | **paused after 1 week** | none |

- **Edge Function runtime:** wall-clock **150s** (Free) / **400s** (Pro); CPU **2s** (excludes async I/O); memory **256 MB**. (source: <https://supabase.com/docs/guides/functions/limits>, fetched 2026-07-10) [VERIFIED]
- **pg_cron:** available on **all tiers incl. Free** (resource-bound, not plan-gated — `docs/ops/RATE_LIMITING.md` verification, discussion #37405). Supports **sub-minute** intervals (`'10 seconds'`, `'30 seconds'`) as well as standard cron; you cannot mix seconds with other units. (source: pg_cron docs) [VERIFIED]

### Cloudflare R2 (already verified in `docs/ops/SCALING.md`; source: <https://developers.cloudflare.com/r2/pricing/>)

- Free: **10 GB-month storage · 1M Class A ops/mo (writes) · 10M Class B ops/mo (reads) · $0 egress.** [VERIFIED]

---

## 1. Email economics — the big one

### 1.1 How many marketing emails per month?

Frequency cap = **3 promotional messages / 7 days / user** (`GROWTH_CONTRACT.md`). A month is `52/12 = 4.33` weeks, so the **hard ceiling per opted-in user is `3 × 4.33 ≈ 13 emails/user/month`** [MODELED] — reached only if every user is maxed out every week by advertiser demand. A realistic average is far lower because a user only receives mail when a campaign targets their segment; we model a **realistic ~4 emails/user/month** [MODELED assumption: ~1 relevant blast/week reaching the average user] alongside the 13 ceiling.

Let **N = opted-in users**. Monthly marketing volume:
- **Ceiling (all maxed):** `N × 13`
- **Realistic:** `N × 4`

Transactional mail (signup, reset, review notifications) rides the *same* Resend account. Baseline is small (a few per active user per month) but it **eats into the same 50k Pro allotment and the same 5 rps** — budget ~10% headroom for it.

### 1.2 Where the tier breaks

| Opted-in users N | Ceiling (N×13) | Realistic (N×4) | Verdict |
|---|---|---|---|
| 100 | 1,300 | 400 | **Free monthly OK — but the 100/day cap already blocks any single blast > 100 recipients.** |
| 230 | ~3,000 | ~920 | **Free monthly cap (3,000) breaks at the ceiling.** |
| 750 | 9,750 | 3,000 | Free breaks even at the realistic rate. Pro needed. |
| 3,850 | 50,000 | 15,400 | **Pro monthly cap (50,000) breaks at the ceiling.** |
| 12,500 | 162,500 | 50,000 | Pro breaks at the realistic rate → overage or Scale. |

**The daily cap is the real free-tier killer, not the monthly one.** Resend Free allows **100 emails/day** [VERIFIED]. A single email blast to a modest local audience (say 500 recipients) is **impossible on Free** — it exceeds the daily cap 5× on day one. So:

> **Hard conclusion: the ad product cannot ship on Resend Free. Resend Pro ($20/mo, 50k/mo, unlimited daily) is a fixed prerequisite the moment the first paid blast goes out.** That $20/mo is a **platform cost**, amortized across all advertisers — with even one Solo advertiser at $10/mo it is more than covered once there are ≥3 advertisers.

### 1.3 Per-advertiser email cost vs the ~$10/mo Solo price

The only variable cost of an advertiser is **their share of email volume** (creatives live on R2 at ~$0; DB/compute is pennies — §2, §3). So the question is purely: *does the blast allowance we grant cost less than the price we charge?*

Unit email COGS = **$0.0009/email** (conservative marginal rate). To keep email COGS at **≤ ~25% of price** (leaving ≥75% gross margin for the platform, transactional mail, and everything else), the max monthly send allowance is:

```
max_emails_per_month  =  price × 0.25 / $0.0009  ≈  price × 278
```

For the **$10 Solo** tier that is **~2,778 emails/month**. Rounded down to a clean, enforceable **2,500 sends/month**:
- Worst-case email COGS = `2,500 × $0.0009 = $2.25`.
- **Gross margin on a maxed-out Solo = `$10 − $2.25 = $7.75` (78%).** Positive with comfortable room.
- If a Solo were instead handed an uncapped allowance and blasted its whole city daily (say 30k emails/mo), COGS = `$27` — **underwater by $17/mo**. This is exactly the failure mode the allowance prevents.

**The blast allowance stays profitable only because it is capped.** Uncapped, a single $10 shop can outspend its subscription on email in a week. The caps in §4 are not a nice-to-have; they are what keeps the unit economics from going negative.

---

## 2. Supabase Free-tier limits at ad-platform scale

Existing app data (bathrooms, reviews, photo *rows*, profiles) is modeled in `docs/ops/SCALING.md` at well under 500 MB — call the pre-ad baseline **~50–100 MB**, leaving **~400 MB of headroom** on Free for the new ad-platform tables.

### 2.1 Row-size model [MODELED — includes ~23 B tuple header + typical indexes]

| Table | Bytes/row (incl. indexes) | Written when |
|---|---|---|
| `analytics_events` | **~0.3 KB** (uuid ids, jsonb `props`, region, occurred_at + 1–2 indexes) | every user interaction (page view, click, map pan) |
| `campaign_sends` | **~0.25 KB** (campaign_id, user_id, sent_at, channel, status, unsubscribe_token + freq-cap index on (user_id, sent_at)) | once per recipient per send |
| `user_locations` | **~0.3 KB** (ip_city/region/country, `geog` Point + GiST) | on sign-in / new IP |

### 2.2 Monthly growth and when 500 MB breaks

Assume **~20 analytics events / DAU / day** [MODELED — page views + map pans + clicks for a maps/reviews app].

| DAU | `analytics_events`/mo | Raw MB/mo | Free DB (400 MB headroom) breaks in |
|---|---|---|---|
| 1,000 | 600k | **180 MB** | **~2.2 months** |
| 2,000 | 1.2M | 360 MB | ~5 weeks |
| 5,000 | 3.0M | 900 MB | **~13 days** |
| 10,000 | 6.0M | 1.8 GB | **~7 days** |

`campaign_sends`: grows with total marketing volume. At, say, 200k marketing emails/mo platform-wide → **~50 MB/mo** of send rows [MODELED]. A single **50k-user blast writes ~12.5 MB** in one shot — a few big blasts is a real slice of 500 MB. `user_locations`: written on sign-in; at 10k users × ~10 logins/mo × 0.3 KB ≈ 30 MB/mo, but **retention-bounded** (below).

> **Fastest-growing table: `analytics_events`, by roughly an order of magnitude.** It is the one that actually breaks Free. Everything else is secondary.

**When Free breaks:** the DB wall is hit at roughly **1,000–2,000 DAU within a quarter** if `analytics_events` is retained raw. This is *sooner* than the 5 GB egress wall for a small photo audience (`SCALING.md` put egress at ~55–280 photo-viewing DAU — but egress is dominated by *photos*, which the ad platform doesn't add to; marketing email egress goes through **Resend**, not Supabase's 5 GB). So among the *new* ad-platform tables, **DB size via analytics is the binding Supabase limit.**

### 2.3 Retention / rollup — the containment (coordinate with A4)

The fix is not "buy Pro"; it is **don't keep raw events**. Hand these requirements to **A4 Analytics**:

1. **Roll up `analytics_events` → daily aggregates** (`event × region × day` counts) via a **pg_cron** job (nightly, or sub-minute for near-real-time). A rollup table is a few hundred rows/day — negligible forever.
2. **Prune raw events** older than a short window (**7–30 days**). A 7-day raw window at 1,000 DAU is `~140k rows ≈ 42 MB` steady-state — comfortably inside Free; 30 days is `~180 MB` and tighter. A4 picks the window; A13's constraint is **raw retention must keep the raw table under ~150 MB at target DAU**.
3. **`user_locations` retention:** keep only the **latest 1–3 per user** or a **90-day window** (whichever A1/A3 prefer). This is *also* a privacy control (data minimization) — cite `COMPLIANCE.md`. Bounds the table regardless of login volume.
4. **`campaign_sends` retention:** the **frequency cap only needs the last 7 days** and the advertiser reach count is an aggregate. Keep per-row sends for an audit window (**~90 days**), then roll up to per-campaign aggregate counts and prune the rows. Coordinate the exact window with **A5/A12** so the frequency-cap query and audit needs are both satisfied. [MODELED]

### 2.4 Edge Function invocations at scale

Free = **500,000 invocations/mo** [VERIFIED]. Consumers:
- **Sign-in geo capture** — if implemented as a dedicated Edge Function per login: at 10k DAU × ~1.5 logins/day × 30 = **~450k/mo → nearly the whole Free budget by itself.** **Mitigation (free):** capture coarse geo **inline** — a `SECURITY DEFINER` RPC reading Cloudflare edge geo headers (`CF-IPCountry`) or a GeoLite2 lookup, writing `user_locations` in the same request, **no separate function invocation**; or only re-capture on a *new* IP. (Design owned by A3; A13's note: **do not make sign-in geo a per-login Edge Function** — it's the invocation hog.)
- **Blast worker** — a 50k blast is one long-running invocation (§7), not 500 small ones. Invocations are **not** the blast bottleneck; the Resend 5 rps is.
- **Cron pump, unsubscribe handler, newsletter render** — small.

So Edge invocations bite around **~10–15k DAU** *only if* sign-in geo is a per-login function; done inline it never binds on Free.

### 2.5 What Pro ($25/mo) buys

- **500 MB → 8 GB DB** (16× headroom; `8 GB / 0.3 KB ≈ 26M analytics rows` — buys ~1 year at 2,000 DAU even without rollup, but **rollup is still cheaper and eventually mandatory**).
- **500k → 2M Edge invocations**; 5 → 250 GB egress; **removes the 1-week idle pause** (operationally important once real advertisers depend on scheduled blasts running on time).
- **Pro is a runway/reliability purchase, not a substitute for rollup.** Recommend the trigger for Pro be *"the 1-week pause is now a business risk"* (i.e. advertisers are live and scheduled sends must fire), which typically coincides with the DB wall — so **A4's rollup and a move to Pro land around the same growth point (~1–2k DAU)**, and rollup should ship *first* because it's free.

---

## 3. Cloudflare R2 — creative image storage (trivial, confirmed)

Ad/newsletter creatives (already client-compressed, ~50–200 KB each) go on **R2**, alongside the PMTiles basemap, and **never touch Supabase's 1 GB Storage**.

- **Storage:** `10 GB / 150 KB ≈ 66,000 creatives` before the Free cap [MODELED] — unreachable for this product.
- **Writes (Class A):** a handful per campaign; far under **1M/mo** [VERIFIED cap].
- **Reads (Class B):** served to app users, HTTP-cached; even millions of impressions stay under **10M/mo** [VERIFIED cap]. **Egress is $0.**

**Confirmed: creative storage on R2 is effectively free indefinitely and adds nothing to the Supabase walls.** Keep it there for the same reason `SCALING.md` puts the basemap there.

---

## 4. Blast allowances to hand to A9 (the enforceable caps)

These are the **max** monthly send allowances that keep email COGS ≤ ~25% of price (≥ ~75% gross margin). A9 may grant *less*; granting *more* pushes a tier toward underwater. Enforced server-side as `plan_features` entitlements (`blasts_per_month`, recipients-per-blast) and checked at send time by A5/A6/A12.

Formula: `max_emails/mo ≈ price × 278` (from §1.3). Tier prices below the Solo anchor are **assumed** (A9 owns final prices — mark accordingly); the *rule* is what matters.

| Tier | Price/mo (Solo verified; others assumed) | **Max sends/mo** | Suggested shape | Worst-case email COGS @ $0.0009 |
|---|---|---|---|---|
| **Solo** (single location) | **$10** | **2,500** | 2 blasts × ≤1,250 recipients | **$2.25** |
| Growth (assumed) | $30 | 7,500 | 3 blasts × ≤2,500 | $6.75 |
| Chain (assumed) | $100 | 25,000 | 4 blasts × ≤6,250 | $22.50 |
| Enterprise (assumed) | $500 | 125,000 | custom | $112.50 |

The **recipients-per-blast** sub-cap matters independently: it stops a Solo from spending its entire monthly allowance in a single citywide blast that also stresses the 5 rps and writes a large `campaign_sends` batch. Recommend `recipients_per_blast ≤ max_sends / blasts_per_month`.

---

## 5. Unit-economics model (per advertiser)

Marginal cost per advertiser = **email + storage + compute**. Storage (R2 creatives) ≈ $0 (§3). Compute (their share of DB rows + Edge/cron) ≈ a few cents/mo [MODELED — `campaign_sends` at ≤2,500 rows × 0.25 KB = 0.6 MB, plus a slice of the flat Pro compute credit]. **Email is ~99% of marginal cost**, so gross margin is essentially `price − (allowance × $0.0009)`.

| Tier | Price | Email COGS (max) | Storage | Compute | **Marginal cost** | **Gross margin** | Margin % |
|---|---|---|---|---|---|---|---|
| **Solo** | $10 | $2.25 | ~$0 | ~$0.05 | **~$2.30** | **~$7.70** | **~77%** |
| Growth | $30 | $6.75 | ~$0 | ~$0.10 | ~$6.85 | ~$23.15 | ~77% |
| Chain | $100 | $22.50 | ~$0 | ~$0.25 | ~$22.75 | ~$77.25 | ~77% |
| Enterprise | $500 | $112.50 | ~$0 | ~$1 | ~$113.50 | ~$386.50 | ~77% |

**Platform-fixed costs** (not per-advertiser) sit on top: Resend Pro **$20/mo** and (post-growth) Supabase Pro **$25/mo** = **$45/mo fixed**. Break-even on fixed cost = `$45 / $7.70 ≈ 6 Solo advertisers` (or ~2 Growth). Below that, the platform runs at a small loss on infra — expected and fine at seed stage.

**Underwater flags:**
- **No tier is underwater at these allowances.** The only way any tier goes negative is granting an allowance above `price × 278` — e.g. an "unlimited blasts" promise on the $10 Solo. **Do not offer unlimited email at any price point below ~$50/mo.**
- The **Solo tier is the thinnest** (77% margin, but only $7.70 absolute). If A9 wants to add high-touch support or a dedicated IP (Resend Scale adds dedicated IPs) to Solo, the margin erodes fast — keep Solo's allowance at/under 2,500 and push volume buyers up-tier.

**Recommended fix if A9 prices differently:** re-run `max_sends = price × 278` for the actual prices and set `blasts_per_month × recipients_per_blast` to that product. That single rule keeps every tier ≥ ~75% margin automatically.

---

## 6. Growth breakpoints — the cost curve, ranked by what bites first

Ordered by the growth point at which each limit binds. "$W to fix" is the incremental monthly spend or the one-time engineering fix.

| # | Bites at | Limit | Symptom | Fix | Cost of fix |
|---|---|---|---|---|---|
| **1** | **First real blast** (day one of the ad product) | **Resend Free 100/day** [VERIFIED] | any blast > 100 recipients fails / trickles over days | **Resend Pro** | **+$20/mo** (fixed; covered by ≥3 advertisers) |
| **2** | **~1,000–2,000 DAU** (within a quarter) | **Supabase Free 500 MB DB** via `analytics_events` [VERIFIED cap; MODELED fill rate] | DB fills, writes start failing | **A4 rollup + 7–30d raw retention** (free) — *then* Supabase Pro if still tight | **$0 eng first**; **+$25/mo** only if needed |
| **3** | **~1–2k DAU, real advertisers live** | **Supabase Free 1-week idle pause** [VERIFIED] | scheduled blasts miss their window after idle | Supabase Pro (no pause) | **+$25/mo** |
| **4** | **> 50k marketing emails/mo** (~4k users maxed, or ~12k realistic) | **Resend Pro 50k/mo** [VERIFIED] | overage billing kicks in | overage $0.0009/email **or** step to $35/100k / Scale $90 | **revenue-backed** — advertisers paid for these sends; stays positive if allowances (§4) hold |
| **5** | **~10–15k DAU** *(only if sign-in geo is a per-login function)* | **Supabase Free 500k Edge invocations** [VERIFIED] | function invocations throttle/bill | make geo capture **inline** (RPC/headers), or Supabase Pro (2M) | **$0 eng** (inline) or included in the +$25 Pro |
| **6** | Large photo audience (pre-existing, not ad-driven) | **Supabase Free 5 GB egress / 1 GB storage** [VERIFIED] | photo delivery throttles | already solved in `SCALING.md` (compress, thumbnails, basemap+creatives on R2, SPA on CDN) | $0 (design already exists) |

**Reading the curve:** the platform crosses **one fixed cost early (Resend Pro, +$20)** essentially at launch of the ad product, then a **second fixed cost (Supabase Pro, +$25)** around **1–2k DAU** — but that second one should be *preceded* by A4's free rollup, which is the actual fix. After that, all further email cost is **variable and revenue-backed**: it only grows because advertisers bought sends, and §4's allowances guarantee each such send was sold above cost. **The owner's total fixed infra bill goes $0 → $20 → $45/mo across the first ~1–2k DAU**, and stays there for a long time.

---

## 7. Scheduling & throughput — the real ceiling for a blast

**Governing limits (all [VERIFIED], §0):** Resend **5 req/s per team** · **100 emails/batch** · Edge Function wall-clock **150s Free / 400s Pro** · pg_cron **sub-minute capable**.

**Throughput ceiling:**
```
5 req/s × 100 emails/batch = 500 emails/second  (= 30,000/min = 1.8M/hour, theoretical max)
```
This 5 rps is **per team and shared with transactional email** — real blast throughput is a bit under 500/s once auth mail is in flight.

**How long does a 50k-user blast take?**
```
50,000 emails ÷ 100 per batch      = 500 batch requests
500 requests ÷ 5 requests/second   = 100 seconds  ≈ 1.7 minutes  (pure Resend API time)
```
- At 500 emails/s, **75,000 emails fit inside a single 150s Free-plan Edge Function invocation** before the wall-clock — so a 50k blast is **one long-running invocation**, not 500 small ones. With DB writes to `campaign_sends`, consent/suppression re-checks at send time, and 429 back-off retries, budget **~2–5 minutes wall-clock for 50k** [MODELED].
- **The bottleneck is Resend's 5 rps, nothing else.** pg_cron granularity (down to seconds) is irrelevant — a per-minute or per-10s pump easily keeps the 5 rps pipe full. Edge concurrency is irrelevant — spawning more workers just earns `429`s against the shared 5 rps.
- **A blast > ~75k recipients must be chunked** across multiple invocations (it exceeds even the 400s Pro wall-clock at 5 rps: `400s × 500/s = 200k` is the Pro single-invocation ceiling; Free's `150s × 500/s = 75k`). Design (A5/A6): a **queue table** (`campaign_sends` rows pre-staged as `pending`) drained by a **pg_cron-triggered worker** that sends batches until its time budget is nearly up, then yields to the next tick. This makes blast size unbounded and crash-safe (resumes from the last un-sent row).
- **For any blast approaching the whole user base, request a Resend rate-limit increase** in advance (they grant it for trusted senders) — at 5 rps, a 500k-user newsletter takes `500k/500 = 1,000s ≈ 17 min` of API time; at a raised 20 rps it's ~4 min.

**Recommended defaults to hand A5/A6:**
- Pump cadence: pg_cron every **30–60s**, worker sends batches within a ~120s budget (Free) / ~350s (Pro), stops before wall-clock, resumes next tick.
- Batch size: **100** (the max). Recipients per email: **1** for marketing (per-recipient unsubscribe token), so 100 distinct recipients per batch request.
- Global send governor: cap at **~4 req/s** to leave headroom for transactional mail under the shared 5 rps.

---

## 8. Verified vs modeled — quick index

**[VERIFIED]** (vendor pages, fetched 2026-07-10, cited inline): Resend Free 3,000/mo & 100/day; Pro $20/50k unlimited-daily; overage $0.90/1k; batch 100 / 50-to / no attachments; 5 rps/team. Supabase Free 500 MB DB / 1 GB storage / 5 GB egress / 50k MAU / 500k Edge invocations; Pro $25 → 8 GB DB / 2M invocations; Edge wall-clock 150s/400s, CPU 2s, 256 MB. pg_cron on all tiers, sub-minute. R2 Free 10 GB / 1M Class A / 10M Class B / $0 egress.

**[MODELED]** (our arithmetic — assumptions stated at use): 13 emails/user/mo ceiling & 4/user/mo realistic; row sizes (0.3/0.25/0.3 KB); 20 events/DAU/day; DB fill timelines; per-advertiser allowance formula `price × 278`; unit-econ margins; blast wall-clock 2–5 min for 50k; compute cents/advertiser.

**Re-verify before acting on:** exact per-viewport R2 op counts (out of this doc's scope; see `SCALING.md`), and any Resend/Supabase price change — both vendors move these numbers.
