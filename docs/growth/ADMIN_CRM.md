# A11 — Admin CRM Console (UX & component spec)

**Summary.** This is the single admin-only surface where raw coarse user location,
consent status, saved segments, and campaign approvals live. It extends the
existing `/admin/*` console (same tab shell, same design tokens) with six new
sections gated by `RequireRole role="admin"` in routing **and** `is_admin()` in
RLS. Advertisers never reach any of it; they see aggregate reach only, in their
own console (A10).

**Dependencies.** Relies on: `DATA_MODEL.md` (A2 — tables, RLS, the admin RPC
surface below), `COMPLIANCE.md` (A1 — consent/GPC, retention, CAN-SPAM), `LOCATION.md`
(A3 — IP→coarse-region, segmentation fields), `ANALYTICS.md` (A4 — dashboards this
embeds), `CAMPAIGNS.md` (A5 — the campaign state machine this moderates),
`EMAIL_DELIVERY.md` (A6 — suppression/bounce/complaint/deliverability feeds),
`INAPP_ADS.md` (A7 — featured-slot allocation rules), `ABUSE_AND_LIMITS.md` (A12 —
k-anonymity floor, frequency caps), `ADVERTISER_CONSOLE.md` (A10 — the aggregate-only
mirror). This doc owns the **admin UX + components**; it defers each domain's depth
to its owner and only defines the seams it needs.

---

## 0. Scope & non-goals

**In scope:** the admin-facing UX and components for CRM, segments, campaign
approval, featured inventory, email health, and analytics; the sensitive-data
boundary and its audit; the routing/role split.

**Out of scope (deferred, referenced only):** the schema DDL and RLS policy text
(A2), how coarse region is derived (A3), the campaign state machine transitions
(A5), send-time consent/suppression/frequency enforcement (A1/A5/A6), chart
internals (A4), featured allocation fairness (A7/A12). Where this doc names an RPC
or column not in the canonical model, it is written as **REQUEST TO A2** rather
than invented as a parallel design.

---

## 1. Where it lives, and the moderator vs admin split

The console already exists at `/admin` behind `<RequireRole>` (default
`moderator`), with a tab bar in `AdminLayout` that conditionally renders
admin-only tabs via `{isAdmin && <Tab .../>}`. We keep that shape exactly.

**The split is a policy line, not just a UI one:**

| Concern | Role | Rationale |
| --- | --- | --- |
| Reports, Reviews, Bathrooms (content moderation) | **moderator** | Content safety. Already built. Unchanged. |
| Business requests, Claims, Roles | **admin** | Already admin-only. Unchanged. |
| **Users/CRM, Segments, Campaign approvals, Featured inventory, Email health, Analytics** | **admin** | Raw coarse location + consent + who-signed-in-where + marketing targeting are the app's most sensitive data. Moderators moderate content; they do **not** get the marketing/PII surface. |

Content moderation stays moderator because it is about *what users post*. The CRM
is about *who users are and where they signed in* — a different trust tier. A
moderator who is not also an admin sees the first three tabs and nothing new.

### 1.1 `RequireRole` — no change needed, just used

`RequireRole` already accepts `role="admin"` and re-checks nothing itself — it
gates only what the router renders; every read/write is independently gated by
RLS and by `is_admin()` inside each RPC. So the CRM needs **zero** changes to
`src/auth/RequireRole.tsx`. We simply wrap the new routes with it.

If A2/A12 later introduces a finer capability (e.g. a `crm_analyst` who can view
segments but not export users), the clean extension is to widen `RequireRole`'s
`role` union and add the check in `AuthProvider` — noted as a future seam, not
built now.

### 1.2 Router block (extends the `/admin` children in `src/router.tsx`)

```tsx
// inside the existing { path: '/admin', element: <RequireRole><AdminLayout/></RequireRole>, children: [...] }
// moderator-visible (unchanged): reports, reviews, bathrooms
// admin-only additions — each wrapped so a deep link from a moderator bounces to '/':
{
  path: 'crm',
  element: (<RequireRole role="admin"><AdminCrm /></RequireRole>),
},
{
  path: 'segments',
  element: (<RequireRole role="admin"><AdminSegments /></RequireRole>),
},
{
  path: 'campaigns',
  element: (<RequireRole role="admin"><AdminCampaignApprovals /></RequireRole>),
},
{
  path: 'featured',
  element: (<RequireRole role="admin"><AdminFeatured /></RequireRole>),
},
{
  path: 'email-health',
  element: (<RequireRole role="admin"><AdminEmailHealth /></RequireRole>),
},
{
  path: 'analytics',
  element: (<RequireRole role="admin"><AdminAnalytics /></RequireRole>),
},
```

### 1.3 `AdminLayout` tab bar (extends the existing `<nav>`)

Append after the existing admin-only tabs, keeping the `{isAdmin && …}` guard and
the same `<Tab>` component. Group them under a subtle divider so the growth
surface reads as its own cluster:

```tsx
{isAdmin && <Tab to="/admin/crm" label="Users / CRM" />}
{isAdmin && <Tab to="/admin/segments" label="Segments" />}
{isAdmin && <Tab to="/admin/campaigns" label="Campaign approvals" />}
{isAdmin && <Tab to="/admin/featured" label="Featured" />}
{isAdmin && <Tab to="/admin/email-health" label="Email health" />}
{isAdmin && <Tab to="/admin/analytics" label="Analytics" />}
```

The tab bar already has `overflow-x-auto`, so twelve tabs scroll horizontally on
narrow screens without a redesign. A pending-campaign count badge on the
"Campaign approvals" tab reuses the pattern already used for open access requests
(`queryKeys.openAccessRequestCount`) — see §5.

---

## 2. The sensitive-data boundary (the core of this console)

Everything below is a hard boundary, not a preference. It is why the CRM is
admin-only and why it looks the way it does.

### 2.1 Coarse region only — there is nothing finer to leak

Per the owner's binding decision and A3, location is **approximate city / region /
country derived from IP at sign-in**. There is **no device GPS, no street address,
no precise real-time position** anywhere in the system, so there is nothing finer
for the CRM to display or leak. The user detail view shows, at most:

- `ip_city`, `ip_region`, `ip_country` (e.g. "Waterloo, Ontario, CA")
- a city-centroid point (`geog`) used only to render a coarse map dot / do
  city-granularity "near" targeting — never a precise pin.

The UI must never render a user's location at higher-than-city zoom, and must
label it "Approximate (from sign-in IP)" so no admin mistakes it for a live
position. "Radius / near me" targeting in the segment builder and campaign
targeting operates at **city/region granularity** — the radius control snaps to
region centroids, not arbitrary coordinates (A3 owns the geometry).

### 2.2 Who-signed-in-where log, with retention

`user_locations` is an append log: one coarse row per sign-in (source = 'signin').
The user detail drawer shows this as a short **"Recent sign-in regions"** list
(city + date, newest first), bounded by retention. Retention is A1/A3's call; the
UI assumes rows older than the retention window are already purged by a pg_cron
job and simply renders what RLS returns. Proposed default to confirm with A1:
**180 days** of sign-in-location history, then hard delete. The drawer states the
window inline ("Sign-ins in the last 180 days") so the boundary is legible to the
admin, not hidden.

### 2.3 Admin views of user data are themselves logged

This is the part that makes the boundary trustworthy: **looking is an action, and
actions are audited.** Reads of individual user data flow through `SECURITY
DEFINER` RPCs (not raw table selects), and those RPCs write an audit row in the
same transaction — matching the existing pattern where "every removal, restore,
and role change here is written to the audit log" (AdminLayout's own subtitle).

Audit granularity is chosen to be useful without flooding the log:

| Admin action | Audited? | `moderation_actions` row |
| --- | --- | --- |
| Run a CRM filter/search | Yes, once per query | `action='crm_search'`, `detail={ filters, result_count }` — **no individual user ids** |
| Open one user's detail drawer (reveals region history + email) | Yes | `action='crm_user_view'`, `target_type='user'`, `target_id=<user_id>` |
| Reveal a masked email | Yes | `action='crm_email_reveal'`, `target_id=<user_id>` |
| Preview a segment size | No (aggregate only, no PII) | — |
| Save/delete a segment | Yes | `action='segment_create'` / `'segment_delete'`, `detail={ name, predicate }` |
| Approve/reject a campaign | Yes | `action='campaign_review'`, `target_id=<campaign_id>`, `detail={ decision, reason, checklist }` |
| Suppress/unsuppress an email | Yes | `action='email_suppress'` / `'email_unsuppress'`, `detail={ reason }` |
| Allocate/release a featured slot | Yes | `action='featured_allocate'` / `'featured_release'`, `target_id=<placement_id>` |

The CRM surfaces its own audit trail read-only at the bottom of the user drawer
("Admin views of this user" — who looked, when) so an admin can see that their
peers' access is recorded too. This is the deterrent that makes admin-only
meaningful.

> **REQUEST TO A2:** add these `action` values to the `moderation_actions` action
> vocabulary (it already has `detail jsonb`). If per-view CRM audit volume is a
> concern at scale, consider a dedicated `admin_access_log` table with its own
> retention (A13's cost lens); the CRM code is indifferent to which table backs
> the audit as long as an RPC writes it transactionally. Default: reuse
> `moderation_actions`.

### 2.4 Why this is admin-only, and how RLS enforces it

**Why admin-only:** raw coarse location + consent state + sign-in history is
exactly the data whose misuse (re-identification, unwanted targeting, selling
individual profiles) the whole "consent-first, coarse-only, no ad networks" pivot
promises to prevent. Advertisers are customers, not staff; they get *aggregate
reach counts* to plan spend, never a user list. Moderators are content staff, not
marketing staff. So the blast radius is deliberately one role: `admin`.

**How RLS enforces it (defense the router cannot provide):**

- `user_locations`, `user_consents`, `user_segments`, `segment_members`,
  `campaign_sends`, `email_suppressions`, `analytics_events` carry admin-only (or
  self-only) RLS. The location log policy is, in the codebase's initplan style:

  ```sql
  -- user_locations: only admins may read the coarse location log.
  create policy user_locations_admin_read on public.user_locations
    for select using ((select public.is_admin()));
  -- (no insert/update/delete policy for clients; writes are SECURITY DEFINER only)
  ```

- Every CRM **mutation and every individual-user read** goes through a `SECURITY
  DEFINER` RPC that begins with `if not (select public.is_admin()) then raise
  exception 'not authorized'; end if;`, runs with `set search_path = ''`, and
  writes the audit row. So even if a moderator forged the client and called the
  RPC, it raises before touching data.
- Advertisers authenticate as ordinary users with `business_members` rows and
  **no `user_roles` admin row**, so `is_admin()` is false → RLS denies every CRM
  table and every CRM RPC. The advertiser console (A10) reads only aggregate
  functions (e.g. `estimate_reach(region, segment)` returning a bare count) that
  never emit user rows — a separate, narrower surface.
- The React `RequireRole` guard and `{isAdmin && …}` tabs are **cosmetic**: they
  keep a non-admin from seeing a broken shell. The real boundary is in Postgres.
  Bypassing the client "buys an attacker a blank admin shell and nothing more"
  (RequireRole's own doc comment).

---

## 3. Navigation & page shells

All six pages render inside the existing `AdminLayout` `<Outlet />`, so they
inherit the `max-w-5xl` column, the header ("Signed in as @… Every … is written
to the audit log."), and the tab bar. Each page is a plain section stack using
the app tokens already in use across `AdminReports`/`BusinessAnalytics`:

- Cards: `rounded-xl border border-app bg-raised p-4`
- Inset panels: `rounded-lg border border-app bg-sunken p-3`
- Muted meta: `text-xs text-muted`; body: `text-sm text-app`
- Brand accents: `text-flush-600` links, `border-flush-500` active/selected,
  `bg-flush-500/10 text-flush-600` "good" pills, `bg-red-500/10 text-red-500`
  "warn" pills (the `Flag` pattern from `BusinessAnalytics`)
- KPI tiles: the `Kpi` card pattern from `BusinessAnalytics` (label uppercase
  tracking-wide muted, big `text-2xl font-bold`, optional hint)
- Loading: skeleton `animate-pulse` blocks; Error: red line + `Button
  variant="secondary" size="sm"` "Try again"; Empty: centered card ("No … yet").

Data access uses `@tanstack/react-query` with keys added to the central
`queryKeys` map so invalidation after a mutation can't miss a cache entry —
matching `src/lib/queryClient.ts`. New keys:

```ts
// add to queryKeys in src/lib/queryClient.ts
crmUsers: (filtersHash: string) => ['admin', 'crm', filtersHash] as const,
crmUser: (userId: string) => ['admin', 'crm', 'user', userId] as const,
segments: () => ['admin', 'segments'] as const,
segmentPreview: (predHash: string) => ['admin', 'segmentPreview', predHash] as const,
pendingCampaigns: () => ['admin', 'campaigns', 'pending'] as const,
pendingCampaignCount: () => ['admin', 'campaigns', 'pendingCount'] as const,
featuredSlots: (region: string, weekIso: string) => ['admin', 'featured', region, weekIso] as const,
emailHealth: (rangeIso: string) => ['admin', 'emailHealth', rangeIso] as const,
suppressions: (q: string) => ['admin', 'suppressions', q] as const,
```

New API wrappers live in `src/lib/api/crm.ts`, `campaignsAdmin.ts`,
`emailHealth.ts` and are re-exported from `src/lib/api/index.ts`, mirroring how
`moderation.ts` wraps its RPCs ("thin wrappers over SECURITY DEFINER RPCs … the
React layer here is only ergonomics — it enforces nothing").

---

## 4. Section: Users / CRM (`/admin/crm`)

The list of users with **consent status + coarse region + activity**, filterable
and segmentable.

**Layout.** A filter bar (left/top) + a `CrmUserTable` + a right-side/overlay
**user detail drawer** opened on row click. On mobile the drawer is a full-screen
sheet.

**Filter bar controls** (compose into the segment predicate of §6 so a filtered
view can be saved as a segment in one click):
- Region: multi-select of `ip_region` / `ip_city` values (typeahead; A3 provides
  the region vocabulary).
- Marketing consent: All / Opted in / Not opted in.
- Location consent: All / Opted in / Not opted in.
- Activity: active within {7, 30, 90} days / inactive.
- Has reviews: any / ≥1.
- GPC: any / GPC-signaled.
- Free-text: username prefix (never email — email is not a filter input; it is
  PII revealed only in the audited drawer).

**Table columns** (`CrmUserTable`, §7.1): username (+ avatar), consent
(two pills: Marketing / Location, green when on, muted when off, plus a GPC chip),
coarse region ("Waterloo, ON"), last active (relative), reviews (count), joined
(relative). **No email column** — email is masked/absent in the list; revealing it
is a per-user audited action inside the drawer.

**"Save as segment"** button takes the current filter set to the Segment builder
(§6) pre-populated, so segmentation is the natural next step from a filtered list.

**User detail drawer** (opening it fires `crm_user_view` audit — §2.3):
- Identity: username, avatar, joined date, role badges (if any). Email shown
  **masked** (`g•••@gmail.com`) with a "Reveal" button that fires
  `crm_email_reveal` and un-masks in place.
- Consent block: marketing/location opt-in state, `gpc_detected`, `source`,
  `consent_updated_at` — read from `user_consents`. Read-only here; consent is the
  user's to change (admins never opt a user in).
- **Recent sign-in regions**: the retention-bounded `user_locations` list (§2.2),
  each row "Waterloo, ON · Jul 3" with an "Approximate (sign-in IP)" caption.
  Never a precise map.
- Activity: last N `analytics_events` summarized (reviews posted, bathrooms
  added, last seen) — from A4, aggregate per user, no PII in props.
- Marketing history: recent `campaign_sends` to this user (subject, date, status)
  + current suppression state (if suppressed, a red banner "Globally suppressed —
  will not receive marketing").
- **Admin access trail**: "Admin views of this user" — the `crm_user_view` /
  `crm_email_reveal` audit rows for this user (who, when). This closes the loop
  from §2.3.

**States:** loading (skeleton rows), error (retry), empty ("No users match these
filters."), paginated list (cursor via `p_offset`/`p_limit`).

---

## 5. Section: Campaign approvals (`/admin/campaigns`)

The moderation queue for advertiser campaigns — see §5.1 for the full moderation
spec and §7.3 for the component. A tab badge shows the pending count
(`pendingCampaignCount`), refetched on the same cadence as the access-request
count already in the layout.

### 5.1 Campaign moderation

A campaign arrives here when the advertiser submits it and A5 sets
`ad_campaigns.status = 'pending_review'`. The queue lists those; each is a
`CampaignApprovalQueue` card showing, top to bottom:

1. **Advertiser** — business name, plan tier (from `subscriptions`/`plans`), and a
   link to the business.
2. **Type** — pill: "Email blast" or "Featured placement".
3. **Target + estimated reach** — target region (or named segment), radius (at
   **city granularity**), and an **estimated reach count** (aggregate, from A3/A5's
   `estimate_reach`). If the target segment resolves to fewer than the
   k-anonymity floor **K (default 30, A12)**, reach shows "fewer than 30" and
   approval is blocked — you cannot micro-target a re-identifiable cohort.
4. **Schedule** — `starts_at`/`ends_at`, `frequency_per_week` (must be ≤ the
   platform cap, default **3 per 7 days**; shown pass/fail).
5. **Creative preview** — subject, rendered-but-sandboxed body (links disabled /
   shown as text; images from R2 only), and the destination link with its host
   surfaced for inspection. For featured: the in-app card as it will appear on
   `map`/`browse`/`detail` surfaces (A7 mock).
6. **Entitlement check** — automatic pass/fail chips against `plan_features`:
   within `blasts_per_month` / `featured_per_week` / target size for the plan. A
   fail disables Approve (the plan doesn't allow it; the advertiser must upgrade).
7. **Policy checklist** — interactive checkboxes the admin must satisfy before
   Approve enables (§5.2).
8. **Actions** — **Approve** (`primary`, disabled until required checklist items
   are ticked and all automatic checks pass), **Reject** (`ghost`/red, requires a
   reason textarea — the reason is returned to the advertiser in A10), and
   optionally **Send back for changes** (returns to `draft` with a note).

### 5.2 Policy checklist (CAN-SPAM + content policy)

Required items (must all be checked to enable Approve); the list is data-driven so
A1 can amend wording:

- [ ] **Honest offer** — no deceptive or misleading claims; subject line and
  "from" identity are not deceptive (CAN-SPAM prohibits deceptive headers/subject
  lines).
- [ ] **Legal** — no illegal goods/services or prohibited categories.
- [ ] **No adult / hateful / violent content.**
- [ ] **Advertiser identity clear** — the sender is identifiable and a valid
  physical postal address is present (CAN-SPAM requires it; A6 injects it, admin
  confirms it renders).
- [ ] **Unsubscribe present & functional** — one-click unsubscribe link present
  (A6 injects a working `unsubscribe_token`; admin confirms it's there).
- [ ] **Targeting respects coarse-only + K floor** — no attempt to narrow below
  the k-anonymity floor; region granularity only.
- [ ] **Link destination safe** — https, not a known-malware/phishing host; on the
  allowlist if A12 maintains one.

Automatic (rendered as read-only pass/fail chips, not checkboxes): plan
entitlement, frequency cap, segment size ≥ K, creative assets load.

### 5.3 Decision → A5 state machine

The admin decision is the moderation transition A5 owns; this console is just the
entry point. Mapping:

| Admin action | `ad_campaigns.status` transition | Side effects |
| --- | --- | --- |
| Approve | `pending_review → approved` | A5 schedules; when live it moves `approved → running`. Audit `campaign_review` (decision=approve, checklist snapshot). |
| Reject | `pending_review → rejected` | Reason stored on campaign, shown to advertiser (A10). Audit `campaign_review` (decision=reject, reason). |
| Send back | `pending_review → draft` | Note to advertiser; they can edit and resubmit. Audit. |

The transition itself is performed by A5's RPC (a single `admin_review_campaign`
that A5 defines and that re-checks `is_admin()`, validates the from-state is
`pending_review`, enforces entitlement/frequency/K server-side — never trusting
the client checklist — and writes the audit row). This console calls it; A5 owns
its body. **Depth of the state machine lives in `CAMPAIGNS.md`.**

---

## 6. Section: Segments (`/admin/segments`) + Segment builder UX

Lists saved `user_segments` (name, predicate summary, last-previewed size, created
by/at, "used by N campaigns") and hosts the **`SegmentBuilder`** (§7.2) to create
or edit one.

### 6.1 Predicate model

A segment is a saved, named predicate over the **consented, eligible** user
population. Stored as `user_segments.predicate jsonb`:

```jsonc
{
  "match": "all",            // "all" (AND) | "any" (OR)
  "rules": [
    { "field": "region",             "op": "in",  "value": ["Waterloo", "Kitchener"] },
    { "field": "marketing_opt_in",   "op": "eq",  "value": true },
    { "field": "active_within_days", "op": "lte", "value": 30 },
    { "field": "review_count",       "op": "gte", "value": 1 }
  ]
}
```

**Available fields** (each maps to a canonical source; A3 owns the region/activity
derivations):

| Field | Source | Ops |
| --- | --- | --- |
| `region` / `city` / `country` | latest `user_locations` row | `in`, `not_in` |
| `marketing_opt_in` | `user_consents` | `eq` |
| `location_opt_in` | `user_consents` | `eq` |
| `gpc_detected` | `user_consents` | `eq` |
| `active_within_days` | last `analytics_events` / sign-in | `lte`, `gte` |
| `review_count` | reviews rollup | `gte`, `lte`, `eq` |
| `account_age_days` | `profiles.created_at` | `gte`, `lte` |

**Consent is not a predicate override.** A segment is a *targeting set*. Even a
segment with `marketing_opt_in = false` in it (which the UI discourages) can never
result in a marketing send — consent + suppression + frequency are re-checked **at
send time** by A1/A5/A6, independent of the segment. The builder shows a warning if
a segment used for an email campaign would target non-opted-in users ("These users
won't receive marketing regardless — remove or they'll silently drop at send").

### 6.2 Builder UX (compose → preview → save)

1. **Compose** — rule rows, each: a field `<select>`, an op `<select>`, and a
   value control that switches on field type (region → multi-select typeahead;
   booleans → toggle; numbers → number input). "Add rule" appends a row; a
   match-mode toggle picks AND/OR. (No `Select` primitive exists yet — see §8;
   until then use native `<select>` styled with Field's `CONTROL` class.)
2. **Preview aggregate size** — "Preview reach" button calls
   `admin_preview_segment(predicate)` → a single count. Displayed as a `Kpi`-style
   tile: "≈ 4,210 users match". **K-anonymity floor:** if the count `< K` (default
   30, A12), show "fewer than 30 — too small to target" in the warn tone and flag
   the segment; segments below K may be *saved* but are *blocked from campaign
   targeting* at approval (§5.1). This preview is aggregate-only, so it is **not**
   audited (§2.3).
3. **Save** — name input + Save → `admin_save_segment(name, predicate)`; audited
   `segment_create`. Returns to the list.

Segments feed campaign targeting: A5's campaign builder (in A10's advertiser
console) picks a `segment_id`, and the approval queue (§5) shows the resolved
reach. Segments are an **admin-authored** targeting vocabulary — advertisers pick
from admin-approved segments or region + radius; they cannot author raw predicates
(that would leak the field vocabulary and enable probing). This is a deliberate
boundary: **segment authoring is admin-only; segment *selection* is offered to
advertisers as opaque named audiences with only an aggregate size.**

---

## 7. Component specs

All components: TypeScript, function components, react-query for I/O, `Button` and
Field primitives, app tokens, the four render states (loading skeleton / error+retry
/ empty / populated). RPCs are thin wrappers in `src/lib/api/*` over `SECURITY
DEFINER` RPCs that A2 formalizes (each re-checks `is_admin()`, sets empty
search_path, and writes audit rows as noted).

### 7.1 `CrmUserTable`

```ts
interface CrmFilters {
  regions?: string[];
  marketingOptIn?: boolean | null;   // null = any
  locationOptIn?: boolean | null;
  activeWithinDays?: 7 | 30 | 90 | null;
  hasReviews?: boolean | null;
  gpc?: boolean | null;
  usernamePrefix?: string;
}

interface CrmUserRow {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  marketing_opt_in: boolean;
  location_opt_in: boolean;
  gpc_detected: boolean;
  ip_city: string | null;
  ip_region: string | null;
  ip_country: string | null;      // coarse only — no finer field exists
  last_active_at: string | null;  // ISO
  review_count: number;
  joined_at: string;
  is_suppressed: boolean;
  // NOTE: email is intentionally absent from the list row; it is fetched only
  // in the detail drawer via an audited reveal.
}

interface CrmUserTableProps {
  filters: CrmFilters;
  onOpenUser: (userId: string) => void;   // opens the audited detail drawer
  pageSize?: number;                        // default 50
}
```

- **RPC:** `admin_search_users(p_filters jsonb, p_limit int, p_offset int) →
  setof CrmUserRow`. Audits one `crm_search` row per call with the filter summary
  and `result_count` (no user ids). Wrapper: `searchCrmUsers(filters, {limit,
  offset})` in `src/lib/api/crm.ts`.
- **Query key:** `queryKeys.crmUsers(hash(filters)+':'+offset)`.
- **Rendering:** desktop = a `<table>` inside an `overflow-x-auto` container
  (horizontal scroll, never body scroll); mobile = stacked `rounded-xl border
  border-app bg-raised` cards (the existing list idiom). Consent as two pills
  (green `bg-flush-500/10 text-flush-600` on, muted on off) + a GPC chip.
- **States:** loading → skeleton rows (`animate-pulse`); error → red line +
  "Try again"; empty → centered card "No users match these filters."; populated →
  rows + "Load more" (offset paging).

### 7.2 `SegmentBuilder`

```ts
type RuleField =
  | 'region' | 'city' | 'country'
  | 'marketing_opt_in' | 'location_opt_in' | 'gpc_detected'
  | 'active_within_days' | 'review_count' | 'account_age_days';
type RuleOp = 'in' | 'not_in' | 'eq' | 'gte' | 'lte';

interface SegmentRule { field: RuleField; op: RuleOp; value: unknown; }
interface SegmentPredicate { match: 'all' | 'any'; rules: SegmentRule[]; }

interface SegmentDraft {
  id?: string;                 // present when editing an existing segment
  name: string;
  predicate: SegmentPredicate;
}

interface SegmentBuilderProps {
  initial?: SegmentDraft;                 // e.g. prefilled from "Save as segment"
  onSaved: (segment: { id: string; name: string; size: number | null }) => void;
  onCancel?: () => void;
}
```

- **RPCs:**
  - `admin_preview_segment(p_predicate jsonb) → { size int, below_floor bool }`
    (aggregate only; not audited). Wrapper: `previewSegment(predicate)`.
  - `admin_save_segment(p_id uuid|null, p_name text, p_predicate jsonb) → uuid`
    (audited `segment_create`). Wrapper: `saveSegment(draft)`.
- **Query key:** preview memoized on `queryKeys.segmentPreview(hash(predicate))`
  with a short `staleTime` so re-previewing the same predicate is a cache hit.
- **States:** `editing` → `previewing` (button spinner) → `preview-ready`
  (Kpi tile with size, or warn "fewer than 30 — too small to target" when
  `below_floor`) → `saving` → `saved` (calls `onSaved`) / `error` (red line).
  Save is allowed below the floor but the returned `size`/flag lets the list mark
  it "not targetable".
- **Note:** value control switches on field type; region uses a typeahead
  multi-select over A3's region vocabulary.

### 7.3 `CampaignApprovalQueue`

```ts
interface PendingCampaign {
  id: string;
  business: { id: string; name: string; plan: string };
  type: 'email_blast' | 'featured';
  target: {
    region: string | null;
    radius_km: number | null;     // city-granularity only
    segment_id: string | null;
    segment_name: string | null;
  };
  estimated_reach: number;        // aggregate; may be shown as "<30" when below floor
  below_k_floor: boolean;
  starts_at: string;
  ends_at: string;
  frequency_per_week: number;
  creative: { subject: string | null; body: string | null; image_url: string | null; link: string | null };
  entitlement: { ok: boolean; reasons: string[] };   // plan/frequency/size checks
  submitted_at: string;
}

interface CampaignApprovalQueueProps {
  // self-contained; optional status override for a future "rejected"/"all" view
  status?: 'pending_review';
}
```

- **RPCs:**
  - `admin_list_pending_campaigns() → setof PendingCampaign` (join businesses,
    plans, `estimate_reach`). Wrapper: `listPendingCampaigns()`.
  - `admin_review_campaign(p_campaign_id uuid, p_decision text, p_reason text,
    p_checklist jsonb) → void` — **A5 owns the body**; transitions state,
    re-validates entitlement/frequency/K server-side, audits `campaign_review`.
    Wrapper: `reviewCampaign(id, decision, reason, checklist)`.
- **Query keys:** `queryKeys.pendingCampaigns()`, count via
  `queryKeys.pendingCampaignCount()` for the tab badge.
- **Card internals:** advertiser + plan; type pill; target + reach (`<30` in warn
  tone when `below_k_floor`); schedule with frequency pass/fail chip; sandboxed
  creative preview (links inert, images from R2 only, destination host surfaced);
  entitlement chips (`entitlement.reasons` rendered as red chips when `!ok`);
  interactive policy checklist (§5.2); Approve (`primary`, disabled until required
  checks ticked **and** `entitlement.ok` **and** `!below_k_floor`) / Reject
  (requires reason) / Send back.
- **States:** loading → skeleton cards; empty → "Queue clear. Nice." (echoes the
  Reports empty state); per-card `busy` on submit (mirrors the `verify/reject`
  busy pattern in `AdminClaims`); success → card leaves the list on invalidate;
  error → inline red line, card stays.

### 7.4 `FeaturedInventoryBoard`

```ts
interface FeaturedSlot {
  id: string | null;                 // null = an open slot
  surface: 'map' | 'browse' | 'detail';
  region: string;
  week_start: string;                // ISO date (week bucket)
  campaign_id: string | null;
  business_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: 'open' | 'booked' | 'running' | 'conflict';
}

interface FeaturedInventoryBoardProps {
  region: string;
  weekStart: string;                 // ISO; board shows one week at a time
  capacityPerWeek: number;           // from plan_features / A7 default
}
```

- **RPCs:**
  - `admin_list_featured_slots(p_region text, p_week_start date) → setof
    FeaturedSlot` (from `featured_placements`, computing open vs booked vs
    over-capacity). Wrapper: `listFeaturedSlots(region, weekStart)`.
  - `admin_allocate_featured(p_campaign_id uuid, p_surface text, p_region text,
    p_starts_at, p_ends_at) → uuid` and `admin_release_featured(p_placement_id
    uuid) → void` — **A7 owns allocation fairness/caps**; both audited
    (`featured_allocate` / `featured_release`).
- **Rendering:** a grid — rows = surfaces (map/browse/detail), columns = days of
  the selected week; each cell a slot chip (booked = brand fill + business name,
  open = dashed `border-app bg-sunken`, conflict/over-capacity =
  `border-red-500/40` with a warn `Flag`). A region + week picker sits above. An
  occupancy bar per surface (booked / capacityPerWeek) reuses the `ListingBar`
  CSS-bar idiom from `BusinessAnalytics`.
- **States:** loading skeleton grid; empty ("No featured demand this week for
  {region}."); populated; conflict banner when any cell is `conflict` (exceeds
  `featured_per_week`).

### 7.5 `EmailHealthPanel`

```ts
interface EmailHealthSummary {
  range: { from: string; to: string };
  sent: number;
  delivered: number;
  bounce_rate: number;        // 0..1
  complaint_rate: number;     // 0..1
  unsubscribe_rate: number;   // 0..1
  suppression_count: number;
  deliverability: {           // from A6 / Resend
    spf: 'pass' | 'fail' | 'unknown';
    dkim: 'pass' | 'fail' | 'unknown';
    dmarc: 'pass' | 'fail' | 'unknown';
  };
}

interface SuppressionRow {
  email_masked: string;       // g•••@gmail.com — never full PII in the list
  reason: 'unsubscribe' | 'bounce' | 'complaint' | 'manual';
  since: string;
}

interface EmailHealthPanelProps { rangeDays?: 7 | 30 | 90; }  // default 30
```

- **RPCs:**
  - `admin_email_health(p_from date, p_to date) → EmailHealthSummary` (rolls up
    `campaign_sends` + `email_suppressions` + A6's deliverability signals).
    Wrapper: `getEmailHealth(range)`.
  - `admin_list_suppressions(p_query text, p_limit int) → setof SuppressionRow`,
    `admin_suppress_email(p_email text, p_reason text) → void` (audited
    `email_suppress`), `admin_unsuppress_email(p_email text) → void` (audited
    `email_unsuppress`).
- **Rendering:** a `Kpi` row (Delivered, Bounce %, Complaint %, Unsub %,
  Suppressed) with the bounce/complaint tiles turning warn-tone past A6's
  thresholds (common ESP guidance: keep complaints well under ~0.1% and bounces
  low — A6 pins the exact numbers; the panel just colors against them); a
  deliverability strip (SPF/DKIM/DMARC pass/fail chips); a searchable suppression
  table with masked addresses and an "Add suppression" form + per-row "Remove".
- **States:** loading skeleton KPIs + table; error retry; populated. Suppression
  actions show per-row busy and invalidate `queryKeys.suppressions`.

### 7.6 Analytics section (`/admin/analytics`)

Thin host that embeds **A4's dashboards** gated by `is_admin()`. Two dashboards:
**Product** (signups, DAU/WAU, consent opt-in rate, reviews posted, bathrooms
added — all aggregate, region-segmentable) and **Campaign** (sends, delivered,
unsubscribes, reach delivered per campaign; open/click only if A6 tracks them).
All charts are **aggregate and coarse-region only** — no per-user series. Chart
components, color, and data shape are **owned by `ANALYTICS.md` (A4)**; this page
only lays them out in the admin shell and passes the admin-scoped query context.
Follow the `dataviz` guidance A4 sets; do not re-spec charts here.

---

## 8. Shared UI gaps to add (small, matches existing primitives)

The console needs two primitives the repo doesn't have yet; both should match
`Field.tsx`'s `CONTROL` styling and `Button.tsx`'s variant conventions so they
read as first-party:

- **`Select`** — a labeled native `<select>` wrapper (same `Wrapper` +
  `CONTROL` class as `Input`). Used across filters, segment rules, range pickers.
- **`Badge` / `Pill`** — the `Flag` pattern from `BusinessAnalytics` promoted to a
  shared `components/ui/Badge.tsx` with `tone: 'good' | 'warn' | 'neutral'`.
  Consent pills, type pills, and pass/fail chips all use it.

A **`DataTable`** helper (header + `overflow-x-auto` + skeleton/empty/error slots)
is optional but would DRY up `CrmUserTable`/suppressions/featured. Noted, not
required for v1.

> These are additive UI primitives, not schema — safe for the orchestrator to add
> alongside the pages. No existing component changes.

---

## 9. Consolidated requests to other agents

- **A2 (DATA_MODEL):** formalize the admin RPC surface used here — `admin_search_users`,
  `admin_get_user_crm`, `admin_reveal_user_email`, `admin_preview_segment`,
  `admin_save_segment`, `admin_delete_segment`, `admin_list_featured_slots`,
  `admin_allocate_featured`, `admin_release_featured`, `admin_email_health`,
  `admin_list_suppressions`, `admin_suppress_email`, `admin_unsuppress_email` — all
  `SECURITY DEFINER`, `is_admin()`-gated, `set search_path = ''`, audit-writing.
  Add the `moderation_actions.action` values in §2.3 (or an `admin_access_log`
  table if volume warrants). Confirm admin-only RLS on `user_locations`,
  `user_consents`, `user_segments`, `segment_members`, `campaign_sends`,
  `email_suppressions`. Add `user_segments.last_size int` + `last_previewed_at` so
  the list can show cached reach without re-running the predicate.
- **A5 (CAMPAIGNS):** own `admin_review_campaign` (state transitions
  `pending_review → approved | rejected | draft`), server-side re-validation of
  entitlement/frequency/K, and `estimate_reach`. Confirm the `pending_review`
  entry state and the reason field returned to advertisers.
- **A1 (COMPLIANCE):** confirm `user_locations` retention window (default proposed
  180 days), the CAN-SPAM checklist wording (§5.2), and that admin CRM views are
  in scope for the audit/retention policy.
- **A3 (LOCATION):** provide the region/city vocabulary for filters + segment
  region rules, and confirm city-granularity radius snapping.
- **A4 (ANALYTICS):** own the two admin dashboards embedded in §7.6; expose an
  admin-scoped query context.
- **A6 (EMAIL_DELIVERY):** provide the deliverability signals + bounce/complaint
  thresholds for `EmailHealthPanel`; confirm unsubscribe injection so the checklist
  item is verifiable.
- **A7 (INAPP_ADS):** own featured allocation caps/fairness behind
  `admin_allocate_featured`; provide the per-surface creative mock for the campaign
  preview.
- **A12 (ABUSE_AND_LIMITS):** confirm the k-anonymity floor **K** (default 30) and
  the frequency cap (default 3/7d) the queue and segment preview enforce.
- **A10 (ADVERTISER_CONSOLE):** consume rejection reasons and offer only
  admin-authored segments as opaque named audiences (aggregate size only) — never
  raw predicates or user rows.

---

## 10. Acceptance checklist for the implementer

- [ ] Six routes added under `/admin`, each wrapped in `<RequireRole role="admin">`;
  six `{isAdmin && <Tab/>}` entries appended to `AdminLayout`.
- [ ] No change to `RequireRole.tsx`; moderator sees only the original three tabs.
- [ ] Every individual-user read and every mutation goes through a `SECURITY
  DEFINER`, `is_admin()`-gated RPC that writes an audit row; aggregate previews do
  not audit.
- [ ] No location shown finer than city; every location labeled "Approximate
  (sign-in IP)"; sign-in history bounded by retention.
- [ ] Email never in the list; revealing it is a per-user audited action.
- [ ] Segment preview enforces the K floor; sub-K segments cannot be targeted at
  approval.
- [ ] Campaign Approve is disabled until the policy checklist + automatic
  entitlement/frequency/K checks pass; Reject requires a reason.
- [ ] All new queries keyed through `queryKeys`; all pages match the app tokens
  (`bg-raised`/`bg-sunken`/`border-app`/`text-app`/`text-muted`/`flush-*`) and the
  loading/error/empty idioms already used in `admin/*`.
```
