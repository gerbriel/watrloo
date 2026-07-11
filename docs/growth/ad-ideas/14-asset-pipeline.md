# Creative Asset Pipeline — Feature Ideas

Grounded in the existing review-photo path (`src/components/review/PhotoUploader.tsx`,
`src/lib/image.ts`, `src/lib/api/photos.ts`) and the `review-photos` storage policies
in `supabase/migrations/20260710000000_init.sql:225-249`, adapted for **business-scoped**
ad creatives per `docs/growth/INAPP_ADS.md`, `docs/growth/CAMPAIGNS.md`, and
`docs/growth/ADVERTISER_CONSOLE.md` (§7 already sketches a `campaign-creatives` bucket —
these ideas flesh that out rather than re-inventing it). Ads never touch `reviews`/
`review_photos`; every idea below uses its own bucket/table.

## 1. `campaign-creatives` storage bucket + business-scoped RLS

The foundational piece everything else sits on. Mirror the `review-photos` bucket exactly
(`supabase/migrations/20260710000000_init.sql:225-249`) but swap the per-user-uid folder
check for a per-business folder check against `is_business_manager(business_id)` (already
defined in `20260711000000_business_accounts.sql:117-126`): path convention
`campaign-creatives/{business_id}/{uuid}.{ext}`, public read (creatives must render
without auth), insert/delete restricted to owners/managers of that `business_id` — staff
role excluded per `ADVERTISER_CONSOLE.md`'s "staff can't upload" rule. This is exactly
`ADVERTISER_CONSOLE.md:751-758`'s option (a), made concrete as a migration.
**Effort:** M. **Touches:** new `supabase/migrations/*_campaign_creatives_bucket.sql`,
`docs/growth/DATA_MODEL.md` (bucket + policy block near the review-photos one).
**Ship-first:** yes.

## 2. `uploadAdCreative` / `deleteAdCreative` API with correct delete ordering baked in

A direct port of `src/lib/api/photos.ts`'s two functions, business-scoped. `uploadAdCreative`
uploads to the bucket first, then inserts/updates the pointer row, and rolls back the
storage object if the row write fails (mirrors `uploadReviewPhoto`'s
`supabase.storage.remove()` cleanup on insert error). `deleteAdCreative` removes the
**storage object before the row** — the same ordering lesson documented at
`docs/ops/AVAILABILITY.md:241-246` and `src/lib/api/photos.ts:52-59` ("object first, row
second... the reverse order strands the bytes with nothing pointing at them"). Getting
this right on day one avoids re-discovering F9 for a second bucket.
**Effort:** S. **Touches:** new `src/lib/api/adCreatives.ts`, reuses `STORAGE_BUCKET`-style
constant pattern from `src/types/db.ts`. **Ship-first:** yes.

## 3. Admin approval gate wired into `admin_review_campaign`

Hard constraint: creatives must be approved before public display. `CAMPAIGNS.md:106-123`
already freezes `ad_campaigns.creative` at `pending_review → approved`, but that's a
copy/link freeze, not an image-specific check. Add a pre-condition to `admin_review_campaign`
(`DATA_MODEL.md:1201`) that `approve=true` fails closed unless every `image_url` in
`creative` resolves to an object actually inside `campaign-creatives/{business_id}/...` for
*this* business (prevents an advertiser pointing `creative.image_url` at an arbitrary
external or another business's URL to bypass review). Surface the pending image inline in
the A11 admin review queue (`ADMIN_CRM.md`) next to copy/link, not as a separate checklist.
**Effort:** M. **Touches:** `admin_review_campaign` RPC, `docs/growth/CAMPAIGNS.md` §7,
`docs/growth/ADMIN_CRM.md` review-queue rendering. **Ship-first:** yes.

## 4. `CreativeUploader` component (single-image, aspect-aware)

Port `PhotoUploader.tsx`'s UX (drop zone, spinner, per-file error copy, `sr-only` input,
remove button) down from "up to 6 photos" to **exactly one** image per creative slot, since
`ADVERTISER_CONSOLE.md:519-523` already calls for reusing `compressImage` +
`MAX_UPLOAD_BYTES` + `ACCEPTED_TYPES` in the `CreativeEditor`. Adds an aspect-ratio guide
overlay (browse: none needed — `FeaturedCard` has no image slot per `INAPP_ADS.md` §2.1;
detail/email banner: 2:1; logo: 1:1) so the advertiser sees the crop before upload instead
of after rejection.
**Effort:** M. **Touches:** new `src/components/ads/CreativeUploader.tsx`, `ADVERTISER_CONSOLE.md`
§`CreativeEditor` (already stubs this at line 519).

## 5. Per-placement dimension presets in `image.ts`

`compressImage()` today has one policy: fit inside `MAX_EDGE=1600`, no fixed aspect —
correct for organic photos of variable shape, wrong for ad creatives that must render
identically at a fixed slot size. Add a parallel `compressAdCreative(file, preset)` that
takes a named preset (`{ width, height, kind: 'cover' | 'contain' }`) for `logo` (400×400),
`detail-banner` (1200×600), and `email-banner` (1200×600, reusing the same asset per
`ADVERTISER_CONSOLE.md:236`'s email-image note) — canvas-crop to the target box before the
existing WebP/quality/EXIF-strip logic, so every surface gets a consistent, non-squished
image instead of ad-hoc CSS `object-fit` papering over mismatched source dimensions.
**Effort:** S/M. **Touches:** `src/lib/image.ts` (additive export, `compressImage` untouched
for review photos).

## 6. Orphan sweep for the `campaign-creatives` bucket

Even with correct ordering (#2), crashes mid-sequence and abandoned drafts (advertiser
uploads, then never submits, then deletes the draft campaign) will still leak bytes —
exactly the class of bug documented as F9 in `docs/ops/AVAILABILITY.md:230-277`. Reuse
**Fix B** verbatim (scheduled `storage.objects` vs. pointer-table diff, delete via the
Storage API, not SQL — Fix A is explicitly rejected there because
`storage.protect_delete()` rejects SQL-level deletes). Extend the anti-join to include
`campaign-creatives` alongside `review-photos` in the same cron/Action.
**Effort:** S. **Touches:** whatever job implements `AVAILABILITY.md` Fix B (GitHub Actions
cron + service_role key), add a second bucket to its query.

## 7. Never upsert — mint a new path per creative version

`uploadReviewPhoto` already uses `upsert: false`; carry that forward but call it out
explicitly for ads because campaigns *edit and resubmit* creative after a rejection
(`CAMPAIGNS.md:106-123`, draft/rejected → editable again). If a resubmission reused the
same storage path, the public bucket being CDN/browser-cached means viewers (and the
admin reviewing "the new version") could see stale bytes under a URL that looks updated.
Always generate a fresh UUID path per upload so the public URL itself changes and caching
is a non-issue — no invalidation logic needed.
**Effort:** S (a convention + one-line rule in #2's implementation, not new infra).

## 8. Alt text required at submit, not just at upload

`submit_campaign` (`DATA_MODEL.md:176`) already "validates creative completeness." Extend
that check: any `creative.image_url` present requires a non-empty sibling `creative.alt_text`,
enforced both client-side (CreativeUploader/CreativeEditor blocks submit) and server-side
in the RPC (fail closed — a client-only check is bypassable via direct RPC call). Matches
the FTC "clear and prominent, on every device" bar `INAPP_ADS.md` §4.1 already holds the
*label* to, extended to the image itself for screen-reader users.
**Effort:** S. **Touches:** `submit_campaign` RPC validation, `CreativeEditor` form field.

## 9. Normalize `ad_creatives` as its own table instead of a jsonb blob field

Today `creative` is a single jsonb column on `ad_campaigns` (`DATA_MODEL.md:506-507`).
A dedicated `ad_creatives(id, business_id, storage_path, kind, width, height,
moderation_status, created_by, created_at)` table — referenced by `campaign_id` — gives
per-asset moderation state (vs. all-or-nothing campaign approval), lets an approved logo
or banner be **reused across campaigns** without re-upload/re-review, and gives #6's orphan
sweep and #3's approval gate a real row to join against instead of parsing jsonb. This is
a bigger structural change than #1-#8 and should follow them, not block them.
**Effort:** M/L. **Touches:** new migration, `DATA_MODEL.md` schema section, `create_campaign`/
`admin_review_campaign` RPC updates.

## 10. Field-level rejection surfacing

`CAMPAIGNS.md:520-522` already has a `reject_reason` enum (`prohibited_content`,
`low_quality`, `impersonation_or_trademark`, etc.) — no new taxonomy needed. The gap is
that rejection is campaign-level, so an advertiser with good copy but a bad image can't
tell *which* asset to fix. Add an optional `reject_field ∈ ('image', 'copy', 'link')` on
the same `admin_review_campaign(approve=false, ...)` call, surfaced in
`ADVERTISER_CONSOLE.md`'s rejection view next to the reason, so re-editing highlights the
actual `CreativeUploader` slot instead of the whole form.
**Effort:** S. **Touches:** `admin_review_campaign` RPC (add optional param), advertiser
console rejection UI.

## 11. Frozen creative version history for admin audit

Since `CAMPAIGNS.md:106-123` freezes creative at approval and a resubmission after
rejection is effectively a new version, keep the *previous* rejected/superseded image
(soft-referenced, not deleted) tagged to its campaign submission — feeds `moderation_actions`
(`CAMPAIGNS.md` §7.3) with a visual diff so "what did the admin actually see when they
approved this" is answerable during a dispute, and so a bait-and-switch attempt (upload
tame image, get approved, later idea #7 forces a *new* path for any swap so this is
already structurally hard — this makes it auditable too).
**Effort:** M. **Touches:** builds on #9's table (a `superseded_by`/`campaign_creatives`
join), `ADMIN_CRM.md` audit view.

## 12. Business logo upload reuses the same pipeline

`businesses.logo_url` already exists (`20260711000000_business_accounts.sql:24`) but has
no defined upload path today. Point it at the same `CreativeUploader` + `campaign-creatives`
bucket (kind: `logo`, 1:1 preset from #5), uploaded once at the business-profile level
rather than re-uploaded per campaign — `SponsorSlot`'s "Sponsored by {business.name}" and
future map-strip treatments can then read one canonical, already-approved asset instead of
each campaign supplying its own.
**Effort:** S. **Touches:** business profile settings screen, `CreativeUploader` reuse.

## 13. Per-business storage quota visibility in the admin CRM

`AVAILABILITY.md` F2 already tracks the review-photos bucket against Supabase's 1GB cap
as a slow-burn risk; a business tier with many concurrent campaigns × multiple derivative
sizes (#14) could do the same to `campaign-creatives`. A lightweight read-only panel in
`ADMIN_CRM.md` showing bytes-used per business (sum of `ad_creatives.file_size` if #9
ships, or a periodic `storage.objects` rollup otherwise) lets ops catch a runaway
advertiser before the bucket-wide cap bites everyone.
**Effort:** S. **Touches:** `ADMIN_CRM.md` new panel, a read-only query/RPC.

## 14. Multi-surface derivative generation from one source upload

Instead of an advertiser uploading separately for detail-banner and email-banner (same
`image_url` per `ADVERTISER_CONSOLE.md:236`), let `CreativeUploader` take one high-res
source and client-side-generate both derivatives (#5's presets) in one picker interaction,
storing each as its own object/path. Reduces upload friction and guarantees the two
surfaces show visually consistent creative instead of two independently-cropped uploads
that might not match. Meaningfully more UI/state complexity than #5 alone (multiple
previews, multiple upload calls, partial-failure handling), so it's a refinement layered
on top rather than a v1 requirement.
**Effort:** L. **Touches:** `CreativeUploader.tsx`, `src/lib/image.ts` batch variant.

## 15. Lightweight review-impersonation checklist for admins

`INAPP_ADS.md` §4.3 is a bright line: creative must never look like a fabricated review
(fake stars, fake author, fake rating baked into the image itself). Given the SPA-only,
no-server-ML constraint, true detection is out of scope — but the admin review queue
(#3) can prompt a specific checklist item ("does this image simulate stars/a review
card?") rather than relying on a generalist "does this look OK" glance, and the existing
`impersonation_or_trademark` reject reason already covers the enforcement path. Lowest
confidence-to-effort of this batch since it's process, not code — included for
completeness rather than as a near-term build.
**Effort:** S/M (mostly a checklist + doc note, not a feature). **Touches:**
`ADMIN_CRM.md` review-queue checklist copy.

---

**Top picks:** #1 (bucket + business-scoped RLS) is the load-bearing precedent-swap from
`review-photos`; #2 bakes the deletion-ordering lesson in from day one instead of
re-discovering F9; #3 is the one genuinely hard constraint (no creative goes live
unapproved) and is cheap to wire into the state machine that already exists. Everything
else (aspect presets, normalization, quota visibility) is real value layered on top, not
blocking.
