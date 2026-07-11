# Advertiser Console — UX & Component Spec (A10)

**Summary (3 lines).** The advertiser console is the self-serve surface where a
paying business creates and manages promotions: geo-targeted email blasts,
in-app featured placements, and newsletter features. It lives inside the
existing `/business/*` tree, reuses the current design system, `BathroomMap`,
auth guards, and react-query patterns, and its centerpiece is a guided campaign
builder that shows an **aggregate-only** reach estimate and enforces plan
entitlements client-side (the server re-checks everything). The console never
exposes an individual user or an individual location — only counts.

**Dependencies (docs this relies on).** `DATA_MODEL.md` (A2 — table/column
names, RLS, RPC surface), `CAMPAIGNS.md` (A5 — campaign lifecycle + scheduling +
reach RPC), `PRICING.md` (A9 — plans/entitlements the meters read),
`COMPLIANCE.md` / `PRIVACY_POLICY_v2.md` (A1 — consent, CAN-SPAM footer,
aggregate-only disclosure copy), `EMAIL_DELIVERY.md` (A6 — branded email template
the live preview mirrors, send-time suppression/frequency), `INAPP_ADS.md` (A7 —
featured surfaces + slot inventory), `NEWSLETTER.md` (A8 — editions + slot
model), `LOCATION.md` (A3 — coarse region set + k-anonymity floor),
`ABUSE_AND_LIMITS.md` (A12 — frequency cap enforcement), `SCALING_COST.md` (A13 —
creative asset storage/CDN). This doc owns **only** the advertiser-facing UI/UX
and its React component contracts; every data shape it names is owned by A2/A5.

This is a **design**. No `src/**` or `supabase/**` changes ship from here — the
orchestrator (A14) implements later against the seams below.

---

## 1. Scope & non-goals

**In scope.** New advertiser-facing sections under `/business/*`: Campaigns
(list + builder), Featured placements, Newsletter slots, Audience/reach explorer,
and Billing/plan + entitlements usage. Component specs, props, states, data
seams, and the visual mapping onto the existing token system.

**Explicitly out of scope (owned elsewhere).** The admin approval queue and the
raw CRM (A11); the actual send pipeline, suppression, and frequency enforcement
(A5/A6/A12 — the console *reflects* these rules but the server is the authority);
plan definitions and prices (A9); the coarse-location capture and the eligibility
SQL (A3/A2); Stripe (future — the console reads `subscriptions` and shows an
"arranged out of band" billing state until Stripe lands, per the contract).

**Guiding constraint (non-negotiable, from the contract).** Advertisers see
**aggregate reach counts, never individual users or locations.** Every screen in
this console that touches audience data is a count, a bucket, or a chart with a
k-anonymity floor. There is no screen, export, drill-down, or hover state
anywhere in the advertiser console that resolves to a single person.

---

## 2. Information architecture

### 2.1 Where it lives

Today the business tier is a set of standalone pages under `/business/*` with a
per-business quick-link row rendered inside `BusinessDashboard`'s `BusinessCard`
(`Import CSV · Team · Analytics · Settings`). The console adds a **"Promote"**
group of destinations for a single business, plus a Billing destination.

Rather than lengthen the flat quick-link row, introduce a thin **`BusinessLayout`
shell** for the per-business routes (mirroring the existing `AdminLayout` pattern:
a nav + `<Outlet/>`). The nav is a horizontal, scrollable tab strip on the
business context, grouped:

```
Manage        Promote                       Account
──────        ───────                       ───────
Overview      Campaigns                     Billing & plan
Listings      Featured placements           Team
Analytics     Newsletter                    Settings
              Audience
```

- **Overview** = the existing dashboard content for that business.
- **Listings / Analytics / Team / Settings** = today's pages, re-parented under
  the shell (their URLs already carry `:businessId` except Import/Listings —
  see routes). No behavior change; they just gain the shared tab nav.
- The **Promote** group and **Billing** are new (this doc).

Staff (role `staff`) see the tab strip but the Promote group is read-only and
the "New campaign / Reserve slot" affordances are absent (see §4).

`BusinessDashboard`'s existing per-card quick-link row keeps working as a
shortcut; add `Campaigns` and `Billing` links to it so the dashboard remains a
launchpad. The row and the shell nav point at the same routes.

### 2.2 Routes (extends `src/router.tsx`)

All new routes sit under the existing `Layout` and are wrapped in the existing
`RequireAuth`, then a new **`RequireBusinessManager`** UX guard (see §4). Naming
follows the current `/business/:businessId/<section>` convention.

| Path | Element | Access |
| --- | --- | --- |
| `/business/:businessId/campaigns` | `CampaignList` | member (staff read-only) |
| `/business/:businessId/campaigns/new` | `CampaignBuilder` (create) | manager |
| `/business/:businessId/campaigns/:campaignId` | `CampaignDetail` (metrics + edit-if-draft) | member (edit → manager) |
| `/business/:businessId/featured` | `FeaturedSlotPicker` | member (reserve → manager) |
| `/business/:businessId/newsletter` | `NewsletterSlots` | member (reserve → manager) |
| `/business/:businessId/audience` | `AudienceExplorer` | member |
| `/business/:businessId/billing` | `BillingPlan` | member (change → manager) |

The builder is deliberately its own full-page route (not a modal) — it is a
multi-step wizard like the existing `CsvImport`, and a distinct URL lets a draft
be linked, refreshed, and resumed.

Route wiring sketch (matches the existing array style in `router.tsx`):

```tsx
{
  path: '/business/:businessId',
  element: (
    <RequireAuth>
      <BusinessLayout />          {/* tab nav + <Outlet/> */}
    </RequireAuth>
  ),
  children: [
    { path: 'campaigns', element: <CampaignList /> },
    { path: 'campaigns/new', element: (
        <RequireBusinessManager><CampaignBuilder /></RequireBusinessManager>
      ) },
    { path: 'campaigns/:campaignId', element: <CampaignDetail /> },
    { path: 'featured',   element: <FeaturedSlotPicker /> },
    { path: 'newsletter', element: <NewsletterSlots /> },
    { path: 'audience',   element: <AudienceExplorer /> },
    { path: 'billing',    element: <BillingPlan /> },
    // existing per-business pages re-parented here over time:
    // members, analytics, settings
  ],
}
```

> Note for A14: re-parenting the existing `members`/`analytics`/`settings` routes
> under the shell is optional and cosmetic; the new routes work standalone if the
> shell is skipped. Keep the current flat routes live if re-parenting is deferred.

---

## 3. Campaign builder flow (the centerpiece)

A linear, resumable wizard reusing the exact visual grammar of `CsvImport`'s
stepper (numbered pills, `border-flush-500 bg-flush-500/10` for the active step,
`Back`/`Continue` buttons, everything inside `mx-auto max-w-4xl px-4 py-8`).
Steps adapt to the chosen type.

```
① Type   →   ② Audience   →   ③ Creative   →   ④ Schedule   →   ⑤ Review & submit
```

| Step | Email blast | Featured (in-app) | Newsletter feature |
| --- | --- | --- | --- |
| ① Type | ● | ● | ● |
| ② Audience | geo + reach estimate | surface + region | pick edition |
| ③ Creative | subject/body/image + email preview | listing + tagline + image | blurb + image |
| ④ Schedule | send window + frequency/wk | slot window (from `FeaturedSlotPicker`) | edition date (fixed) |
| ⑤ Review | ● | ● | ● |

A draft is created (`status='draft'`) the moment the user leaves Step ① so the
wizard is resumable; each step autosaves the draft. Submit flips it to
`pending_review` for the admin queue (A11).

### Step ① — Pick type

Three large radio cards (reuse the `.card` + selectable-tile pattern from
`CsvImport`'s business picker). Each card shows the type, a one-line description,
and its **entitlement state** inline (via `EntitlementMeter`, compact variant):

- **Email blast** — "Send an approved promo to opted-in people in a city or
  region." → `2 of 3 blasts left this month`.
- **Featured placement** — "Rise to the top of the map, browse, or a listing."
  → `1 of 3 featured slots left this week`.
- **Newsletter feature** — "Appear in the next Watrloo newsletter." → shows next
  edition date + whether a slot remains.

A type whose entitlement is exhausted renders **disabled** with an "Upgrade to
add more" link to `/business/:businessId/billing` (copy/CTA per A9). This is a UX
convenience only — §4 covers the server re-check.

### Step ② — Audience (geography + reach)

**Coarse only.** Per the owner's binding decision, targeting is city/region
granularity, never street-level. The UI enforces this by construction: the user
does not drop an arbitrary precise pin — they choose a **place** (city/region) and
a **coarse radius bucket**.

Layout, two columns on `md+`, stacked on mobile:

- **Left — target controls**
  - `RegionSelect`: a typeahead over the *known coarse regions* (the distinct
    `ip_city` / `ip_region` values that have opted-in users, provided by A3 — see
    §7). Selecting one sets `target_region` and centers the map on that region's
    centroid.
  - `RadiusSelect`: coarse presets only — **City only · ~25 km · ~50 km ·
    ~100 km** (maps to `radius_km`). No free-entry meters; no sub-city values.
  - Optional `SegmentSelect`: pick a saved `user_segments` definition instead of
    a raw region (owned by A3/A11; advertisers only pick from segments an admin
    has published as "advertiser-selectable").
- **Right — `GeoTargetPicker`** (wraps `BathroomMap`): shows the region centroid
  and a translucent radius circle. The map is a **visualization + coarse picker**:
  clicking snaps to the nearest known region centroid (never a raw lat/lng), so a
  click can only ever pick a city, not a street corner.

Below the controls, the **`ReachEstimator`** panel:

```
┌─────────────────────────────────────────────────────────┐
│  Estimated reach                                          │
│                                                           │
│      ~ 4,200 people                                       │
│      opted in to marketing · within ~25 km of Fresno, CA  │
│                                                           │
│  This is an approximate count. Watrloo never shows you    │
│  who these people are or where they live. ⓘ               │
└─────────────────────────────────────────────────────────┘
```

The number comes from a single aggregate RPC (`campaign_reach_estimate`, §7) that
runs the same eligibility predicate the sender will use (region match ∩
`marketing_opt_in` ∩ not in `email_suppressions` ∩ frequency-cap headroom) and
returns **only an integer**. Below a **minimum reach floor** (default 100, exact
value owned by A1/A3) the panel shows "Too small to target — widen your area"
instead of a precise small number, so the count can never be triangulated toward
individuals. See §6.3.

### Step ③ — Creative

Reuse `CreativeEditor` (§5.5). For an email blast it is a split view: **compose**
on the left, **live branded preview** on the right.

- **Subject** (`Input`, maxLength ~120, with a live character count).
- **Body** (`Textarea`, plain text or a constrained rich subset — bold/link/list
  only, decided with A6 to match what the template renders safely).
- **Image** (optional): drag/drop or file picker reusing the existing
  `compressImage` + `MAX_UPLOAD_BYTES` pipeline (`@/lib/image`). Uploaded to a
  manager-scoped path; the editor stores the returned **public URL** in
  `creative.image` (email clients fetch images over HTTP, so the asset must be
  publicly reachable — see §7 storage note).
- **Link** (`Input`, `type="url"`): the destination CTA.

The **live preview** renders the composed creative inside the **branded Watrloo
email shell** so the advertiser sees exactly what recipients get, including the
parts they do **not** control:

- Watrloo header/logo and brand chrome (matches A6's Resend template).
- Their subject, body, image, CTA button.
- The **locked CAN-SPAM footer**: sender identity ("Sent by Watrloo on behalf of
  {business.name}"), Watrloo's physical postal address, and a one-click
  **Unsubscribe** link. This footer is rendered by the template, is **not
  editable**, and is shown in the preview specifically so the advertiser can see
  compliance is handled for them. (CAN-SPAM requires accurate sender ID, a valid
  physical postal address, and a clear, honored opt-out — FTC CAN-SPAM Rule, 16
  CFR Part 316. Copy owned by A1; template owned by A6.)

For **featured** and **newsletter** creatives the editor drops the email shell
and previews the in-app card / newsletter block instead (same component, `mode`
prop).

### Step ④ — Schedule + frequency (within plan limits)

- **Email blast**: a send window (`starts_at`, optional `ends_at`) and a
  `frequency_per_week` stepper. The stepper's max is clamped to the **remaining
  entitlement** from `EntitlementMeter` (e.g. if `blasts_per_month` shows 1 left,
  frequency/repeat options that would exceed it are disabled with an inline
  "You have 1 blast left this month" note). Dates are pickers; no send may be
  scheduled in the past.
- **Featured**: the schedule is the slot window chosen in `FeaturedSlotPicker`
  (Step ②/④ merge for this type) — bounded to a few activations/week/slot per the
  contract; unavailable windows are shown as taken.
- **Newsletter**: the schedule is the edition's fixed publish date (read-only).

A persistent **frequency-cap reality** note appears here and again on Review
(§6.2): the advertiser learns their audience is shared and capped globally.

### Step ⑤ — Review & submit

A read-only summary grouped as Type · Audience (with the reach number and the
"aggregate only" reassurance) · Creative (thumbnail of the preview) · Schedule.
Above the submit button:

- The **frequency-cap disclosure** (§6.2).
- The **entitlement confirmation**: "Submitting uses 1 of your 3 monthly blasts."
- A note that **submission goes to Watrloo for approval** before anything sends
  (`status: draft → pending_review`), and that the entitlement is only *consumed*
  when the campaign is approved and actually runs (final accounting owned by A5).

Primary action: **Submit for approval** (calls `submit_campaign_for_review`,
§7). On success, route to `CampaignDetail` showing the `pending_review` state.
Secondary: **Save draft & exit**.

---

## 4. Access control

Layered exactly like the rest of the app: a **client gate for UX**, a **server
gate for truth**. The client gate never grants access the server wouldn't; it
only avoids showing dead-end UI.

- **Authentication** — every console route is under the existing
  `RequireAuth` (unchanged; `src/auth/RequireAuth.tsx`).
- **Membership + role (client)** — a new **`RequireBusinessManager`** wrapper,
  modeled on `RequireRole`, reads `useAuth().businessMemberships` and the route's
  `:businessId`:
  - Not a member of that business → redirect to `/business/dashboard`.
  - Member but role `staff` → render children in **read-only** mode (or, for
    create-only routes like `campaigns/new`, redirect to the list with a toast).
  - Role `owner`/`manager` **and** the business has a live subscription
    (`status ∈ {active, trialing}`, from `MyBusiness.subscription`) → full access.
  - Manager but **no live plan** → render the section but replace primary actions
    with an **upgrade CTA** to `/business/:businessId/billing`. (No plan, no new
    campaigns — mirrors `manages_bathroom`'s subscription requirement.)
- **Server (authoritative)** — every mutation RPC re-checks
  `is_business_manager(business_id)` (already defined, owner/manager only —
  `supabase/migrations/20260711000000_business_accounts.sql:117`) **and** an
  active subscription, and writes to the audit/moderation trail. A tampered
  client that forges a manager view still cannot create, submit, upload, or
  reserve, because PostgREST/RPC RLS denies it (surfaced as 403 / `42501`, which
  the existing `isPermissionDenied` helpers already translate to friendly copy —
  see `BusinessSettings.tsx`, `ListingManage.tsx`).

**Staff read-only surface.** Staff can open `CampaignList`, `CampaignDetail`
metrics, `AudienceExplorer`, `BillingPlan`, and the Featured/Newsletter inventory
views — everything that is a *view*. They do not see "New campaign", "Reserve
slot", "Submit", or edit controls. This matches how `BusinessMembers` already
shows a read-only roster to non-owners.

---

## 5. Component specs

Conventions shared by all: react-query for reads (keys added to
`src/lib/queryClient.ts`'s `queryKeys`), `Button`/`Input`/`Textarea`/`Checkbox`
from `@/components/ui/*`, `cn` for class merging, page frame
`mx-auto max-w-4xl px-4 py-8`, and the standard **loading / error / empty**
triad already used across the business pages (skeletons or "Loading…", red error
line + `secondary` "Try again" button, and a friendly empty card). Every
component below specifies those three states plus its live/draft/pending states
where relevant.

> Data types below reference canonical A2 names (`AdCampaign`, `CampaignSend`,
> `FeaturedPlacement`, `PlanFeature`, etc.). Where a type isn't yet declared in
> `src/types/db.ts`, treat the shape as **"for A2 to add to `db.ts`"**.

### 5.1 `CampaignList`

Purpose: the advertiser's home for promotions — every campaign for the business
with its status, type, window, and headline reach/spend.

```ts
interface CampaignListProps {
  businessId: string;            // from route params
}
```

- **Data source**: `list_campaigns(business_id)` (A5) → `AdCampaign[]` ordered
  newest first, or a direct RLS-scoped `select` on `ad_campaigns`
  (member-visible per A2 RLS). Query key: `queryKeys.campaigns(businessId)`.
- **Layout**: header with title + a `primary` **"New campaign"** button (hidden
  for staff). A compact `EntitlementMeter` row across the top ("2 of 3 blasts ·
  1 of 3 featured · newsletter: 1 slot"). Below, a list of `CampaignRow`s
  (echoing `BusinessDashboard`'s `ListingRow`: name, type icon, window, a
  `StatusChip`, and a "View" link to `CampaignDetail`).
- **Status chip** — reuse the chip grammar already in `BusinessDashboard`:
  | status | tone |
  | --- | --- |
  | `draft` | `bg-sunken text-muted` |
  | `pending_review` | `bg-amber-500/15 text-amber-600` |
  | `approved` / `running` | `bg-green-500/15 text-green-600` |
  | `paused` | `bg-amber-500/15 text-amber-600` |
  | `done` | `bg-sunken text-muted` |
  | `rejected` | `bg-red-500/15 text-red-600` |
- **States**: loading → row skeletons; error → red line + Try again; **empty** →
  a `.card` with "No campaigns yet" + "Create your first campaign" (manager) or
  "Your team hasn't run any campaigns yet" (staff).

### 5.2 `CampaignBuilder`

Purpose: the Step ①–⑤ wizard of §3.

```ts
interface CampaignBuilderProps {
  businessId: string;
  campaignId?: string;           // present when resuming an existing draft
}

type BuilderStep = 'type' | 'audience' | 'creative' | 'schedule' | 'review';

interface DraftState {
  type: 'email_blast' | 'featured' | 'newsletter';
  target_region: string | null;
  target_geog: { lat: number; lng: number } | null;  // region centroid, coarse
  radius_km: number | null;                            // one of the coarse buckets
  segment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  frequency_per_week: number;
  creative: { subject: string; body: string; image: string | null; link: string | null };
}
```

- **Data sources**:
  - reads: `entitlement_usage(business_id)` (A9/A5) to gate types + schedule;
    `campaign_reach_estimate(...)` (A5/A3) via `ReachEstimator`;
    `list_advertiser_segments(business_id)` (A3) for `SegmentSelect`.
  - writes: `create_campaign_draft(business_id, type)` on entering Step ②;
    `update_campaign_draft(campaign_id, patch)` (debounced autosave per step);
    `submit_campaign_for_review(campaign_id)` on Step ⑤. All A5, all re-check
    `is_business_manager` + subscription.
- **Local state**: `step` + `DraftState`; the stepper renders like `CsvImport`'s
  `STEPS` ol. `Continue` is disabled until the current step validates
  (e.g. Audience requires a region **and** a reach ≥ floor; Creative requires a
  subject and body).
- **States**:
  - **draft** — the normal editing state; autosave shows an unobtrusive "Saved"
    tick (reuse the `role="status"` "Saved ✓" pattern from `ListingManage`).
  - **submitting** — `Button loading`; on success navigate away.
  - **entitlement-exhausted** — types disabled in Step ①; if a manager reaches
    Review with a stale-exhausted entitlement, submit is disabled with an inline
    explanation and an upgrade link (server would reject anyway).
  - error (autosave/submit) — inline red line; the friendly-403 helper for the
    permission case; a generic retry otherwise. Loading (resume existing draft) →
    the same skeleton frame as `BusinessSettings`.

### 5.3 `ReachEstimator`

Purpose: turn the current target into an **aggregate** count, with the privacy
boundary made explicit and the small-audience floor enforced.

```ts
interface ReachTarget {
  region: string | null;
  radius_km: number | null;
  segment_id: string | null;
  channel: 'email' | 'featured' | 'newsletter';
}

interface ReachEstimatorProps {
  businessId: string;
  target: ReachTarget;
  minFloor?: number;             // default from A1/A3 config, e.g. 100
}
```

- **Data source**: `campaign_reach_estimate(business_id, target)` (A5, wrapping
  A3's eligibility query) → `{ count: number; floored: boolean }`. **Returns a
  scalar only** — no ids, no rows, no per-region breakdown finer than the chosen
  region. Query key: `queryKeys.reachEstimate(businessId, targetHash)`.
- **Behavior**: debounce target changes (~400 ms) and cache by a stable hash of
  the target so panning/adjusting the map doesn't hammer the RPC. Never persist
  the underlying set — only the count is ever held in memory.
- **States**:
  - **idle** — no region chosen yet: "Choose a city or region to see your
    estimated reach."
  - **loading** — a subtle shimmer over the number.
  - **result** — the big `~N people` with the qualifier line and the ⓘ
    reassurance (§6.3).
  - **below-floor** — `floored: true` → "Too small to target (fewer than ~{floor}
    people). Widen your radius or pick a larger region." No exact number shown.
  - **error** — "Couldn't estimate reach right now." + Try again; `Continue`
    stays disabled while errored.
- **A11y**: the count is in an `aria-live="polite"` region so it announces on
  change; color is never the only signal.

### 5.4 `FeaturedSlotPicker`

Purpose: browse and reserve time-boxed featured slots (surfaces: map / browse /
detail), respecting the per-week activation cap.

```ts
interface FeaturedSlotPickerProps {
  businessId: string;
  // when embedded in the builder, it reports the chosen slot back:
  onSelect?: (slot: FeaturedSlotChoice) => void;
  value?: FeaturedSlotChoice | null;
}

interface FeaturedSlotChoice {
  surface: 'map' | 'browse' | 'detail';
  region: string;
  bathroom_id: string | null;    // required when surface === 'detail'
  starts_at: string;
  ends_at: string;
}
```

- **Data sources**: `list_featured_availability(region, surface, window)` (A7/A5)
  → available vs. taken slots for the region; `reserve_featured_slot(...)` (A5)
  writes a `featured_placements` row tied to the campaign. Reads are member-
  visible; reserve is manager-only.
- **UX**: pick surface (segmented control), pick which claimed listing (for
  `detail`), pick a week/window from a small availability calendar. Taken and
  cap-exhausted windows render disabled with "Fully booked" / "Weekly limit
  reached for this slot". A live preview (via `CreativeEditor mode="featured"`)
  shows how the featured card looks on that surface.
- **States**: loading (calendar skeleton), error (Try again), **empty** ("No
  featured inventory for this region yet"), **at-cap** (all windows disabled +
  explanation), **reserved** (confirmation + link back to the campaign).

### 5.5 `CreativeEditor`

Purpose: compose the creative and preview it in the exact rendered surface.

```ts
interface Creative {
  subject: string;
  body: string;
  image: string | null;          // public URL after upload
  link: string | null;
}

interface CreativeEditorProps {
  businessId: string;
  mode: 'email' | 'featured' | 'newsletter';
  value: Creative;
  onChange: (next: Creative) => void;
  disabled?: boolean;            // staff / non-manager
}
```

- **Image upload**: reuse `compressImage` + `MAX_UPLOAD_BYTES` + `ACCEPTED_TYPES`
  from `@/lib/image` (same pipeline as `PhotoUploader`, which also strips EXIF/GPS
  — a good default for advertiser uploads too). Upload path is **manager-scoped**
  and returns a **public URL** stored in `creative.image` (see §7 storage note).
  Show an upload progress/spinner and a remove control like `PhotoUploader`.
- **Live preview** (right pane): renders `value` inside the surface shell:
  - `mode='email'` → the **branded Watrloo email template** with the locked
    CAN-SPAM footer (§3 Step ③). The preview markup mirrors A6's Resend template;
    to guarantee they match, **REQUEST TO A6**: expose the email template as a
    shared render function or a static HTML skeleton the console can import,
    rather than duplicating markup.
  - `mode='featured'` → the in-app featured card (matches A7's placement chrome).
  - `mode='newsletter'` → the newsletter block (matches A8).
- **Validation**: subject required + length-capped; body required; link must be a
  valid URL if present; image must survive compression under the size cap
  (surface the same "still too large after compression" message pattern the photo
  uploader uses).
- **States**: idle/editing, uploading, upload-error (inline), disabled (staff —
  fields read-only, no upload/remove).

### 5.6 `EntitlementMeter`

Purpose: make plan limits legible everywhere — "2 of 3 blasts left this month".

```ts
interface Entitlement {
  feature: 'blasts_per_month' | 'featured_per_week' | 'newsletter_per_month'
         | 'max_locations' | string;
  label: string;                 // "Email blasts"
  used: number;
  limit: number | null;          // null = unlimited on this plan
  period: 'month' | 'week' | null;
  resets_at: string | null;
}

interface EntitlementMeterProps {
  businessId: string;
  features?: Entitlement['feature'][];  // subset to show; default = all
  variant?: 'full' | 'compact';         // compact = inline chips (Step ①)
  entitlements?: Entitlement[];         // optional preloaded, else self-fetches
}
```

- **Data source**: `entitlement_usage(business_id)` (A9 defines the plan→limits
  mapping; A5 counts usage from `campaign_sends`/`featured_placements`). Query
  key: `queryKeys.entitlements(businessId)`.
- **Full variant**: a small grid of meters — each a label, `used / limit`, a
  progress bar (`bg-sunken` track, `bg-flush-500` fill; turns
  `amber`/`red` as it nears/hits the limit), and "resets {date}". Unlimited shows
  "Unlimited" with no bar.
- **Compact variant**: inline pills for Step ① and `CampaignList` header.
- **This is UX only.** The copy explicitly frames it as a convenience: the
  server is the source of truth and re-checks at submit and at send time. When a
  meter is at 100%, dependent actions are disabled with an upgrade link, but a
  race that slips through is still caught server-side.
- **States**: loading (bar skeletons), error (compact inline "usage unavailable"
  — never blocks viewing, only conservatively disables new-spend actions),
  empty/no-plan ("No active plan" → upgrade CTA, echoing `BusinessSettings`'
  `PlanPanel`).

### 5.7 `CampaignMetrics`

Purpose: post-launch aggregate results for one campaign — **counts only**.

```ts
interface CampaignMetricsProps {
  businessId: string;
  campaignId: string;
}

interface CampaignAggregate {
  status: AdCampaignStatus;
  reach_delivered: number;       // distinct recipients successfully delivered
  sent: number;
  skipped_frequency_cap: number; // eligible but capped globally (see §6.2)
  skipped_suppressed: number;    // unsubscribed/bounced at send time
  bounced: number;
  unsubscribed: number;
  clicks: number | null;         // only if link-tracking is on (A6); else null
  // featured/newsletter variants: impressions, activations — all aggregate
}
```

- **Data source**: `campaign_metrics(campaign_id)` (A5/A6) — a **SQL aggregate
  over `campaign_sends`**, returning grouped counts, never rows. Query key:
  `queryKeys.campaignMetrics(campaignId)`.
- **Layout**: a KPI grid reusing `BusinessAnalytics`'s `Kpi` card (label,
  big number, hint). Headline KPIs: Delivered · Sent · Unsubscribed · (Clicks, if
  available). A secondary line explains **why some were skipped** ("312 eligible
  people weren't messaged because they'd already received 3 promos this week" —
  ties directly to §6.2), which doubles as reassurance that the platform protects
  recipients.
- **Privacy**: no recipient list, no per-region-finer-than-target breakdown, no
  hover that resolves to a person. If a metric would drop below the k-anonymity
  floor it renders "—" with a "too few to report" hint.
- **States by campaign status**:
  - `draft` — no metrics yet: "This campaign hasn't been submitted."
  - `pending_review` — "Waiting for Watrloo approval" (amber), no metrics.
  - `rejected` — the admin's reason (from `moderation_actions.detail`, surfaced
    read-only) + "Edit & resubmit" (clones to a new draft).
  - `approved` (not yet started) — scheduled window + "Starts {date}".
  - `running` — live counts, auto-refetch on a gentle interval.
  - `paused` — last counts + a "Paused by Watrloo/you" note.
  - `done` — final counts.
  - loading/error — skeleton KPI grid / Try again, as in `BusinessAnalytics`.

### 5.8 Supporting components (this doc, not in the named list)

- **`BusinessLayout`** — the tabbed shell of §2.1 (nav + `<Outlet/>`), pattern-
  matched to `AdminLayout`. Highlights the active tab; hides Promote actions for
  staff.
- **`RequireBusinessManager`** — the client gate of §4 (modeled on `RequireRole`;
  reads `businessMemberships` + `:businessId`; supports a `readOnly` render for
  staff vs. redirect for create-only routes).
- **`GeoTargetPicker`** — thin wrapper over `BathroomMap` that adds the radius
  circle overlay and snaps clicks to the nearest known region centroid (coarse).
  **REQUEST TO map owner / A7**: add an optional `circle?: { center, radiusKm }`
  overlay prop to `BathroomMap`, or accept this wrapper drawing the circle as a
  sibling layer. `BathroomMap` already supports `selectable`/`onSelect`/`selected`
  and a `center`/`zoom`, so the wrapper mainly constrains those to coarse values.
- **`EmailPreview`** — the branded-shell renderer used by `CreativeEditor`
  (`mode='email'`); shares markup with A6's template per the request above.
- **`AudienceExplorer`** (the "Audience/reach explorer" IA section) — a
  standalone page to explore reach across regions/segments **before** committing
  to a campaign. It is `ReachEstimator` at page scale: pick a region + radius (or
  a published segment), see the aggregate count and a coarse region-level bar
  chart (counts per selectable region, each with the k-anonymity floor applied).
  Same hard rule — buckets and counts only, never a person. Includes the standing
  privacy-boundary card (§6.3). "Use this audience" hands the target into a new
  `CampaignBuilder` draft.
- **`BillingPlan`** — the "Billing/plan + entitlements usage" section: the
  existing `PlanPanel` (from `BusinessSettings`) plus a **full** `EntitlementMeter`
  and, until Stripe exists, a "billing arranged with Watrloo" note + contact CTA
  (per the contract's manual-money reality). Plan comparison/upgrade copy owned
  by A9.

---

## 6. Guardrails in the UI

Three guardrails are visible, repeated where the user makes the relevant decision,
and always framed as "the server enforces this — the UI just tells you early."

### 6.1 Plan entitlements (client-side for UX; server re-checks)

- `EntitlementMeter` is present on `CampaignList`, in Step ① of the builder, on
  Step ④ (clamping frequency), and full-size on Billing.
- Exhausted entitlements **disable** the corresponding type/action and show an
  upgrade link to Billing. Frequency/repeat controls are clamped to remaining
  allowance.
- Copy is explicit that this is a preview of limits, not the enforcement:
  submission calls `submit_campaign_for_review`, which re-checks against
  `plans`/`plan_features` and current usage; send-time checks run again in A5/A6.
  A client that bypasses the disabled state still fails server-side.

### 6.2 Frequency-cap reality (shared, capped audience)

Advertisers must understand they don't own their audience's inbox. A standing
disclosure appears on Step ④ and Step ⑤, and the skip counts surface in
`CampaignMetrics`:

> **You're sharing an audience.** To respect people's inboxes, Watrloo delivers
> **at most 3 promotional messages per person every 7 days** across *all*
> businesses — not just yours. If someone in your estimate has already hit that
> cap, we skip them this time. **Skipped recipients don't consume your
> allowance**, and your reach number is an estimate of who's *eligible*, not a
> guarantee everyone is messaged.

Default cap = **3 per 7 days per user** (contract; configurable). Enforcement is
server-side at send time (A5/A6/A12); the console only *explains* it and later
*reports* the skips (`skipped_frequency_cap` in `CampaignMetrics`). This turns a
limitation into a trust signal.

### 6.3 The "no individual data ever" boundary (visible & reassuring)

A short, consistent reassurance component (`PrivacyBoundaryNote`) appears on the
`ReachEstimator`, on `AudienceExplorer`, and on `CampaignMetrics`:

> **Watrloo never shows you individual people or their locations.** You choose a
> city or region; we tell you *roughly how many* opted-in people match. Every
> number here is an aggregate. You'll never see a name, an email, an address, or
> a precise location — not now, not on export, not anywhere.

Backing this UI promise structurally (not just in copy):

- The only audience RPCs the console calls return **scalars/buckets** with a
  **k-anonymity floor** (default 100, owned by A1/A3): below it, the UI shows
  "too small to target/report", never a small exact number.
- There is **no** advertiser endpoint that lists users, and none is requested.
  The raw `user_locations` / CRM is admin-only by RLS (`is_admin()`) per the
  contract and A11 — the advertiser console has no route, query, or component
  that touches it.
- Coarse-by-construction targeting (region + bucketed radius, click snaps to
  centroid) means the advertiser can't even *ask* a street-level question.

### 6.4 CAN-SPAM / consent, shown not hidden

The locked branded footer (sender ID, physical postal address, one-click
unsubscribe) is rendered in the `CreativeEditor` email preview so the advertiser
sees compliance is handled and cannot remove it. The console also states that
sends go **only to people who opted into marketing** and that unsubscribes are
honored at send time — consent + suppression are re-checked when the message is
sent, not just at signup (contract; A1/A6 own the mechanism). Legal specifics
(CAN-SPAM 16 CFR Part 316; GDPR/ePrivacy prior consent for EU; CPRA GPC / sharing
opt-out for California) live in `COMPLIANCE.md` (A1); the console simply reflects
them.

---

## 7. Data sources — RPC/table contract (hand-off to A2/A5)

The console reads through RLS-scoped selects and writes exclusively through
`SECURITY DEFINER` RPCs that re-check `is_business_manager` + subscription (per
the contract's mutation convention). Signatures below are the **shape the UI
needs**; A2/A5 own the authoritative definitions. Anything marked **REQUEST** is
new surface to add.

| Component / screen | Read | Write | Owner |
| --- | --- | --- | --- |
| `CampaignList` | `list_campaigns(business_id)` → `AdCampaign[]` (or RLS select) | — | A5/A2 |
| `CampaignBuilder` | — | `create_campaign_draft(business_id, type)` → id; `update_campaign_draft(campaign_id, patch)`; `submit_campaign_for_review(campaign_id)` | A5 |
| `ReachEstimator` / `AudienceExplorer` | `campaign_reach_estimate(business_id, target)` → `{count, floored}` **(scalar only)** | — | A5 (wraps A3 eligibility) |
| region typeahead | `list_advertiser_regions()` → `{region, coarse_geog}[]` (regions with opted-in users) **REQUEST to A3** | — | A3 |
| `SegmentSelect` | `list_advertiser_segments(business_id)` → advertiser-selectable `user_segments` **REQUEST to A3/A11** | — | A3/A11 |
| `CreativeEditor` image | — | upload to manager-scoped public path (see note) | A13/A6 |
| `FeaturedSlotPicker` | `list_featured_availability(region, surface, window)` | `reserve_featured_slot(campaign_id, slot)` → `featured_placements` row | A7/A5 |
| `NewsletterSlots` | `list_open_newsletter_slots()` → upcoming `newsletter_editions` + open slots | `reserve_newsletter_slot(campaign_id, edition_id)` | A8/A5 |
| `EntitlementMeter` / `BillingPlan` | `entitlement_usage(business_id)` → `Entitlement[]`; existing `subscriptions` read | — | A9/A5 |
| `CampaignMetrics` | `campaign_metrics(campaign_id)` → `CampaignAggregate` **(grouped counts only)** | — | A5/A6 |

**Storage note (creative images).** Email creatives need a **publicly reachable**
image URL. Two viable paths, decision handed to A13/A6:
(a) reuse Supabase Storage with a new **public** bucket `campaign-creatives` and
the existing upload pattern (`supabase.storage.from(bucket).upload(path, file)`,
`getPublicUrl`), with RLS requiring the first path segment to equal
`business_id` and the caller to be a manager of it (mirrors the review-photo
`userId/…` convention in `photos.ts`); or
(b) upload to **Cloudflare R2** (the contract's static-asset store) via a
signed-upload edge function, returning the R2 public URL. Path convention either
way: `campaign-creatives/{business_id}/{uuid}.{ext}`. Recommend (a) for parity
with the shipped photo pipeline, optionally fronted by R2/CDN later (A13).

**Query keys to add** (to `src/lib/queryClient.ts`): `campaigns(businessId)`,
`campaign(campaignId)`, `campaignMetrics(campaignId)`,
`reachEstimate(businessId, targetHash)`, `entitlements(businessId)`,
`featuredAvailability(businessId, region, surface)`,
`newsletterSlots()`, `advertiserRegions()`.

**Types to add to `src/types/db.ts`** (A2): `AdCampaign`, `AdCampaignStatus`
(`'draft'|'pending_review'|'approved'|'running'|'paused'|'done'|'rejected'`),
`AdCampaignType` (`'email_blast'|'featured'`), `CampaignSend`,
`FeaturedPlacement`, `FeaturedSurface`, `NewsletterEdition`, `PlanFeature` /
`Entitlement`, plus the `Creative` and `CampaignAggregate` view shapes above.

**Model reconciliation notes for A2/A8.** The canonical `ad_campaigns.type` is
`('email_blast'|'featured')` and `featured_placements.surface` is
`('map'|'browse'|'detail')`. The console's third "type" (**newsletter feature**)
is UX sugar over the newsletter model: either (i) a `featured_placements` row
whose surface is `'newsletter'` tied to a `newsletter_edition`
(**REQUEST to A2: extend `surface` to include `'newsletter'`**), or (ii) a
dedicated `newsletter_slots` reservation owned by A8. The builder treats it as a
distinct type in the UI regardless; defer the storage decision to A2/A8. No
parallel campaign table is introduced here.

---

## 8. Visual language mapping (match the existing app)

Everything reuses the shipped token system in `src/index.css` — no new colors.

- **Page frame**: `mx-auto max-w-4xl px-4 py-8`; section headers
  `text-2xl font-semibold text-app` with a `text-sm text-muted` subhead (as in
  `BusinessSettings`/`BusinessAnalytics`). Marketing-flavored headers (e.g. the
  Audience explorer intro) may use `font-display` + `text-gradient` like
  `ForBusiness`, used sparingly.
- **Cards**: `.card` / `rounded-xl border border-app bg-raised p-5`; hover-lift
  `.card-hover` on the type-picker tiles.
- **KPIs**: reuse `BusinessAnalytics`'s `Kpi` (label uppercase `text-muted`, big
  `text-2xl font-bold text-app`, hint).
- **Stepper**: reuse `CsvImport`'s numbered-pill `ol` (active
  `border-flush-500 bg-flush-500/10 text-flush-600`).
- **Buttons**: `Button` — `primary` for the main action, `secondary` for Back/Try
  again, `ghost`/`danger` where the existing pages use them; `loading` prop for
  async.
- **Chips/status**: the `SUB_CHIP`/`LISTING_CHIP` grammar from `BusinessDashboard`
  (green healthy / amber pending / red rejected / sunken neutral).
- **Meters/bars**: the `bg-sunken` track + `bg-flush-500` fill pattern from
  `BusinessAnalytics`'s `ListingBar`.
- **Map**: `BathroomMap` (already themed, cooperative-gestures in `selectable`
  mode) wrapped as `GeoTargetPicker`.
- **Empty/loading/error**: the exact triad already used across `business/*` —
  friendly empty `.card`, "Loading…" or animate-pulse skeletons, red line +
  `secondary` "Try again".
- **A11y**: keep the app's standards — `:focus-visible` ring (global), color is
  never the sole signal (numbers + labels on every chart/meter/pin), reach counts
  in `aria-live` regions, form errors as `role="alert"`, status ticks as
  `role="status"`.
- **Dark mode**: automatic — all tokens already resolve per theme; no component
  hard-codes hex outside the map pins (which follow `BathroomMap`'s own scheme).

---

## 9. State matrix (quick reference)

| Component | empty | loading | error | domain states |
| --- | --- | --- | --- | --- |
| `CampaignList` | "No campaigns yet" card + create (mgr) | row skeletons | red + Try again | status chips per row |
| `CampaignBuilder` | n/a (starts at Step ①) | resume-draft skeleton | inline autosave/submit error (+403 friendly) | draft · submitting · entitlement-exhausted |
| `ReachEstimator` | "Choose a region" | number shimmer | "couldn't estimate" + retry | result · below-floor |
| `FeaturedSlotPicker` | "No inventory here yet" | calendar skeleton | red + Try again | available · taken · at-cap · reserved |
| `CreativeEditor` | placeholder preview | image uploading | upload/validation inline | editing · disabled (staff) |
| `EntitlementMeter` | "No active plan" + upgrade | bar skeletons | "usage unavailable" (non-blocking) | ok · near-limit · at-limit |
| `CampaignMetrics` | "Not submitted yet" | KPI skeletons | red + Try again | pending · rejected · approved · running · paused · done |

---

## 10. Open requests to other agents

- **A2** — add campaign/entitlement types to `db.ts` (§7); RLS so members can
  read their business's `ad_campaigns`/`campaign_sends` **aggregates**, managers
  can write drafts; decide the newsletter surface value (§7 reconciliation).
- **A3** — `list_advertiser_regions()` (coarse regions with opted-in users);
  the eligibility query behind `campaign_reach_estimate`; the k-anonymity floor
  value and its config home.
- **A5** — the campaign RPCs (`create/update/submit`, `campaign_reach_estimate`,
  `campaign_metrics`, `reserve_featured_slot`, `reserve_newsletter_slot`),
  entitlement counting, and where/when the entitlement is *consumed* (draft vs.
  approved vs. sent).
- **A6** — expose the branded email template as a shared render function/skeleton
  so `EmailPreview` matches the real send exactly; confirm the locked footer
  fields and any link/open tracking that feeds `CampaignMetrics.clicks`.
- **A7** — featured-slot inventory/availability shape + the optional `circle`
  overlay prop (or blessing for the wrapper) on `BathroomMap`.
- **A8** — newsletter editions + open-slot listing and the reservation model.
- **A9** — `entitlement_usage` mapping and the Billing upgrade copy/CTA; per-tier
  feature keys the meters read.
- **A1** — final disclosure copy for §6.2/§6.3/§6.4 and the exact k-anonymity
  floor; confirm the console never surfaces anything below aggregate.
- **A11** — the admin approval queue that consumes `pending_review` campaigns and
  writes the rejection reason the console reads back from `moderation_actions`.
- **A13** — creative-image storage/CDN decision (§7 storage note).
- **A14** — route/shell wiring; whether to re-parent existing business pages under
  `BusinessLayout` now or later.
```
