# Campaign Lifecycle & Management UX — Feature Ideas

**Top picks:** Editing a `draft`/`rejected` campaign and self-serve pause/resume/cancel are the two biggest gaps — today a rejected campaign is a dead end (no way to fix the copy before resubmitting) and a live campaign is entirely out of the advertiser's hands (only admins can pause it). Shipping real start/end date pickers is a near-zero-effort unlock since `create_campaign` already accepts `p_starts_at`/`p_ends_at` — the UI just never sends them. All three are additive RPCs that copy the existing `admin_set_campaign_status`/`create_campaign` pattern (manager-gated, audited to `moderation_actions`), so none require touching the state machine itself.

*Grounded in the actual shipped code, not the aspirational `docs/growth/*` designs: `src/pages/business/Campaigns.tsx`, `src/pages/admin/AdminCampaigns.tsx`, `src/lib/api/growth.ts`, and `supabase/migrations/20260712000000_growth_phase0_featured.sql` + `20260712030000_growth_admin_controls.sql`. The real `ad_campaigns` table is much leaner than `CAMPAIGNS.md`/`DATA_MODEL.md` describe: no `frequency_per_week`, no geo/segment targeting, no `cloned_from`, no `paused_at`, in-app-only creative (no email), and `admin_set_campaign_status`/`admin_suspend_business` are the only status-mutating RPCs that exist today besides `create_campaign`/`submit_campaign`/`admin_review_campaign`. Every idea below is scoped to close a real, observed gap in that shipped surface.*

---

## 1. Edit a draft or rejected campaign before resubmitting

Today there is no `update_campaign` RPC and no edit form anywhere in `Campaigns.tsx` — `onCreate` inserts a row via `create_campaign` and the only other action `CampaignRow` exposes is "Submit for review." When `admin_review_campaign` rejects a campaign with a reason, `submit_campaign` happily accepts resubmission straight from `status='rejected'` (`v.status not in ('draft','rejected')` is the only gate) — but the advertiser has no way to actually change the title/body/link/region first, so today "fix and resubmit" is impossible; clicking the button just resends the exact same rejected copy. Add `update_campaign_draft(p_campaign_id, p_creative, p_bathroom_id, p_surface, p_region, p_starts_at, p_ends_at)`, manager-gated, restricted to `status in ('draft','rejected')` (mirrors the existing RLS `update` intent), and turn the create form into an edit-in-place form when a draft/rejected row is selected. This is the single highest-value fix in the whole flow — it's arguably closer to a bug than a missing feature.

**Effort:** M **Touches:** `supabase/migrations/*` (new RPC), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** yes

## 2. Advertiser self-serve pause / resume / cancel

`admin_set_campaign_status` is the *only* RPC that can pause, resume, or stop a campaign, and it's `is_admin()`-gated — the advertiser who owns a `running` or `paused` campaign has zero controls over it today; `Campaigns.tsx` doesn't even render a pause/stop button. That means an advertiser who wants to end a promo early (sold out, wrong dates, budget change) has to ask an admin. Add `advertiser_set_campaign_status(p_campaign_id, p_status)`, gated by `is_business_manager(business_id)` instead of `is_admin()`, restricted to the same safe subset (`running→paused`, `paused→running`, `running/paused→done`), writing the same `moderation_actions` shape as `admin_set_campaign_status` but with `detail.via='advertiser'` so the audit trail still distinguishes who acted. Surface it as Pause/Resume/Cancel buttons on `CampaignRow` exactly like `LiveAdRow` already does for admins.

**Effort:** S **Touches:** `supabase/migrations/*` (new RPC, copies `admin_set_campaign_status` shape), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** yes

## 3. Real start/end date scheduling in the campaign builder

The backend already supports scheduling — `create_campaign` takes `p_starts_at`/`p_ends_at`, and `admin_review_campaign` already branches on `now() >= coalesce(v.starts_at, now())` to decide `approved` vs `running`, defaulting a featured campaign's `ends_at` to `now() + 7 days` when unset. But `Campaigns.tsx`'s `onCreate` never collects or sends either field, so in practice every campaign is submitted with no schedule and starts immediately on approval — the `approved` (scheduled-but-not-yet-live) state is currently unreachable from the UI. Add two date/time inputs to the builder (`starts_at` optional/future-only, `ends_at` optional, `ends_at > starts_at`), with client-side validation that a start can't be in the past. This is nearly free effort for a real capability the schema and RPC already paid for.

**Effort:** S **Touches:** `src/pages/business/Campaigns.tsx` (form only — RPC already accepts both params) **Ship-first:** yes

## 4. Withdraw a pending_review campaign back to draft

Once submitted, a campaign is stuck in `pending_review` until an admin acts — there's no way to catch a typo or change your mind mid-queue (the `advertiser_withdraw_campaign` RPC described in `CAMPAIGNS.md` was never built). Add `advertiser_withdraw_campaign(p_campaign_id)`: manager-gated, `pending_review → draft`, audited (`action='withdraw_campaign'`, needs adding to the `moderation_actions` action CHECK alongside the other verbs). Once combined with idea #1's edit capability, this gives advertisers a full self-serve loop: submit → notice a mistake → withdraw → edit → resubmit, with no admin involvement until the copy is actually ready for review.

**Effort:** S **Touches:** `supabase/migrations/*` (RPC + `moderation_actions` CHECK widen), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** no

## 5. Duplicate / clone a past campaign

There is no clone RPC and no "reuse this" affordance — a business running a recurring weekend special has to retype the full title/body/link/region from scratch every time, even though `done` and `rejected` are terminal and the old row's `creative`/`target_region`/`surface`/`bathroom_id` are sitting right there. Add `advertiser_clone_campaign(p_campaign_id)`: manager-gated, copies `creative`, `bathroom_id`, `surface`, `target_region` into a fresh `draft` row (drop `starts_at`/`ends_at`/`reject_reason`/`reviewed_*` so it isn't mistaken for the old campaign's schedule), and expose a "Duplicate" button on `CampaignRow` for `done`/`rejected`/`running` items. This is also the structural fix that makes "any material change → new review" safe by construction: cloning, not in-place mutation, is how an advertiser gets a materially different campaign re-reviewed.

**Effort:** S **Touches:** `supabase/migrations/*` (new RPC), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** no

## 6. Status timeline / audit history on a campaign

Every review decision, pause, resume, stop, and suspend is already written to `moderation_actions` (with `actor_id`, `detail`, `created_at`) — but nothing in either `Campaigns.tsx` or `AdminCampaigns.tsx` ever reads it back. An advertiser whose campaign is stuck in `pending_review` for days has no visibility into anything beyond the current status chip; an admin reviewing a campaign can't see if it was rejected and resubmitted before. Add `campaign_history(p_campaign_id)` (manager-of-owning-business or admin) that reads `moderation_actions` filtered to this campaign, and a small vertical timeline in a new `CampaignDetail` view (or an expandable row). Note while building this: `submit_campaign`/`admin_review_campaign` currently write `target_type='bathroom'` with `detail->>'campaign'` holding the id, while `admin_set_campaign_status`/`admin_suspend_business` write `target_type='campaign'`/`'business'` — the read query needs to handle both shapes (or, better, normalize all campaign-related writes to `target_type='campaign', target_id=campaign_id` as a small companion fix).

**Effort:** M **Touches:** `supabase/migrations/*` (new RPC; optionally normalize `target_type` on existing campaign-audit inserts), `src/lib/api/growth.ts`, new `CampaignDetail` component **Ship-first:** no

## 7. Narrow (not widen) schedule after approval

Right now nothing about an `approved`/`running`/`paused` campaign is editable at all — not even shrinking the window. An advertiser who sold out early or wants to end a promo a day sooner has no self-service option except full cancel (idea #2), which discards the remaining paid-for run rather than just shortening it. Add `advertiser_narrow_campaign_schedule(p_campaign_id, p_starts_at, p_ends_at)`, manager-gated, that only accepts a **later** `starts_at` (delay, only while still `approved` and still future) or an **earlier** `ends_at` (shorten, from `approved`/`running`/`paused`) — reject any change that would widen the window. Because it never touches `creative`, `target_region`, `surface`, or `bathroom_id`, it needs no re-review, keeping the "admin approval stays in the loop for anything that changes what was reviewed" invariant intact while still giving advertisers real self-service.

**Effort:** M **Touches:** `supabase/migrations/*` (new RPC with narrow-only validation), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** no

## 8. Campaign list grouping, filters, and an archive view

`CampaignList`'s `campaigns?.map(...)` renders every campaign the business has ever created, in one flat, unpaginated column, oldest mixed with newest. As soon as a business runs more than a handful of campaigns this becomes a scroll-and-squint exercise, and drafts (which need action) are visually identical in weight to `done` campaigns from months ago (which don't). Group into lightweight sections — "Needs your attention" (`draft`, `rejected`), "In progress" (`pending_review`, `approved`, `running`, `paused`), and a collapsed "Archive" (`done`) — computed client-side from the existing `listCampaigns` result, no new RPC required.

**Effort:** S **Touches:** `src/pages/business/Campaigns.tsx` (render logic only) **Ship-first:** no

## 9. Structured rejection reasons for reviewers

`admin_review_campaign`'s `p_reason` is a single freeform text input in `AdminCampaigns.tsx`'s `ApprovalQueue` — every admin invents their own wording for "this link is broken" or "this looks like spam," which makes rejection reasons inconsistent and harder for advertisers to act on (and impossible to report on later). Add a small canned-reason `<select>` (deceptive / broken-or-off-platform link / low-quality creative / policy-other, etc. — reusing the vocabulary `CAMPAIGNS.md §7.2` already proposed) that pre-fills the existing free-text box, which the admin can still edit or append to. Pure client-side UX change — `reject_reason` stays a plain text column, no schema change needed.

**Effort:** S **Touches:** `src/pages/admin/AdminCampaigns.tsx` **Ship-first:** no

## 10. "Ending soon" nudge with a one-click renew

Once idea #3 makes real end dates common, a `running` campaign will eventually reach `ends_at` with no warning to the advertiser — they'll just notice their placement vanished. Add a simple client-side check in `CampaignList` (no new RPC): if a `running` campaign's `ends_at` is within, say, 3 days, show an inline "Ending soon — renew?" chip that calls the clone RPC from idea #5 to spin up a fresh draft pre-filled from the expiring one. Cheap, and it turns an otherwise-silent expiration into a natural re-engagement/repeat-purchase moment.

**Effort:** S **Touches:** `src/pages/business/Campaigns.tsx` (depends on idea #5's clone RPC existing) **Ship-first:** no

## 11. Bulk approve/reject in the admin queue

`ApprovalQueue` handles exactly one campaign at a time — fine at today's volume, but every `decide()` call is a separate round trip and a separate click. Add multi-select checkboxes to the queue and a "Approve selected" / "Reject selected (shared reason)" action that loops the *existing* `admin_review_campaign` RPC per selected id (still one `moderation_actions` row per campaign — audit granularity is preserved, this is a UI batching convenience, not a new RPC). Lower urgency than the rest of this list since it only pays off once review volume grows past a handful of campaigns a day, but cheap to build once idea #9's reason picker exists to seed the shared bulk-reject reason.

**Effort:** M **Touches:** `src/pages/admin/AdminCampaigns.tsx` **Ship-first:** no

## 12. Campaign objective tag

`ad_campaigns.creative` has no notion of *why* the campaign exists — an admin reviewing a submission and a business owner scanning their own list both have to infer intent from the ad copy alone. Add a small optional `objective` enum (e.g., `foot_traffic`, `new_listing_awareness`, `seasonal_promo`, `other`) stored either as a top-level column or a `creative.objective` key, shown as a chip in `CampaignRow`/`ApprovalQueue`. Purely descriptive — no workflow gating — but it's cheap groundwork for any future per-objective reporting and gives reviewers useful context at a glance.

**Effort:** S **Touches:** `supabase/migrations/*` (one column, or just a `creative` key — no migration needed if folded into the jsonb), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx`, `src/pages/admin/AdminCampaigns.tsx` **Ship-first:** no

## 13. Saved creative templates

A step beyond cloning a specific past campaign (idea #5): let a business save a creative as a named, reusable starting point that isn't itself a real campaign — e.g. "Weekend special" or "New location announcement" — so building a new campaign can start from a template picker instead of either a blank form or a specific past instance. Implementable as `ad_campaigns` rows with an `is_template boolean default false` flag (excluded from every list/count/entitlement query, never submittable directly — `submit_campaign` would need a guard rejecting `is_template=true`), or as a small separate `campaign_templates` table if keeping `ad_campaigns` semantics clean matters more. Real value, but templates only pay off once a business has enough campaign variety to want a library — rank behind the single-campaign clone (#5), which covers the common "run it again" case with far less machinery.

**Effort:** M **Touches:** `supabase/migrations/*` (new column or table + guard in `submit_campaign`), `src/lib/api/growth.ts`, `src/pages/business/Campaigns.tsx` **Ship-first:** no

## 14. Repeat-rejection flag for reviewers

`admin_review_campaign` and `moderation_actions` already have everything needed to compute "this business has had N campaigns rejected in the last 30 days," but nothing surfaces it. Add a small badge next to the business name in `ApprovalQueue` (e.g., "3 rejected this month") computed from a lightweight aggregate query over `moderation_actions` / `ad_campaigns`, so a reviewer immediately knows whether they're looking at a first-timer's honest mistake or a pattern worth escalating (e.g., toward `admin_suspend_business`, which already exists). Genuinely useful but sits closer to the abuse/moderation domain than core lifecycle plumbing — lowest priority here, worth revisiting once rejection volume is high enough to need it.

**Effort:** S **Touches:** `src/pages/admin/AdminCampaigns.tsx`, possibly a small read-only aggregate RPC **Ship-first:** no
