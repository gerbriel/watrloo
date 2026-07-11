# NEWSLETTER — periodic editorial + sponsored digest (A8)

**Summary.** A monthly, opt-in newsletter to account holders that mixes editorial
(new/notable bathrooms nearby, tips) with a small number of **sold advertiser
feature slots**. It reuses the same consent gate, suppression list, frequency
cap, scheduler, sender, and branded email template as the marketing blasts — it
is *not* a separate channel, just a recurring campaign shape with editorial
content and a fixed sponsored-inventory ratio.

**Dependencies.** A2 (`DATA_MODEL.md` — owns the two tables below; all field
requests route here), A5 (`CAMPAIGNS.md` — scheduler, frequency cap), A6
(`EMAIL_DELIVERY.md` — Resend batch send, bounce/open webhooks, template),
A1 (`COMPLIANCE.md` — consent gate, sponsored-disclosure wording, CAN-SPAM),
A9 (`PRICING.md` — price of a newsletter slot), A4 (`ANALYTICS.md` — opens/clicks
events), A3 (`LOCATION.md` — region assignment), A7 (`INAPP_ADS.md` — shared
`featured_placements` surface + labeling), A10/A11 (consoles that render this).

This doc designs **only** the newsletter. Send mechanics belong to A6, slot
pricing to A9, disclosure rules to A1 — deferred where noted.

---

## 1. Product

### 1.1 Cadence — monthly
Default **once per calendar month**, configurable per region. Rationale:

- The newsletter is a **promotional message** and counts as **1 of the user's
  3-per-7-day cap** (A5, shared contract §"Frequency cap"). Monthly cadence
  spends almost none of that budget, leaving room for time-sensitive blasts.
- A month accumulates enough new bathrooms + notable activity to fill an edition
  without scraping the barrel, and keeps admin authoring load to ~1 compose/region/month.
- It stays comfortably inside send-volume limits (§5.5).

Weekly/biweekly is possible later per region, but only if a region has enough
editorial supply *and* enough sold inventory to justify it — otherwise readers
get thin, ad-heavy editions and unsubscribe.

### 1.2 Audience — `marketing_opt_in`, checked at send time
The newsletter carries paid ads, so it is **marketing**, gated by the **same
consent as blasts** — no separate "newsletter consent." A recipient qualifies iff,
**evaluated at send time** (not at compose, not at signup):

```
user_consents.marketing_opt_in = true
AND user_consents.newsletter_opt_out = false        -- stream-level opt-out, §4.4 (REQUEST TO A2)
AND NOT EXISTS global suppression in email_suppressions   -- A6 / bounce / complaint / all-marketing opt-out
AND user_consents.gpc_detected handled per A1 (GPC → treat as opted-out of "sharing")
AND a verified, deliverable email exists
```

Consent + suppression are re-checked at send time by A5/A6, per A1. A8 never
maintains its own recipient list; it hands A5 a **predicate** (region) and A5
resolves the live audience.

### 1.3 Regional editions (optional)
An edition may target a **region** (`user_locations.ip_region`, per A3) or be the
**default/national edition** (`region IS NULL`). A user is assigned **exactly one**
edition per cycle:

1. Take the user's **most-recent** `user_locations.ip_region` (A3).
2. If a `sent`/`scheduled` edition exists for that region+cycle → assign it.
3. Else fall back to the **default** edition for the cycle.
4. **Dedup:** a user receives at most one edition per cycle. This protects the
   frequency cap and prevents a national + regional double-send.

Users with no location on file (location opt-out, or never captured) always get
the default edition — location consent is **not** required to receive a
marketing email, only marketing consent is. Regional editions simply *personalize*
content; they never expand or gate the audience.

### 1.4 Content mix
Each edition is an ordered list of **content blocks** (§3.2). Two families:

- **Editorial (unpaid, admin/auto-curated):**
  - *New nearby* — bathrooms in the region `created_at` since the last edition
    (from `bathrooms`, region-filtered via A3), auto-suggested, admin-trimmed.
  - *Notable* — high-rated or newly-reviewed listings (`bathroom_stats` view).
  - *Tips / guides* — free-text editorial (accessibility finds, "code-required"
    warnings, seasonal notes).
- **Sponsored (sold):** advertiser feature slots (§2), capped per edition.

Target ratio: **editorial dominates** — sponsored blocks are a minority of the
edition (default cap in §2.3). This is a product decision, not just compliance:
an ad-heavy digest kills open rates and drives unsubscribes, which shrinks the
very inventory we sell.

---

## 2. Advertiser features in the newsletter (the monetizable slot)

A newsletter feature is a **`featured_placements` row on a new surface**, so it
reuses every existing guardrail (frequency limits, campaign approval, region
targeting) instead of inventing a parallel ad object.

### 2.1 How a business buys a slot
1. Advertiser (via A10 console) creates/uses an `ad_campaigns` row,
   `type = 'featured'`, targeting a `target_region`, with `starts_at/ends_at`
   spanning the intended edition's send date. Goes through the normal
   `draft → pending_review → approved` review (A5) + moderation.
2. On approval, admin (or the advertiser self-serve, per A10) reserves a
   newsletter slot → a `featured_placements` row:
   ```
   surface = 'newsletter'          -- REQUEST TO A2: add 'newsletter' to surface enum
   region  = <edition region>      -- must match the edition's region (or NULL for national)
   starts_at / ends_at             -- must contain the edition's scheduled_at
   campaign_id = <the ad_campaign>
   ```
3. Admin embeds it into an edition via `admin_add_sponsored_slot()` (§4.3), which
   validates approval, region match, window, and **remaining inventory**.

Pricing of the slot (flat per-edition, per-region, or per-1k-delivered) is **A9's
call** — see `PRICING.md`. A8 only guarantees the *inventory* is scarce and the
*placement* is well-defined. Money is manual today (admin arranges payment
out-of-band, shared contract §"Money"); the slot is reservable without Stripe.

### 2.2 Linking a placement to an edition
The **edition's `blocks` JSON is the source of truth** for what renders: a
`sponsored` block carries `featured_placement_id`. To make the reverse lookup
(which edition did this placement run in?) cheap for billing/metrics:

> **REQUEST TO A2:** add nullable `newsletter_edition_id uuid REFERENCES
> newsletter_editions(id)` to `featured_placements`. Set when a slot is embedded;
> lets A4/A9/A10 report "this placement ran in the July Waterloo edition" without
> parsing JSON.

### 2.3 Inventory per edition per region
Pinned default: **3 sponsored slots per edition per region** (configurable via a
setting, e.g. `plan_features`/site config — A9/A2). Rationale: with ~6–10
editorial blocks per edition this keeps ads a clear minority (§1.4) and makes the
slot genuinely scarce (scarcity is what makes it sellable). National (default)
editions and each regional edition have **independent** inventory — the same
advertiser can buy Waterloo *and* national, but each is one placement.

`admin_add_sponsored_slot()` refuses to embed a slot that would exceed the cap.
Slot **position** within the edition (e.g. after block 3, after block 6) is part
of the composition, not sold separately at launch — keep it simple.

### 2.4 Labeling as sponsored
Every sponsored block renders a visible **"Sponsored"** label adjacent to the
advertiser's content, visually distinct from editorial, per A1/A7 disclosure
rules. A8 does **not** decide the exact wording or placement — it commits to:

- a `label` field on the block (default `"Sponsored"`),
- rendering it in the template above/beside the ad creative, never hidden,
- the same treatment A7 uses for in-app placements, so disclosure is consistent
  across surfaces. **Final wording/format = A1 (`COMPLIANCE.md`).**

### 2.5 Frequency cap interaction
- **Reader side:** the whole edition is **one** message → **1** promotional send
  toward the user's 3/7-day cap (A5), regardless of how many ad slots it embeds.
  The ads do *not* each count; the newsletter is a single delivery.
- **Advertiser side:** embedding a placement into a sent edition = **one
  activation** of that `featured_placement`, counting toward the advertiser's
  `featured_per_week` allowance (A5/A9), same as an in-app featured activation.
- Because newsletter sends log to `newsletter_sends` (a separate table, §3), the
  **cap query must count both tables**:

  > **REQUEST TO A2/A5:** expose a `promotional_sends` view =
  > `SELECT user_id, sent_at, 'blast' FROM campaign_sends
  >  UNION ALL SELECT user_id, sent_at, 'newsletter' FROM newsletter_sends`,
  > and have A5's frequency-cap function read the view, so a newsletter and a
  > blast in the same week correctly sum against 3/7-days.

---

## 3. Data model

A2 owns `newsletter_editions` + `newsletter_sends` (shared contract §CANONICAL).
Below is the **proposed shape** A8 needs; all additions are **REQUEST TO A2**.
Conventions match the codebase: snake_case, RLS on every table, mutations via
`SECURITY DEFINER` RPCs with `set search_path = ''`, `(select public.is_admin())`
initplan form in policies.

### 3.1 `newsletter_editions`
```sql
-- REQUEST TO A2: create table
create table public.newsletter_editions (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,          -- e.g. '2026-07-waterloo', '2026-07-national'
  title         text not null,                 -- human label, shown in admin
  region        text,                           -- ip_region value; NULL = default/national edition
  status        text not null default 'draft'
                check (status in ('draft','scheduled','sending','sent','canceled')),
  scheduled_at  timestamptz,                    -- when A5 should release it
  subject       text not null,                  -- email Subject:
  preheader     text,                           -- inbox preview text
  blocks        jsonb not null default '[]',    -- ordered content blocks (§3.2)
  created_by    uuid references auth.users(id),
  sent_count    int  not null default 0,        -- filled by A6 after send
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- one edition per region per cycle (partial-unique on the cycle key lives in the slug)
```
**RLS:** admin-only for all operations (`is_admin()`). Editions contain unpublished
editorial + sold-slot info; advertisers and users never read this table directly.

### 3.2 `blocks` JSON schema (authored artifact)
An ordered array; each block is self-describing. Sketch:
```jsonc
[
  { "id": "b1", "type": "hero",      "title": "July in Waterloo", "intro": "..." },
  { "id": "b2", "type": "bathroom",  "bathroom_id": "…", "kind": "new" },      // auto-rendered from bathrooms
  { "id": "b3", "type": "bathroom",  "bathroom_id": "…", "kind": "notable" },
  { "id": "b4", "type": "sponsored", "featured_placement_id": "…",
                 "business_id": "…", "headline": "…", "image_url": "https://<r2>/…",
                 "body": "…", "cta_url": "https://…", "label": "Sponsored" },
  { "id": "b5", "type": "editorial", "heading": "Tip", "body_md": "…" },
  { "id": "b6", "type": "divider" }
]
```
Block types: `hero`, `bathroom` (rendered from live `bathrooms`/`bathroom_stats`
so facts stay fresh), `editorial` (free text, minimal markdown), `sponsored`
(§2), `divider`. Renderer (A6 template, §5) ignores unknown types.

### 3.3 `newsletter_sends` (mirror of `campaign_sends`)
```sql
-- REQUEST TO A2: create table, same shape family as campaign_sends
create table public.newsletter_sends (
  id                uuid primary key default gen_random_uuid(),
  edition_id        uuid not null references public.newsletter_editions(id),
  user_id           uuid not null references auth.users(id),
  channel           text not null default 'email',
  status            text not null default 'queued'
                    check (status in ('queued','sent','delivered','bounced','complained','skipped')),
  sent_at           timestamptz,
  unsubscribe_token uuid not null default gen_random_uuid(),   -- per-send, powers one-click
  provider_msg_id   text,                                       -- Resend message id (A6, for webhooks)
  skip_reason       text,                                       -- 'suppressed' | 'capped' | 'no_consent' | 'no_email'
  created_at        timestamptz not null default now(),
  unique (edition_id, user_id)
);
```
**RLS:** admin-only. Powers suppression + audit + advertiser **aggregate** reach
counts (never per-user to advertisers, shared contract §Admin-only CRM). Opens/
clicks are **not** stored here — they flow to `analytics_events` (§6) to avoid a
wide, churny per-recipient table.

> **REQUEST TO A2 (consent):** add `newsletter_opt_out bool not null default
> false` to `user_consents` for the stream-level opt-out in §4.4.

---

## 4. Authoring & scheduling

Reuses A5 (scheduler + cap) and A6 (sender + template) end-to-end. A8 adds only
the composer and the compose-time validations.

### 4.1 Pipeline (clean seams)
```
A8 compose (admin)                A5 schedule/gate            A6 send                A4 metrics
──────────────────                ────────────────           ───────               ──────────
create edition (draft)                                                              
add editorial + sponsored blocks                                                     
admin_schedule_edition() ───────► resolve region audience                            
                                  re-check consent/suppress                          
                                  apply 3/7-day freq cap ───► Resend batch send ───► newsletter_open
                                  (writes skip_reason)        write newsletter_sends  newsletter_click
                                                              bounce/complaint hook   (aggregated per
                                                                                       edition + slot)
```
- **A5 owns audience resolution + gating.** A8 supplies `(region predicate,
  scheduled_at)`; A5 turns it into the live recipient set at send time, applying
  §1.2 consent, §1.3 dedup, and the frequency cap. This is the same machinery
  that gates blasts — the newsletter is just another scheduled job.
- **A6 owns delivery.** It batches to Resend (≤100/batch), writes `newsletter_sends`
  rows, sets `provider_msg_id`, and processes bounce/complaint webhooks into
  `email_suppressions`. A8 does not send.

### 4.2 Composer (admin-only)
A composer screen in the Admin CRM console (chrome/layout = **A11**). Functions:
pick region + cycle, auto-suggest editorial (new/notable in region), add/reorder
blocks, insert sold slots from approved newsletter placements, live preview in the
A6 template, send-test-to-self, then schedule.

### 4.3 RPC surface (SECURITY DEFINER, admin-gated except unsubscribe)
```
admin_create_newsletter_edition(region text, cycle date, subject text, preheader text)
    → uuid            -- builds slug '<cycle>-<region|national>', status='draft'
admin_set_edition_blocks(edition_id uuid, blocks jsonb)
    → void            -- validates block schema; editorial only
admin_add_sponsored_slot(edition_id uuid, featured_placement_id uuid, position int)
    → void            -- CHECKS: placement.surface='newsletter', region matches edition,
                      --   campaign approved & window covers scheduled_at,
                      --   inventory < cap (§2.3); sets featured_placements.newsletter_edition_id
admin_schedule_edition(edition_id uuid, scheduled_at timestamptz)
    → void            -- status → 'scheduled'; hands off to A5
admin_cancel_edition(edition_id uuid) → void
newsletter_unsubscribe(token uuid, scope text)   -- SECURITY DEFINER, NO auth (token-authenticated)
    → void            -- scope ∈ ('newsletter','all'); §4.4
```
All admin RPCs re-check `is_admin()` and write to `moderation_actions`/audit.

### 4.4 Unsubscribe — one-click, with decided granularity
Two entry points, satisfying both **CAN-SPAM** (honor opt-out, physical address,
one-click) and the **Gmail/Yahoo bulk-sender rules (Feb 2024)** requiring
RFC 8058 one-click unsubscribe on bulk mail.

- **Header one-click (RFC 8058).** Every send sets
  `List-Unsubscribe: <https://…/unsub?t=TOKEN>, <mailto:unsubscribe@watrloo.com?subject=TOKEN>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The one-click POST
  calls `newsletter_unsubscribe(token, 'newsletter')` → **stops the newsletter
  only** (sets `user_consents.newsletter_opt_out = true`). No page, instant.
- **In-body visible link →** an unsubscribe **landing page** offering a choice:
  1. *Unsubscribe from the newsletter* (default) → `scope='newsletter'`.
  2. *Unsubscribe from all Watrloo marketing* → `scope='all'` → global
     `email_suppressions` entry + `marketing_opt_in=false` (the shared kill-switch).

**Decision — offer granularity: yes, two levels.** The *easiest* action (one-click)
stops just this stream, because that is the least-surprising response to "stop
this newsletter," and stopping *everything* is one extra click away. This is
CAN-SPAM compliant (an opt-out menu is permitted as long as the specific stream
can be stopped) and less punishing than an all-or-nothing switch, which would
cost us blast reach every time someone tires of the digest. Both are honored at
send time by A5/A6 — a stream opt-out suppresses newsletters but not blasts; a
global opt-out suppresses everything. Suppression is checked at send, per A1.

---

## 5. Template design (reuse the branded transactional style)

Reuse the existing branded transactional email style (see `docs/ops/EMAIL.md`);
the newsletter is a longer, multi-block variant of the same shell.

### 5.1 Hard rules for email HTML
- **Table-based layout**, 600px max content width, everything centered in an outer
  100% table — Outlook/Windows Mail still lack flexbox/grid support.
- **Inline CSS** on elements (many clients strip `<style>`); a `<style>` block is
  used *only* for `@media (prefers-color-scheme: dark)` and width media queries,
  which Outlook ignores harmlessly.
- **Self-hosted logo on Cloudflare R2** (public bucket, e.g.
  `https://assets.watrloo.com/email/logo@2x.png`), served at 2× and sized down in
  HTML, with real `alt="Watrloo"`. No external CSS/JS/fonts — many clients block
  them and CAN-SPAM/deliverability favors a plain, self-hosted asset.
- **Dark-mode-safe:** don't rely on transparency. Use a logo with built-in padding
  that reads on both light and dark, or ship a light variant swapped via
  `@media (prefers-color-scheme: dark)`. Set explicit `bgcolor` on table cells
  (bulletproof backgrounds) and avoid pure-black/pure-white text on brand fills.

### 5.2 Brand palette (from `src/index.css` `@theme`)
Porcelain neutrals + "flush" blue + cyan accent, matching the app:
`--color-flush-600 #0284c7` (primary/links/CTA), `--color-flush-500 #0ea5e9`,
`--color-cyan-500 #06b6d4` (accent/gradient), porcelain `#f6f9fb → #1a2531`
(surfaces/text), star `#f5a524` (ratings). Fonts degrade to system stack in mail
(`Inter`/`Space Grotesk` won't load; specify web-safe fallbacks).

### 5.3 Structure (top → bottom)
1. **Preheader** (hidden, from `preheader`) — inbox preview.
2. **Header** — R2 logo + edition title/region.
3. **Blocks** rendered in order (§3.2): hero → bathroom cards → editorial →
   sponsored (with "Sponsored" label, §2.4) → dividers.
4. **Footer (CAN-SPAM required):** identifiable sender ("Watrloo"), a valid
   **physical postal address** (or equivalent — A1 supplies the exact string),
   the visible unsubscribe link (§4.4), and a short "you're getting this because
   you opted into Watrloo marketing" line.

Sender: `Watrloo <newsletter@watrloo.com>` (domain verified per `docs/ops/EMAIL.md`;
SPF/DKIM/DMARC already required for the transactional stream — same auth satisfies
the bulk-sender rules).

### 5.4 Link + open tracking hooks
- Every `cta_url` and content link is rewritten to a **first-party redirect**
  (`https://…/r?e=EDITION&b=BLOCK&p=PLACEMENT&u=…`) that logs a `newsletter_click`
  event (§6) then 302s to the target. Keeps click analytics first-party (shared
  contract §Analytics), and gives per-slot advertiser numbers.
- A 1×1 self-hosted pixel logs `newsletter_open`. **Caveat (honest):** Apple Mail
  Privacy Protection (2021) pre-fetches images, inflating opens; treat opens as a
  soft signal and lead advertiser reporting with **clicks + delivered count**.

### 5.5 Volume / send-window (seam to A13)
Resend free tier is **100 emails/day, 3,000/month**, batch endpoint ≤100/call
(verified in `docs/ops/EMAIL.md`). A monthly newsletter wants **same-day**
delivery, so a list larger than ~100 recipients needs a paid Resend tier or
batched sends across a day (acceptable for a monthly digest, not for a blast).
Flag list-size growth to A13 (`SCALING_COST.md`); A8 assumes A6 handles batching,
retries, and throttling.

---

## 6. Metrics (per edition and per advertiser slot)

All analytics are first-party in Postgres via **A4** (`analytics_events`). A8
emits:

| event | props | fired by |
| --- | --- | --- |
| `newsletter_open`  | `edition_id`, `region` | tracking pixel (§5.4) |
| `newsletter_click` | `edition_id`, `block_id`, `featured_placement_id?`, `url` | redirect endpoint |
| (delivered/bounced/complained) | from `newsletter_sends.status` | A6 webhooks |

Derived, aggregate-only reports:

- **Per edition** (admin, A11): delivered, unique opens (with the MPP caveat),
  total/unique clicks, unsubscribes, complaints, top-clicked blocks.
- **Per advertiser slot** (advertiser, A10 — **aggregate only**, never per-user):
  - *impressions* = delivered sends of the edition (each recipient = one exposure
    of every embedded slot),
  - *opens* = edition opens (soft proxy),
  - *clicks* = `newsletter_click` where `featured_placement_id = theirs` — the
    real performance signal, and what proves the slot's value at renewal.

Advertisers see counts only; raw recipients/locations stay admin-only under RLS
(shared contract §Admin-only CRM). Report rendering lives in A10/A11; A8 defines
the events and the join keys (`edition_id`, `featured_placement_id`).

---

## 7. Defaults & open questions

| Knob | Default | Owner to confirm |
| --- | --- | --- |
| Cadence | monthly / region | A8 (this doc) |
| Sponsored slots per edition per region | 3 | A9 (pricing pressure) |
| Editorial:sponsored ratio | editorial majority (~6–10 : ≤3) | A8 |
| Cap contribution per edition | 1 promotional send | A5 |
| Unsubscribe granularity | one-click = newsletter-only; landing page = also all-marketing | A8 (decided) |
| Region assignment | most-recent `user_locations.ip_region`, else national | A3 |
| Open tracking trust | low (Apple MPP); lead with clicks | A4 |

**Requests consolidated for A2:** (1) `newsletter_editions` + `newsletter_sends`
tables as sketched; (2) `'newsletter'` added to `featured_placements.surface`;
(3) nullable `featured_placements.newsletter_edition_id`; (4)
`user_consents.newsletter_opt_out bool default false`; (5) a `promotional_sends`
union view so the frequency cap (A5) counts blasts + newsletters together.

**Deferred by design:** slot pricing → A9; exact "Sponsored" wording + physical
address string + GPC handling → A1; Resend batching/throttling/webhooks + final
template HTML → A6; console UIs → A10/A11; region derivation → A3.
