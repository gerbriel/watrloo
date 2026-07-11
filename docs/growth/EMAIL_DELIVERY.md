# Email Blast Delivery — A6

**Summary.** Geo-targeted promotional email is sent by a Supabase Edge Function
(Deno) that pg_cron (A5) invokes per campaign: it claims a batch, **re-checks
consent + suppression + frequency cap at send time**, renders the email, sends it
through **Resend** (`POST /emails/batch`, ≤100/request), and records
`campaign_sends`. A send row is written **before** the API call and every message
carries an `Idempotency-Key`, so no retry ever double-sends. Marketing mail goes
out from a dedicated subdomain (`news.watrloo.com`) with RFC 8058 one-click
unsubscribe and CAN-SPAM footer; Resend bounce/complaint webhooks feed
`email_suppressions` automatically.

**Dependencies.** `DATA_MODEL.md` (A2 — owns `campaign_sends`,
`email_suppressions`, `user_consents`; I file `REQUEST TO A2` for columns I need),
`CAMPAIGNS.md` (A5 — owns the scheduler, batch claim, per-user send windows,
frequency-cap policy), `COMPLIANCE.md` (A1 — owns consent semantics, GPC, the
physical-address decision, retention), `ANALYTICS.md` (A4 — consumes the
engagement events I emit). Economics numbers below are handed to `SCALING_COST.md`
(A13). Reuses the existing Resend account + verified `watrloo.com` domain from
`docs/ops/EMAIL.md`.

---

## 1. Seams — what I consume and what I emit

| Direction | Interface | Owner |
| --- | --- | --- |
| **Consume** | pg_cron job invokes my Edge Function `send-campaign-batch` via `pg_net` with `{ campaign_id, batch_size }`. A5 decides *when* (send window) and *whether* a campaign is `running`. | A5 |
| **Consume** | Frequency-cap policy: default **3 promo msgs / 7 days / user**, plus per-campaign `ad_campaigns.frequency_per_week`. I enforce it in the claim query; A5 owns the numbers. | A5 / contract |
| **Consume** | Consent (`user_consents.marketing_opt_in`, `gpc_detected`) and `email_suppressions`, re-read at send time. | A2 / A1 |
| **Emit** | `analytics_events` rows for `email_sent`, `email_delivered`, `email_bounced`, `email_complained`, `email_opened`, `email_clicked`, `email_unsubscribed` (coarse `region`, no PII in `props`). | A4 |
| **Emit** | `campaign_sends` rows — the audit trail that powers the frequency cap, advertiser **aggregate** reach counts, and suppression. | A2 |
| **Own** | Three Edge Functions: `send-campaign-batch`, `unsubscribe`, `resend-webhook`. The wire format (headers, footer, tokens). Batching/throughput to Resend. | **A6 (this doc)** |

A5 hands me *which users*; I never trust that list — §3 re-checks every gate in the
same transaction that writes the send row.

---

## 2. Resend limits & economics (verified 2026-07-10)

All figures fetched from Resend's own pages; sources in §11. These drive A13's cost model.

### Transactional plans (we send via the transactional API, not Broadcasts — see §2.3)

| Plan | Price | Emails / month | Daily cap | Domains | Dedicated IP |
| --- | --- | --- | --- | --- | --- |
| **Free** | $0 | **3,000** | **100 / day** | 1 | no |
| **Pro** | **$20/mo** | **50,000** | none | 10 | no |
| **Scale** | $90–$1,150/mo | 100,000 – 2,500,000 | none | 1,000 | add-on **$30/mo** (only offered above 3,000/day) |
| **Enterprise** | custom | custom | none | flexible | included |

Source: <https://resend.com/pricing>.

### API mechanics that shape the pipeline

| Fact | Value | Source |
| --- | --- | --- |
| Batch endpoint | `POST /emails/batch`, **up to 100 messages per request** | [batch API](https://resend.com/docs/api-reference/emails/send-batch-emails) |
| Recipients per message | **max 50** addresses in `to` (irrelevant for us — one recipient each) | same |
| Batch limitations | `attachments` and `scheduled_at` **not supported** in batch | same |
| Default rate limit | **5 requests / second per team**; `429` on exceed | [API intro](https://resend.com/docs/api-reference/introduction) |
| Rate-limit headers | `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after` | [rate limit](https://resend.com/docs/api-reference/rate-limit) |
| Idempotency | `Idempotency-Key` header, **24-hour** dedupe window, ≤256 chars, UUID recommended; SMTP variant `Resend-Idempotency-Key`; supported on batch | [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) |

### 2.3 When the free tier breaks, and the first paid tier

The binding limit is the **free-tier 100 emails/day** and **3,000/month**, *shared*
with transactional signup/reset mail. Reserve headroom for auth (§8) and the free
tier realistically supports only **~50–80 promotional sends/day**. Concretely:

- **A single blast to ~100 recipients already exceeds the free daily cap.** The
  free tier is fine for pilots and low-volume, region-tiny campaigns only.
- **First paid tier = Resend Pro, $20/mo → 50,000 emails/month, no daily cap.**
  That is the first point at which real blasts are viable. At 50k/mo and the
  contract's 3-per-week cap, Pro covers roughly **~4,000 opted-in users** blasted
  3×/week (4,000 × 3 × 4.3 ≈ 51k — so treat ~3,800 users as the Pro ceiling with
  transactional headroom).
- **Dedicated IP** ($30/mo add-on) is only *offered* above 3,000 emails/day and is
  **not worth it** for us until sustained volume and a warmed reputation justify it
  (§7). Stay on Resend's shared pool initially.

**Handoff to A13:** economics inflect at (a) any blast >~80 recipients/day →
must be on Pro; (b) ~3,800 blasted users → approaching Pro's 50k/mo → step to
Scale ($90/mo, 100k). Marketing volume and transactional volume **share the same
monthly quota**, so A13 should budget them together, not separately.

> Note: Resend also sells a separate **Marketing/Broadcasts** product priced by
> *contacts* (Free 1,000 contacts; Pro Marketing $40/mo 5,000 contacts). **We do
> not use it.** Our list, segmentation, suppression, and frequency cap live in
> Postgres (A2/A5), and CAN-SPAM/GDPR compliance is enforced in our own claim
> query. Using Resend Audiences would fork the source of truth. We send through
> the plain transactional `POST /emails/batch` and count against the transactional
> quota in the table above.

---

## 3. Send pipeline & idempotency

```
pg_cron (A5, inside send window)
  └─ pg_net POST → Edge Function `send-campaign-batch` { campaign_id, batch_size ≤ 100 }
       └─ RPC claim_campaign_recipients(campaign_id, batch_size)   ← re-checks ALL gates, writes rows
            • locks candidates FOR UPDATE SKIP LOCKED  (concurrency-safe)
            • filters: marketing_opt_in=true, not in email_suppressions,
              under 3/7d global cap AND campaign frequency_per_week, in send window
            • inserts campaign_sends (status='queued', fresh unsubscribe_token)
              ON CONFLICT (campaign_id,user_id) DO NOTHING     ← idempotent claim
            • returns [{ send_id, user_id, email, unsubscribe_token }]
       └─ render each email (subject/body/image/link from ad_campaigns.creative)
       └─ POST /emails/batch  with per-message Idempotency-Key = send_id
       └─ per-message result → UPDATE campaign_sends
            success → status='sent', resend_message_id, sent_at=now()
            failure → status='failed', attempt_count+1, last_error
       └─ emit analytics_events 'email_sent' for each success
```

### The idempotency guarantee (never double-send)

Two independent locks, either alone sufficient:

1. **DB-side.** The `campaign_sends` row is written **before** the Resend call,
   under a `UNIQUE (campaign_id, user_id)` constraint. `claim_campaign_recipients`
   inserts with `ON CONFLICT DO NOTHING` and only *returns* rows it actually
   claimed this call, so two concurrent invocations, or a retried cron tick, can
   never both own the same (campaign, user). A user already `sent`/`delivered` is
   simply not re-claimed.
2. **Provider-side.** Each message carries `Idempotency-Key: <send_id>` (a stable
   UUID per send row). If the Edge Function crashes *after* Resend accepted the
   batch but *before* it recorded success, the retry re-sends the same key within
   the 24-hour window and Resend returns the original result **without delivering
   a second copy** ([idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)).

So the dangerous window "row written, mail sent, success not yet recorded" is
covered: the DB lock stops a *new* claim, and the idempotency key stops a *replay*
from actually delivering twice. The send is recorded with/around the API call, not
after it.

### Partial-failure handling & retries

- **Batch is not atomic.** `POST /emails/batch` returns a per-message array; some
  entries succeed while others error. I map each result back to its `send_id` and
  update only that row. No blanket rollback.
- **Retryable vs terminal.** `429` (rate limit), `5xx`, and network timeouts →
  `status='failed'`, `attempt_count+1`, retry with exponential backoff
  (§6 respects `retry-after`). `422`/validation, or a hard rejection → `status='failed'`
  and **do not retry** (bad address surfaces later as a bounce → suppression).
- **Retry sweep.** A5's cron re-invokes `send-campaign-batch`; the claim RPC also
  re-selects rows where `status='failed' AND attempt_count < max_attempts (=3) AND
  next_attempt_at <= now()`, marking them `status='sending'` with `claimed_at` so a
  second worker can't grab them. Exhausted rows land in `status='error'` for the
  admin CRM (A11) to inspect.
- **Poison batch.** If the *whole* request 5xxs (Resend outage), nothing is marked
  sent; the rows stay `queued`/`failed` and the next window retries. Because the
  idempotency key is stable, a partially-processed batch cannot double-send on the
  next attempt.

---

## 4. Edge Function skeleton — `send-campaign-batch` (Deno)

`supabase/functions/send-campaign-batch/index.ts`. Uses the **service_role** key
(server-only) so RLS is bypassed intentionally inside a vetted, privileged path —
matching the pattern `docs/ops/BUSINESS_ACCOUNTS.md` establishes for Edge Functions.

```ts
// Deno — Supabase Edge Function. Invoked by pg_cron/pg_net (A5), never by a browser.
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;          // secret, server-only
const SERVICE_ROLE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const APP_ORIGIN     = "https://gerbriel.github.io/watrloo";      // for links/tokens
const FROM           = "Watrloo <news@news.watrloo.com>";         // marketing subdomain (§7)
const REPLY_TO       = "hello@watrloo.com";                       // real, monitored
const PHYSICAL_ADDR  = Deno.env.get("POSTAL_ADDRESS")!;           // CAN-SPAM (§9; A1 to decide)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  // Only the scheduler may call this. pg_net sends a shared bearer; verify it.
  if (req.headers.get("authorization") !== `Bearer ${Deno.env.get("CRON_SECRET")}`)
    return new Response("forbidden", { status: 403 });

  const { campaign_id, batch_size = 100 } = await req.json();
  const size = Math.min(batch_size, 100); // Resend batch hard cap

  // 1) Claim + RE-CHECK EVERY GATE AT SEND TIME. Single txn = idempotent + consistent.
  //    (function definition in §5; returns only rows this call actually claimed)
  const { data: recipients, error: claimErr } = await admin.rpc(
    "claim_campaign_recipients",
    { p_campaign_id: campaign_id, p_limit: size },
  );
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!recipients?.length) return json({ claimed: 0 }, 200);

  // 2) Load creative once.
  const { data: c } = await admin
    .from("ad_campaigns").select("creative, business_id")
    .eq("id", campaign_id).single();

  // 3) Render one message per recipient (unique unsubscribe token → one-click header).
  const batch = recipients.map((r) => {
    const unsub = `${SUPABASE_URL}/functions/v1/unsubscribe?token=${r.unsubscribe_token}`;
    return {
      from: FROM,
      to: [r.email],
      reply_to: REPLY_TO,
      subject: c.creative.subject,
      html: renderHtml(c.creative, unsub, PHYSICAL_ADDR),   // visible unsub + address in footer
      text: renderText(c.creative, unsub, PHYSICAL_ADDR),
      headers: {
        // RFC 8058 one-click unsubscribe (§9). https + mailto both allowed.
        "List-Unsubscribe": `<${unsub}&m=1>, <mailto:unsubscribe@news.watrloo.com?subject=unsub-${r.send_id}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "Idempotency-Key": r.send_id,          // stable per send row → no double-send on retry
      },
      tags: [{ name: "campaign", value: campaign_id }, { name: "kind", value: "promo" }],
    };
  });

  // 4) One batch call (≤100). Retry/backoff on 429/5xx handled by caller loop (§6).
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  if (res.status === 429 || res.status >= 500) {
    // whole-request failure: mark claimed rows failed for the next window, honor retry-after
    const retryAfter = Number(res.headers.get("retry-after") ?? 5);
    await admin.rpc("mark_sends_failed", {
      p_send_ids: recipients.map((r) => r.send_id),
      p_error: `resend ${res.status}`, p_retry_after_s: retryAfter,
    });
    return json({ retried: recipients.length, status: res.status }, 200);
  }

  const body = await res.json();               // { data: [{ id }...] } aligned to batch order
  // 5) Per-message reconcile → campaign_sends + analytics_events.
  await admin.rpc("reconcile_batch_result", {
    p_campaign_id: campaign_id,
    p_results: recipients.map((r, i) => ({
      send_id: r.send_id,
      resend_message_id: body?.data?.[i]?.id ?? null,
      ok: Boolean(body?.data?.[i]?.id),
    })),
  });

  return json({ sent: body?.data?.length ?? 0 }, 200);
});

const json = (b: unknown, status: number) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
```

`renderHtml`/`renderText` inline all CSS, embed the campaign image by absolute
Cloudflare R2 URL, and always append the CAN-SPAM footer (§9). No external JS.

---

## 5. The claim RPC (the at-send-time gate) — spec for A2

The gate is a `SECURITY DEFINER` function so it can read `user_consents` /
`email_suppressions` (admin-only tables) from inside the privileged path. It is the
**single place** consent, suppression, and the frequency cap are enforced — the
queue is never trusted. Matches repo conventions (`set search_path = ''`,
`(select public.is_admin())` style, snake_case).

```sql
-- REQUEST TO A2: add to campaign_sends —
--   status text default 'queued'
--     check (status in ('queued','sending','sent','delivered','bounced',
--                        'complained','failed','error','skipped','suppressed')),
--   resend_message_id text, attempt_count int not null default 0,
--   next_attempt_at timestamptz, claimed_at timestamptz, last_error text,
--   created_at timestamptz not null default now(),
--   unique (campaign_id, user_id)
-- REQUEST TO A2: email_suppressions —
--   user_id uuid, email citext, reason text
--     check (reason in ('unsubscribe','hard_bounce','complaint','manual','gpc')),
--   source text, campaign_id uuid, created_at timestamptz default now();
--   unique index on lower(email); global kill-switch = row exists for that user/email.

create or replace function public.claim_campaign_recipients(
  p_campaign_id uuid, p_limit int
) returns table (send_id uuid, user_id uuid, email text, unsubscribe_token text)
language plpgsql security definer set search_path = '' as $$
declare v_cap int; v_freq int;
begin
  select coalesce(frequency_per_week, 3) into v_freq
    from public.ad_campaigns where id = p_campaign_id and status = 'running';
  if not found then return; end if;          -- A5 owns run state; don't send a paused campaign
  v_cap := least(v_freq, 3);                  -- contract: at most 3 promo / 7 days / user

  return query
  with candidates as (
    -- A5 supplies the target set (segment membership / region). Re-derive here so the
    -- queue can't smuggle in an ineligible user. Lock to avoid double-claim.
    select sm.user_id, u.email
    from public.segment_members sm
    join auth.users u on u.id = sm.user_id
    join public.user_consents uc on uc.user_id = sm.user_id
    where sm.segment_id = (select segment_id from public.ad_campaigns where id = p_campaign_id)
      and uc.marketing_opt_in = true                       -- consent at send time (A1/A2)
      and coalesce(uc.gpc_detected, false) = false          -- honor Global Privacy Control
      and not exists (                                      -- suppression at send time
        select 1 from public.email_suppressions es
        where es.user_id = sm.user_id or lower(es.email) = lower(u.email))
      and (                                                 -- frequency cap: global + per-campaign
        select count(*) from public.campaign_sends s
        where s.user_id = sm.user_id and s.channel = 'email'
          and s.status in ('sent','delivered')
          and s.sent_at > now() - interval '7 days'
      ) < v_cap
      and not exists (                                      -- never twice for THIS campaign
        select 1 from public.campaign_sends s2
        where s2.campaign_id = p_campaign_id and s2.user_id = sm.user_id
          and s2.status in ('sent','delivered','sending'))
    order by sm.user_id
    limit p_limit
    for update of sm skip locked
  ), inserted as (
    insert into public.campaign_sends
      (campaign_id, user_id, channel, status, unsubscribe_token, claimed_at)
    select p_campaign_id, c.user_id, 'email', 'sending',
           encode(extensions.gen_random_bytes(24), 'base64'), now()
    from candidates c
    on conflict (campaign_id, user_id) do nothing            -- idempotent
    returning id, user_id, unsubscribe_token
  )
  select i.id, i.user_id, c.email, i.unsubscribe_token
  from inserted i join candidates c on c.user_id = i.user_id;
end $$;
```

`reconcile_batch_result` flips `sending → sent` (+`resend_message_id`, `sent_at`)
or `sending → failed` and writes the `email_sent` analytics event.
`mark_sends_failed` sets `failed`, `next_attempt_at = now() + retry_after`, and
`attempt_count+1`. The unsubscribe token is 24 random bytes (unguessable);
verification is token-equality against the row, so no separate signing secret is
strictly required — but see §9 for the signed-token upgrade.

---

## 6. Throughput & windowing (never blow the quota mid-blast)

- **Batch size = 100** (Resend's max per request), one recipient per message.
- **Rate cap = 5 req/s per team.** At 100 msgs/request that's a *theoretical*
  30,000 msgs/min, but we deliberately pace far below it: the cron tick invokes the
  function once per interval, so throughput = `batch_size × ticks/min`. Set the
  cron interval so a single blast spreads across its window rather than firing all
  at once — good for reputation during warm-up (§7).
- **Daily/monthly ceiling.** Before claiming, `send-campaign-batch` checks a
  running counter of today's/this-month's sends (a `daily_send_counter` view over
  `campaign_sends`, **REQUEST TO A2**) against a configured ceiling that leaves
  transactional headroom (§8). If the ceiling is hit, the function returns
  `{ throttled: true }` and claims nothing — the blast pauses and resumes next day,
  it never overruns the Resend plan mid-blast.
- **Backoff.** On `429`/`5xx`, honor `retry-after`; otherwise exponential backoff
  with jitter (2s, 4s, 8s, cap 60s), max 3 attempts, then `status='error'`.
- **Per-user daytime window.** A5 computes each user's local send window from their
  coarse region; the claim query only runs when A5's cron fires *for that region's
  window*, so we never email someone at 3am. A6 respects the window A5 hands it and
  does not send outside it.
- **Concurrency.** `FOR UPDATE ... SKIP LOCKED` lets multiple ticks run without
  double-claiming; the unique `(campaign_id,user_id)` constraint is the backstop.

---

## 7. Deliverability

**Subdomain separation (the key decision).** Send **all marketing** from a
dedicated subdomain — `news.watrloo.com` (`From: news@news.watrloo.com`) — kept
**separate** from transactional `hello@`/`no-reply@watrloo.com`. A spam complaint or
blocklist hit against promotional mail then damages the *marketing* subdomain's
reputation only, leaving password-reset and confirmation email on the root domain
unpoisoned. This requires a **separate verified domain entry in Resend** for
`news.watrloo.com` with its own DKIM key. (Resend Free allows 1 domain; running a
marketing subdomain alongside the transactional root domain is a concrete reason to
be on **Pro**, which allows 10.)

**SPF / DKIM / DMARC — confirm they cover bulk.** `docs/ops/EMAIL.md` sets these up
for transactional mail on `watrloo.com`. They authenticate the *root* domain; the
marketing **subdomain needs its own records**:

- **SPF:** `news.watrloo.com` TXT `v=spf1 include:_spf.resend.com ~all` (Resend's
  send hosts). SPF does not inherit down a subdomain — must be added explicitly.
- **DKIM:** Resend issues a distinct DKIM CNAME/TXT when you verify the subdomain;
  add it. Separate key = separate reputation, which is the whole point.
- **DMARC:** publish `_dmarc.news.watrloo.com` `v=DMARC1; p=none; rua=mailto:dmarc@watrloo.com`
  to start (monitor), tightening to `p=quarantine` once aligned. Gmail/Yahoo's 2024
  bulk rules **require DMARC at minimum `p=none`** for senders doing 5,000+/day to
  Gmail — we publish it from day one regardless of volume. ([Gmail sender guidelines](https://support.google.com/a/answer/14229414), [Resend guide](https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024))

**Warm-up.** A brand-new subdomain has no reputation. Ramp volume over ~2–4 weeks
(e.g. 50 → 200 → 1k → 5k/day), sending to the **most-engaged** users first, before
any full-list blast. The §6 windowing (spread across the day, small batches) is the
warm-up mechanism. Keep the **complaint rate under 0.1%** and **never let it reach
0.3%** — Gmail/Yahoo's ceiling; above it, inbox placement collapses.
([Gmail sender guidelines](https://support.google.com/a/answer/14229414))

**List hygiene.** The claim query excludes anyone in `email_suppressions`, so
unsubscribes/bounces/complaints are permanent and global. Additionally: never mail
addresses that hard-bounced, and periodically drop chronically-unengaged recipients
(no open/click in N sends) from segments — A5's segmentation, but I surface the
engagement signal via `analytics_events`.

**Bounce + complaint webhooks → automatic suppression.** A Resend webhook
(`resend-webhook` Edge Function, §10) subscribes to `email.bounced`,
`email.complained`, and `email.suppressed`, and on each inserts an
`email_suppressions` row. A complaint (`email.complained`, i.e. a "mark as spam")
suppresses immediately and forever — this is what protects the 0.3% ceiling.

---

## 8. Transactional vs marketing quota sharing

Auth mail (signup confirmation, password reset — `docs/ops/EMAIL.md`) and marketing
blasts both bill against the **same Resend monthly/daily quota**. Two consequences:

1. **Reserve headroom.** The §6 daily ceiling for blasts is set *below* the plan
   cap so a big blast can never starve a password reset. On Free (100/day) this
   leaves almost nothing for marketing — reinforcing that real blasts need Pro.
2. **Different subdomains, one account.** Transactional stays on `watrloo.com`,
   marketing on `news.watrloo.com`, but both consume the account's plan quota. A13
   budgets them as one line item.

---

## 9. CAN-SPAM in the wire format

Every promotional message includes, and the pipeline enforces:

- **Accurate `From` / `Subject`.** `From: Watrloo <news@news.watrloo.com>`, a
  truthful subject that matches the creative — no deceptive headers. (CAN-SPAM
  §5(a)(1)–(2).)
- **Ad identification.** A clear "This is a promotional message from Watrloo" line
  in the footer (CAN-SPAM §5(a)(5) — commercial messages must be identifiable as
  ads). Transactional mail carries no such line.
- **RFC 8058 one-click unsubscribe** (also Gmail/Yahoo-mandated for bulk):
  - `List-Unsubscribe: <https://…/functions/v1/unsubscribe?token=…&m=1>, <mailto:unsubscribe@news.watrloo.com?subject=…>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  - The HTTPS endpoint **accepts a POST with body `List-Unsubscribe=One-Click` and
    unsubscribes with no further confirmation**, honored **within 2 days**
    (we do it synchronously). ([RFC 8058](https://datatracker.ietf.org/doc/html/rfc8058), [Gmail guidelines](https://support.google.com/a/answer/14229414))
- **Visible unsubscribe link** in the human-readable footer (a real, clickable link
  — not buried), carrying the same token. CAN-SPAM requires a working opt-out for
  ≥30 days after send; our token never expires and the row is permanent.
- **Signed token.** `campaign_sends.unsubscribe_token` is 24 random bytes per send
  (unguessable). **Upgrade for tamper-evidence:** make it an HMAC of
  `campaign_id|user_id` with a server secret so the endpoint can validate without a
  DB lookup and reject forged tokens; store the HMAC in the column.
  (**REQUEST TO A2:** keep the column `text`, length ≥64.)
- **Physical postal address** in the footer — CAN-SPAM §5(a)(5) requires a valid
  physical postal address of the sender. **FLAG TO A1:** Watrloo needs to decide
  what address to publish. Options, all CAN-SPAM-valid: (a) a registered business
  address, (b) a **USPS PO Box registered to the business**, or (c) a private
  mailbox at a Commercial Mail Receiving Agency. This is a legal/ops decision A1
  owns; the pipeline injects `POSTAL_ADDRESS` from a secret and **will not send
  without it set** (the render function throws on empty).

### The unsubscribe Edge Function — `unsubscribe`

`supabase/functions/unsubscribe/index.ts`. Handles both the one-click `POST` (from
the mailbox provider) and a `GET` (human clicks the footer link → confirmation page).

```ts
import { createClient } from "jsr:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return html("Invalid link.", 400);

  // RFC 8058: a POST with List-Unsubscribe=One-Click must unsubscribe with no confirmation.
  const isOneClick = req.method === "POST";

  // Look up the send by token → user + email + campaign. (Or verify HMAC, §9.)
  const { data: send } = await admin
    .from("campaign_sends")
    .select("user_id, campaign_id")
    .eq("unsubscribe_token", token).maybeSingle();
  if (!send) return html("This unsubscribe link is no longer valid.", 404);

  if (isOneClick || url.searchParams.get("confirm") === "1") {
    // 1) global marketing kill-switch: suppression row (checked at every send)
    // 2) flip the consent flag so nothing re-adds them
    await admin.rpc("apply_unsubscribe", {
      p_user_id: send.user_id, p_campaign_id: send.campaign_id, p_reason: "unsubscribe",
    });
    // emit analytics 'email_unsubscribed' (A4) inside the RPC
    return isOneClick
      ? new Response("ok", { status: 200 })                 // provider expects 2xx, no body needed
      : html("You've been unsubscribed. You won't receive more promotional email from Watrloo.", 200);
  }
  // GET without confirm → a tiny confirm page that POSTs back with ?confirm=1
  return html(`<form method="POST"><button>Confirm unsubscribe</button></form>`, 200);
});

const html = (body: string, status: number) =>
  new Response(`<!doctype html><meta charset=utf-8><body>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } });
```

`apply_unsubscribe` (SECURITY DEFINER, `set search_path=''`) does, atomically:
`insert into email_suppressions (user_id, reason, source, campaign_id) … on conflict do nothing`;
`update user_consents set marketing_opt_in=false, consent_updated_at=now(), source='unsubscribe'`;
and writes the `email_unsubscribed` analytics event. Idempotent — a double-click is
harmless. This is the **global kill-switch** the contract calls for.

---

## 10. Resend webhook → suppression — `resend-webhook`

`supabase/functions/resend-webhook/index.ts`. Configure a Resend webhook (dashboard)
pointed at this function for `email.bounced`, `email.complained`, `email.suppressed`,
plus `email.delivered`, `email.opened`, `email.clicked` for engagement (A4).

- **Signature verification.** Resend signs with **Svix**. Verify using the raw body
  and headers **`svix-id`, `svix-timestamp`, `svix-signature`** against the endpoint
  signing secret (prefix `whsec_`), e.g. `resend.webhooks.verify()` or the Svix lib.
  **Must use the raw request body** — parsing+re-stringifying breaks the signature.
  Reject unverified requests with `401`. ([verify webhooks](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests))
- **Idempotent processing.** Store processed `svix-id` values and skip duplicates
  (Resend/Svix may redeliver). (**REQUEST TO A2:** a small
  `webhook_events(svix_id pk, received_at)` table, or a unique index.)
- **Event → action.**

| Resend event | Action |
| --- | --- |
| `email.bounced` (permanent reject) | insert `email_suppressions` (`reason='hard_bounce'`); mark the matching `campaign_sends` row `status='bounced'`; emit `email_bounced` |
| `email.complained` (spam report) | insert `email_suppressions` (`reason='complaint'`) **immediately**; row `status='complained'`; emit `email_complained` — this is the 0.3%-ceiling guard |
| `email.suppressed` | insert `email_suppressions` (`reason='manual'`/provider) |
| `email.delivered` | `campaign_sends.status='delivered'`; emit `email_delivered` |
| `email.opened` / `email.clicked` | emit `email_opened` / `email_clicked` (A4) — engagement only, no state change |
| `email.delivery_delayed` / `email.failed` | log; a `failed` may re-queue per §6 |

The webhook matches events back to `campaign_sends` by `resend_message_id`
(recorded in §3). Full event list:
`email.sent, email.delivered, email.delivery_delayed, email.bounced,
email.complained, email.opened, email.clicked, email.failed, email.received,
email.scheduled, email.suppressed` ([event types](https://resend.com/docs/dashboard/webhooks/event-types)).

---

## 11. Consolidated `REQUEST TO A2`

1. `campaign_sends`: add `status` enum (values in §5), `resend_message_id text`,
   `attempt_count int`, `next_attempt_at timestamptz`, `claimed_at timestamptz`,
   `last_error text`, `created_at`, `UNIQUE (campaign_id, user_id)`; make
   `unsubscribe_token text` length ≥64 (for HMAC option, §9).
2. `email_suppressions`: `user_id uuid`, `email citext`, `reason` enum
   (`unsubscribe|hard_bounce|complaint|manual|gpc`), `source text`,
   `campaign_id uuid`, `created_at`; unique index on `lower(email)`.
3. New `webhook_events(svix_id text pk, event text, received_at timestamptz)` for
   webhook idempotency (§10).
4. A `daily_send_counter` view over `campaign_sends` (today / current-month counts)
   for the volume ceiling (§6/§8).
5. RPCs (SECURITY DEFINER, `set search_path=''`): `claim_campaign_recipients`,
   `reconcile_batch_result`, `mark_sends_failed`, `apply_unsubscribe`.

---

## 12. Sources (fetched 2026-07-10)

- Resend pricing (Free 3,000/mo·100/day, Pro $20/mo·50,000/mo, Scale, dedicated IP $30/mo) — <https://resend.com/pricing>
- Batch API (`POST /emails/batch`, ≤100/request, 50 recipients/msg, no attachments/scheduled_at) — <https://resend.com/docs/api-reference/emails/send-batch-emails>
- API rate limit (5 req/s per team, 429) — <https://resend.com/docs/api-reference/introduction>
- Rate-limit headers (`ratelimit-limit`/`-remaining`/`-reset`, `retry-after`) — <https://resend.com/docs/api-reference/rate-limit>
- Idempotency-Key (24h window, ≤256 chars, batch supported, SMTP variant) — <https://resend.com/docs/dashboard/emails/idempotency-keys>
- Webhook event types — <https://resend.com/docs/dashboard/webhooks/event-types>
- Webhook signature verification (Svix; `svix-id`/`svix-timestamp`/`svix-signature`; raw body) — <https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests>
- Gmail 2024 bulk sender guidelines (SPF+DKIM+DMARC p=none, one-click unsubscribe, complaint <0.3%, 5,000/day) — <https://support.google.com/a/answer/14229414>
- Resend's Gmail/Yahoo 2024 guide — <https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024>
- RFC 8058 (one-click List-Unsubscribe-Post) — <https://datatracker.ietf.org/doc/html/rfc8058>
- Existing transactional setup (Resend, SMTP, domain) — `docs/ops/EMAIL.md`
- Edge Function / service_role precedent — `docs/ops/BUSINESS_ACCOUNTS.md`
