# In-App Ad Placements (A7)

**Summary.** Watrloo sells three *featured* placements that live inside the
existing product — a featured card in the browse grid, a "Featured nearby" strip
plus elevated pins on the map, and a sponsor slot on the bathroom detail page.
Each is native in look but **clearly labeled as paid**, is selected by *coarse
region + active window*, and **never** alters a listing's real rating or buries
its real reviews. Selection is **contextual** (region-level), so serving an ad
needs no tracking consent; *counting impressions per user* does, and degrades to
anonymous/session counting without it.

**Dependencies:** `COMPLIANCE.md` (A1 — disclosure law, contextual-vs-behavioral
consent line), `DATA_MODEL.md` (A2 — `featured_placements`, `ad_campaigns`, RLS,
the public RPC), `LOCATION.md` (A3 — how a viewer's coarse region is resolved),
`ANALYTICS.md` (A4 — `analytics_events`, impression/click events, consent gating
and the per-user frequency counter), `CAMPAIGNS.md` (A5 — slot-week inventory,
campaign status/scheduling, creative freeze at approval), `PRICING.md` (A9 —
`featured_per_week` entitlements), `ABUSE_AND_LIMITS.md` (A12 — abuse/fairness
policing).

> Design only. No `src/**` or DB changes here. The current app and privacy policy
> stay live and true until the orchestrator implements this. — per GROWTH_CONTRACT.

---

## 1. Principles (read first)

These are non-negotiable and shape every spec below.

1. **The directory stays trustworthy.** A featured placement changes *where* a
   listing appears and adds a *label* + a short promo line. It does **not** touch
   the listing's rating, its review count, or the order/visibility of real
   reviews. Those always come from the same sources everyone else's do
   (`bathroom_stats` view, `listReviewsForBathroom`). A 2-star business can pay to
   be seen; it *cannot* pay to look like a 4-star business.
2. **Every paid unit is labeled.** No exceptions, and never disguised as an
   organic review (see §4).
3. **Contextual, not behavioral.** We pick ads from the *page* and the viewer's
   *coarse region*, not from a profile of the person. This is deliberate — it is
   what lets us serve ads to signed-out and non-consented users lawfully (§3).
4. **Empty is the default.** No matching placement ⇒ render **nothing**, with
   **zero layout shift**. Ads are additive; the product is complete without them.

---

## 2. Surfaces & formats

The canonical `featured_placements.surface` enum is `'map' | 'browse' | 'detail'`
(A2). One format per surface.

### 2.1 Browse grid — `FeaturedCard` (`surface='browse'`)

- **Slot.** The `Home.tsx` grid is `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.
  A featured card occupies **one grid cell**, identical in size to a
  `BathroomCard`, injected at a **fixed low index** (default: position **3** —
  i.e. after the first two organic results, start of row 2 on desktop). Never
  position 0 (that reads as a banner takeover) and never full-width.
- **Density vs inventory.** A5 sells **3 browse slot-weeks** per region per week
  (up to 3 concurrent advertisers, anti-oversell enforced in the DB); A7 still
  shows **at most one** `FeaturedCard` per rendered view — the active placements
  **rotate** into that one cell (§5.2). If fewer than 3 organic results exist,
  append it at the end rather than inserting mid-grid (so we never show an ad
  with no surrounding content).
- **Look = native, badge = obvious.** Same border/radius/padding as
  `BathroomCard`, real name/address/`Stars`/rating/`AmenityBadges`, plus:
  - a **"Sponsored"** pill in the top-right corner of the card
    (`ring-1 ring-flush-500/30` accent + a faint
    `bg-gradient-to-br from-flush-500/8 to-cyan-500/8` wash to set it apart
    without hiding that it's a listing),
  - an optional one-line **promo tagline** from the campaign creative
    (`ad_campaigns.creative.tagline`), rendered as muted text below the address —
    clearly the advertiser's words, not a review.
- **Target.** Links to a **real, claimed** bathroom (`/bathrooms/{id}`). The
  card shows that bathroom's true stats.

### 2.2 Map — `FeaturedNearbyStrip` (primary) + elevated `FeaturedPin` (enhancement) (`surface='map'`)

The map gets **two** complementary treatments; the strip is the disclosure-safe
primary, the pin is an enhancement that must *also* carry its own label.

- **`FeaturedNearbyStrip` (primary).** A thin horizontal band **overlaid at the
  bottom of the map**, above the attribution control
  (`absolute bottom-8 left-2 right-2 z-10`, on `md+` constrained to
  `max-w-md`). It carries a small header **"Featured nearby"** and the region's
  active map placement as a mini-card — with A5's inventory of **1 map slot-week
  per region** that is normally **exactly one**; the row is horizontally
  scrollable so it degrades gracefully if A5 ever raises map capacity. Each
  mini-card shows: bathroom name, real `★ rating`, a **"Featured"** chip, and a
  tap target that recenters the map on that pin and opens its popup. Copy is
  **region-level** ("in Fresno"), never a precise "0.2 mi away" — we only have
  coarse location (§3, GROWTH_CONTRACT constraint 3). Hidden entirely when there
  is no placement.
- **Elevated `FeaturedPin` (enhancement).** A featured bathroom's existing rating
  pin is rendered with (a) a higher z-index / rendered last so it isn't hidden,
  (b) a `flush-500` ring/glow around the teardrop, and — critically — (c) a small
  **"Featured"** label pill floating above the teardrop, plus `"Featured — "`
  prepended to its `aria-label` and a `Sponsored` line in its popup. **Color/glow
  alone is not allowed to carry the paid meaning** (FTC, §4; and it mirrors the
  codebase's existing "color never carries meaning alone" rule for rating pins).
- **Inventory.** **1 map slot-week per region** (A5's capacity — adopted, not
  diverged from: one elevated pin is prominent, two would start crowding the
  map). The strip and the elevated pin reference the *same* item — we never
  feature more pins than the strip lists.

### 2.3 Detail — `SponsorSlot` (`surface='detail'`)

- **Slot.** A single, visually distinct card in the `max-w-3xl` column of
  `BathroomDetail.tsx`, placed **between the "Ratings breakdown" section and the
  "Reviews" section** — i.e. *outside and above* `ReviewList`. It is **never**
  interleaved into the reviews.
- **Two contextual cases:**
  - **(a) This listing is claimed and itself has an active `detail` placement** →
    an owner promo block: the business's `creative` (tagline, optional
    `image_url`, `cta_label`, `link`), headed **"Sponsored by {business.name}"**.
  - **(b) No self-placement, but a *different* region-matched business has one** →
    a **"Sponsored · nearby"** card promoting that business's featured listing,
    linking to its `/bathrooms/{id}`.
- **Look.** Styled like the existing "Been here? Share your experience" prompt box
  (`rounded-xl border border-app bg-raised p-4`) with the `flush→cyan` accent
  wash and a **"Sponsored"** label on the focal point. Clearly an ad; clearly not
  a review.

**Format summary**

| Surface | Component | Slot & size | Sold inventory (A5) | Label | Native cue |
| --- | --- | --- | --- | --- | --- |
| browse | `FeaturedCard` | 1 grid cell @ index 3, 1 shown/view | 3 slot-weeks/region/week (rotate) | "Sponsored" pill top-right | same card shell as `BathroomCard`, real stats |
| map | `FeaturedNearbyStrip` + `FeaturedPin` | bottom overlay band + elevated pin | 1 slot-week/region/week | "Featured" chip + strip header; pin label pill | mini-card + a real rating pin |
| detail | `SponsorSlot` | 1 card between breakdown and reviews | 1 slot-week/region/week | "Sponsored" / "Sponsored by {biz}" | prompt-box shell, outside `ReviewList` |

---

## 3. Targeting & selection

### 3.1 Who sees which placement

For a request on `surface` from a viewer whose coarse region is `region`, a
`featured_placements` row is **eligible** iff **all** hold:

1. **Region match (A3).** `featured_placements.region = region`. The viewer's
   region is the coarse city/region from `user_locations` (signed-in, consented)
   or, for anonymous/non-consented viewers, from the edge geo header at load
   (Cloudflare `CF-IPCountry` / edge city, resolved per A3). Region granularity
   only — never street-level.
2. **Active window (A5).** `now() between starts_at and ends_at` **and** the
   parent `ad_campaigns.status = 'running'`. Draft/paused/pending/rejected/done
   campaigns are never eligible.
3. **Under the impression cap (§5).** The viewer has not already hit the per-user
   (or per-session, if anonymous) frequency cap for this placement/surface.

If more rows are eligible than there are slots, **rotate/fair-share** (§5.2).

### 3.2 Consent: contextual serving vs. per-user counting

This is the crux the pivot depends on — stated here as the design assumption,
with the authoritative legal treatment deferred to A1 (`COMPLIANCE.md`).

- **Serving a region-targeted featured listing does NOT require tracking
  consent.** Selection is **contextual**: it uses the *content of the page* and a
  *coarse region derived from the request*, used ephemerally to choose which
  listing to show. It does **not** read/write a device identifier for ad
  purposes, and it does **not** build or consult a behavioral profile of the
  individual. Contextual advertising is the recognized alternative to behavioral
  advertising precisely because it needs no consent to *track* — there is no
  tracking. So a signed-out or marketing-declined user can lawfully be shown a
  region-appropriate featured card. (Confirm final wording with A1; ePrivacy /
  GDPR / CPRA consent triggers attach to *tracking / profiling / "sharing" of
  personal data*, not to non-tracking contextual selection.)
- **Counting impressions per user DOES require consent (A4/A1).** The moment we
  attribute an impression or click to a specific `user_id` and store it — or set
  a persistent identifier to enforce a per-user cap across sessions — we are
  processing personal data for measurement. That path runs **only** when the
  viewer has consented (analytics/marketing per A1's `user_consents`). Without
  consent, A4 writes the event with a **null `user_id`** (aggregate + ephemeral
  `session_id` only), and the per-user frequency cap **degrades to a
  per-session/anonymous cap**. GPC / California "sharing" opt-out and EU
  no-consent both land in this same non-attributed path.

Net: **ads still show to everyone in-region; only the per-user measurement and
capping fidelity depends on consent.** No consent state ever *blocks* the
contextual placement itself.

---

## 4. Disclosure & ethics

### 4.1 The law we're following

- **FTC, _Native Advertising: A Guide for Businesses_** (Dec 2015) and the
  companion **_Enforcement Policy Statement on Deceptively Formatted
  Advertisements_** (Dec 2015). Key rules we apply:
  - An ad must be **identifiable as advertising _before_ consumers arrive at the
    main content**; disclosures must be **clear and prominent** from the
    perspective of a reasonable consumer, on every device.
  - **Placement:** the disclosure goes **in front of or above the headline** of
    the native unit; if the focal point is an image, the label may need to sit
    **on the image itself**.
  - **Mixed streams must be individually labeled.** "If a grouping of content
    items contains a mix of advertising and non-advertising content, a single
    disclosure … should not be used" — each ad is labeled on its own. This is why
    the browse `FeaturedCard` and each map strip item carry their **own** label
    rather than one banner over the grid.
  - **Understood terms:** the FTC lists "Ad," "Advertisement," "Paid
    Advertisement," "Sponsored Advertising Content" as terms consumers understand.
- **FTC, _.com Disclosures: How to Make Effective Disclosures in Digital
  Advertising_** (March 2013). A disclosure is "clear and conspicuous" judged on
  **proximity** ("as close as possible" to the claim), **placement** within the
  ad, and **prominence** (size/contrast) — on all devices. Our labels sit *inside*
  each unit, adjacent to the name, not in a footer or tooltip alone.

Sources:
- <https://www.ftc.gov/business-guidance/resources/native-advertising-guide-businesses>
- <https://www.ftc.gov/news-events/news/press-releases/2015/12/ftc-issues-enforcement-policy-statement-addressing-native-advertising-deceptively-formatted>
- <https://www.ftc.gov/system/files/documents/plain-language/bus41-dot-com-disclosures-information-about-online-advertising.pdf>

### 4.2 Which word we use

**Preferred visible label: "Sponsored"** (or **"Ad"**). Both plainly convey a
*paid* placement. We deliberately do **not** rely on "Featured" or "Promoted"
*alone*: the FTC has cautioned that terms which merely imply popularity or
editorial selection can fail to convey the commercial nature. Where the brand
wants the friendlier word "Featured" (map strip/pin), it must be reinforced so
the paid nature is unmistakable — e.g. an adjacent info affordance / subtext
**"Paid placement"** — and the browse and detail units default to **"Sponsored."**
The disclosure string is centralized so this stays consistent:

```ts
// src/lib/ads/disclosure.ts  (A1 owns final copy; A7 owns the constant location)
export const AD_LABEL = {
  browse: 'Sponsored',
  detail: 'Sponsored',
  map: 'Featured',            // reinforced with a "Paid placement" affordance
} as const;
export const AD_LABEL_LONG = 'Paid placement';
```

### 4.3 Bright lines (enforced structurally, not just by policy)

- **Never an ad disguised as a review.** `SponsorSlot` is a sibling of
  `ReviewList`, never a child; it never renders `Stars` as if a person rated, and
  never fabricates an author. Reviews render only from `reviews`/`review_photos`.
- **A featured slot cannot alter rating or bury reviews.** `FeaturedCard`,
  `FeaturedPin`, and `SponsorSlot` all read the *same* public stats/reviews
  everyone else does. There is no code path by which a placement rewrites
  `bathroom_stats` or reorders/filters `ReviewList`. (Owners still respond to
  reviews via the existing `review_responses` flow; they still cannot edit or
  delete reviews — moderators only. Unchanged.)
- **Real rating always visible on the ad.** A featured card/strip item shows the
  listing's true average — no suppressing a low score.

---

## 5. Frequency & inventory

### 5.1 Slots per surface, per region

Sold inventory is **A5's model, adopted as-is**: fixed slot-weeks per
`(surface, region, week)` — **map 1 / browse 3 / detail 1** (5 slot-weeks per
region per week), sold as time-boxed `featured_placements` with anti-oversell
enforced in the DB. What A7 adds is the *display density* on top of that
inventory:

| Surface | Sold (A5, per region-week) | Shown (A7, per view) | Notes |
| --- | --- | --- | --- |
| browse | 3 slot-weeks | 1 `FeaturedCard` | active placements rotate into the cell (§5.2); at index 3, appended if <3 organic results |
| map | 1 slot-week | 1 strip item + 1 elevated pin | same item in both treatments |
| detail | 1 slot-week | 1 `SponsorSlot` | self-placement (case a) wins over nearby (case b) |

A single advertiser is limited to **a few activations per week** per slot by its
plan's `featured_per_week` entitlement (A9), enforced server-side at
campaign-activation time by A5 — not re-derived here.

### 5.2 Rotation / fairness (multiple advertisers, same region+time)

Rotation is only ever needed on **browse** (3 sold vs 1 shown); map and detail
are 1-for-1. A5 confirmed components read active placements directly, so the
per-view rotation is **A7's, client-side**:

- **Stable within a session, fair across sessions.** Pick with a
  **session-seeded** shuffle (over-fetch all ≤3 active browse placements, pick
  index `hash(session_id) % n`) so a viewer doesn't see the featured card flicker
  between advertisers on every re-render, while different sessions see different
  advertisers — spreading exposure roughly evenly.
- **Equalize fill over time.** As a refinement, prefer the eligible placement
  with the fewest impressions so far in the current window (least-served-first,
  counts from A4), so a big advertiser can't starve a $10 shop targeting the same
  city. Abuse of rotation (e.g. an advertiser splitting into shell businesses to
  hold all 3 browse slots) is **A12's** to police.

### 5.3 Per-user impression frequency cap (anti-spam) — **A7-owned**

A5 explicitly left in-app frequency to A7, so these numbers are **authoritative
here** (configurable, but this doc is their home). Note the contract's
**3-per-7-days cap governs promotional MESSAGES (email)**, not passive in-app
impressions — impressions are lower-intrusion, so they get a different shape:

- **Same-placement cap: ≤ 3 viewed impressions per placement per day** per
  viewer. After that, that placement is excluded from the viewer's eligible set
  for the rest of the day (on browse, rotation falls through to another active
  placement; on map/detail the surface goes empty).
- **Per-surface daily ceiling: ≤ 10 viewed featured impressions per surface per
  day** per viewer, across all placements — a backstop so heavy browsing never
  turns into an ad wall.
- **Surface density cap:** the §5.1 per-view maxima (1 browse card, 1 map item,
  1 detail slot) are hard ceilings regardless of demand.
- **Enforcement:** counted from `analytics_events` `featured_impression` rows
  (A4's counter). Consented users are capped **per user**; anonymous or
  non-consented users are capped **per `session_id`** (§3.2) — coarser, but
  fails in the user-friendly direction (fewer ads, never more). A12 may layer
  stricter abuse-driven limits on top; it does not need to define these.

---

## 6. Component & data specs

### 6.1 Data source — one public RPC, no user data

Placements are fetched through a single **public, read-only RPC** that returns
only **currently-active, region-matched** rows joined to safe public listing
facts + real stats + campaign creative. It takes **no `user_id`**, returns **no
user data**, and **logs nothing** (impression logging is separate, client-side,
to A4). A5 has confirmed this pattern — components read active
`featured_placements` directly (surface + region + time-window filter) via a
public, non-personalized RPC; A5's optional `claim_inapp_batch` path is for
scheduled-activation semantics and is **not needed** on the read side.

Two properties A5 guarantees that this RPC leans on:

- **Creative is frozen at admin approval.** `ad_campaigns.creative` cannot change
  after review while running, so rendering it verbatim is safe — the
  bait-and-switch (approve tame creative, swap it later) is structurally closed.
  A7 therefore does no client-side creative re-validation.
- **Anti-oversell is in the DB**, so the RPC can trust that at most 3/1/1
  (browse/map/detail) rows come back per region — the `p_limit` is a belt, not
  the enforcement.

```sql
-- OWNER: A2 (DATA_MODEL.md) implements & owns final signature. A7 specifies shape.
-- Public: callable by anon and authenticated. SECURITY DEFINER so it can read
-- ad_campaigns.status without exposing the campaigns table via RLS.
create or replace function public.active_featured(
  p_surface text,          -- 'browse' | 'map' | 'detail'
  p_region  text,          -- viewer's coarse region (from A3; client-supplied)
  p_limit   int default 2
)
returns table (
  placement_id uuid,
  campaign_id  uuid,
  surface      text,
  region       text,
  bathroom_id  uuid,
  name         text,
  address      text,
  lat          double precision,
  lng          double precision,
  business_id  uuid,
  business_name text,
  business_logo_url text,
  creative     jsonb,       -- { tagline, image_url, cta_label, link } — public subset
  avg_rating   numeric,     -- from bathroom_stats (REAL, never overridden)
  review_count int,
  starts_at    timestamptz,
  ends_at      timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select fp.id, fp.campaign_id, fp.surface, fp.region,
         b.id, b.name, b.address, b.lat, b.lng,
         biz.id, biz.name, biz.logo_url,
         -- only the public creative fields; never internal campaign data
         jsonb_build_object(
           'tagline',   c.creative->>'tagline',
           'image_url', c.creative->>'image_url',
           'cta_label', c.creative->>'cta_label',
           'link',      c.creative->>'link'
         ),
         s.avg_rating, s.review_count,
         fp.starts_at, fp.ends_at
  from public.featured_placements fp
  join public.ad_campaigns c on c.id = fp.campaign_id
  join public.bathrooms b    on b.id = fp.bathroom_id and b.deleted_at is null
  left join public.businesses biz on biz.id = fp.business_id
  left join public.bathroom_stats s on s.bathroom_id = b.id
  where fp.surface = p_surface
    and fp.region  = p_region
    and c.status   = 'running'
    and now() between fp.starts_at and fp.ends_at
  order by fp.starts_at desc          -- client rotates per view (§5.2)
  limit greatest(p_limit, 1);
$$;
```

RLS on `featured_placements` stays restrictive (advertisers/admins per A2); the
**public read path is only this RPC**, which structurally cannot leak draft,
future, or paused campaigns because the `WHERE` filters to active+running. This
matches the repo convention (mutations/reads via `SECURITY DEFINER` RPCs with
`set search_path = ''`; see `search_bathrooms`/`nearby_bathrooms`).

**Client wrapper** (mirrors `src/lib/api/bathrooms.ts` style):

```ts
// src/lib/api/featured.ts
import { supabase } from '@/lib/supabase';

export type AdSurface = 'browse' | 'map' | 'detail';

export interface FeaturedItem {
  placementId: string;
  campaignId: string;
  surface: AdSurface;
  region: string;
  bathroomId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  businessId: string | null;
  businessName: string | null;
  businessLogoUrl: string | null;
  creative: { tagline?: string; imageUrl?: string; ctaLabel?: string; link?: string } | null;
  avgRating: number | null;   // REAL rating, coerced like bathrooms.ts toNum()
  reviewCount: number;
}

export async function activeFeatured(
  surface: AdSurface,
  region: string | null,
  limit = 2,
): Promise<FeaturedItem[]> {
  if (!region) return [];                       // no region ⇒ no contextual ad
  const { data, error } = await supabase.rpc('active_featured', {
    p_surface: surface,
    p_region: region,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []).map(mapRow);              // snake→camel + numeric coercion
}
```

Add query keys to `queryClient.ts` (A7 requests A-none; this is our file to
extend at implementation): `featured: (s, r) => ['featured', s, r] as const`.
Because the payload is contextual (not per-user), it caches well under the
existing generous `staleTime`.

### 6.2 Impression / click tracking (to A4)

Two first-party events, written through A4's analytics API (which owns consent
gating, `user_id` vs anonymous, and the frequency counter). A7 only fires them:

- `featured_impression` — fired when the unit is **actually viewed**
  (IntersectionObserver, ≥ 50% visible for ≥ 1s — MRC-style viewability — so
  off-screen renders don't count), **once per placement per mount**.
- `featured_click` — on tap-through.

```ts
props (no PII, per analytics_events contract):
  { placement_id, campaign_id, surface, region }   // + destination on click
```

A viewability hook keeps it DRY across all three components:

```ts
// src/lib/ads/useFeaturedImpression.ts
import { useEffect, useRef } from 'react';
import { trackEvent } from '@/lib/api/analytics';   // OWNER: A4

export function useFeaturedImpression(item: {
  placementId: string; campaignId: string; surface: string; region: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const fired = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || fired.current) return;
    let timer: number | undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio >= 0.5) {
        timer = window.setTimeout(() => {
          if (fired.current) return;
          fired.current = true;
          void trackEvent('featured_impression', {
            placement_id: item.placementId, campaign_id: item.campaignId,
            surface: item.surface, region: item.region,
          });
          io.disconnect();
        }, 1000);
      } else if (timer) { clearTimeout(timer); timer = undefined; }
    }, { threshold: [0, 0.5, 1] });
    io.observe(el);
    return () => { io.disconnect(); if (timer) clearTimeout(timer); };
  }, [item.placementId, item.campaignId, item.surface, item.region]);
  return ref;
}
```

### 6.3 `FeaturedCard` (browse)

```tsx
// src/components/ads/FeaturedCard.tsx
export function FeaturedCard({ item }: { item: FeaturedItem }) {
  const ref = useFeaturedImpression(item);
  const rated = item.reviewCount > 0 && item.avgRating != null;
  return (
    <Link
      ref={ref as React.Ref<HTMLAnchorElement>}
      to={`/bathrooms/${item.bathroomId}`}
      onClick={() => void trackEvent('featured_click', { /* …props… */ })}
      className="group relative flex flex-col gap-3 rounded-xl border border-app
                 bg-gradient-to-br from-flush-500/8 to-cyan-500/8 p-4
                 ring-1 ring-flush-500/30 transition-shadow hover:shadow-md"
    >
      <span className="absolute right-3 top-3 rounded-full border border-app
                       bg-raised px-2 py-0.5 text-[0.7rem] font-medium text-muted">
        {AD_LABEL.browse /* "Sponsored" */}
      </span>
      <div className="min-w-0 pr-16">
        <h3 className="truncate font-semibold text-app">{item.name}</h3>
        <p className="mt-0.5 truncate text-sm text-muted">{item.address}</p>
      </div>
      <div className="flex items-center gap-2">
        {rated ? (<><Stars value={item.avgRating!} size={16} />
          <span className="text-sm font-medium text-app">{item.avgRating!.toFixed(1)}</span>
          <span className="text-sm text-muted">({item.reviewCount})</span></>
        ) : <span className="text-sm text-muted">No reviews yet</span>}
      </div>
      {item.creative?.tagline && (
        <p className="text-sm text-muted">{item.creative.tagline}</p>
      )}
    </Link>
  );
}
```

**Integration in `Home.tsx`** (additive; empty-safe):

```tsx
const region = useViewerRegion();                       // A3 hook
const { data: ads } = useQuery({
  // Over-fetch all ≤3 active browse placements; rotation picks one (§5.2).
  queryKey: queryKeys.featured('browse', region ?? ''),
  queryFn: () => activeFeatured('browse', region, 3),
  enabled: !!region,
});
const ad = pickRotated(ads, sessionId);                 // session-seeded, §5.2
// …in the results grid, splice one card at index 3 (append if list shorter):
const cells = injectFeatured(bathrooms, ad);            // helper returns mixed nodes
```

`injectFeatured` returns `BathroomCard`/`FeaturedCard` nodes; when `ads` is empty
it returns the plain list → **no gap, no shift**.

### 6.4 `FeaturedNearbyStrip` + elevated pin (map)

`BathroomMap` gains **one optional prop**, `featuredIds?: Set<string>`, used only
to render an elevated marker for those bathrooms — a small additive change:

```tsx
// inside the rating-pin loop:
const isFeatured = featuredIds?.has(bathroom.id);
const element = ratingPinElement(bathroom.stats.avg_rating, { featured: isFeatured });
// ratingPinElement adds, when featured:
//   • a flush-500 ring on the teardrop
//   • a "Featured" label pill positioned above it (text, not color-only)
//   • aria-label prefixed "Featured — "
// and the popup gains a "Sponsored" line.
// Featured markers are added LAST so they render on top.
```

The React strip is overlaid by `MapPage.tsx` (it owns the map's relative box):

```tsx
// src/components/ads/FeaturedNearbyStrip.tsx
export function FeaturedNearbyStrip({
  items, onSelect,
}: { items: FeaturedItem[]; onSelect: (b: FeaturedItem) => void }) {
  if (items.length === 0) return null;                  // graceful empty
  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-8 z-10 mx-auto
                    flex max-w-md flex-col gap-1 rounded-xl border border-app
                    bg-surface/95 p-2 shadow-md backdrop-blur">
      <span className="px-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
        Featured nearby
      </span>
      <div className="flex gap-2 overflow-x-auto">
        {items.map((it) => (
          <FeaturedStripCard key={it.placementId} item={it} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
```

`FeaturedStripCard` uses `useFeaturedImpression`, shows name + real `★ rating` +
a **"Featured"** chip, and on tap fires `featured_click`, recenters the map, and
opens the pin's popup. Copy stays region-level ("in {region}"), never a precise
distance. `MapPage` fetches `activeFeatured('map', region, 1)` (A5 sells one map
slot-week per region) and passes the id(s) to `BathroomMap` and the item(s) to
the strip. Empty ⇒ neither renders.

### 6.5 `SponsorSlot` (detail)

```tsx
// src/components/ads/SponsorSlot.tsx
export function SponsorSlot({ region, bathroomId }: { region: string | null; bathroomId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.featured('detail', region ?? ''),
    queryFn: () => activeFeatured('detail', region, 2), // A5 sells 1; small belt
    enabled: !!region,
  });
  // Prefer a self-placement for THIS listing (case a); else first nearby (case b).
  const item = data?.find((d) => d.bathroomId === bathroomId) ?? data?.[0];
  const ref = useFeaturedImpression(item ?? DUMMY);      // no-op when item absent
  if (!item) return null;                                // graceful empty, no box

  const self = item.bathroomId === bathroomId;
  return (
    <section ref={ref as React.Ref<HTMLElement>}
      className="rounded-xl border border-app bg-gradient-to-br
                 from-flush-500/10 to-cyan-500/10 p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">
          {self ? `Sponsored by ${item.businessName}` : 'Sponsored · nearby'}
        </span>
      </div>
      {item.creative?.tagline && <p className="text-sm font-medium text-app">{item.creative.tagline}</p>}
      <a href={item.creative?.link ?? `/bathrooms/${item.bathroomId}`}
         onClick={() => void trackEvent('featured_click', { /* …props… */ })}
         className="mt-2 inline-block text-sm font-medium text-flush-600 hover:underline">
        {item.creative?.ctaLabel ?? 'View details →'}
      </a>
    </section>
  );
}
```

Mounted in `BathroomDetail.tsx` **between** the "Ratings breakdown" `<section>`
and the "Reviews" `<section>` — outside `ReviewList`. Renders `null` when there's
no placement, so the detail layout is unchanged.

### 6.6 Graceful empty state (all surfaces)

- `activeFeatured` returns `[]` ⇒ every component returns `null`.
- Browse: no cell is inserted (the helper returns the plain organic list) — no
  reserved slot, no skeleton, no "advertisement" placeholder.
- Map: strip hidden, no elevated pins, `featuredIds` empty.
- Detail: `SponsorSlot` renders nothing between the two sections.
- If the RPC **errors**, treat as empty (ads are non-critical) and never block or
  degrade the organic content — wrap in an error boundary / `catch → []`.

---

## 7. Interfaces (what A7 consumes from / requests of others)

- **A2 (`DATA_MODEL.md`) — `featured_placements`, `ad_campaigns`, RLS, RPC.**
  Uses the canonical columns as given: `featured_placements(bathroom_id,
  business_id, surface, region, starts_at, ends_at, campaign_id)` and
  `ad_campaigns(status, creative, target_region, …)`. **REQUEST TO A2:** (1)
  implement `public.active_featured(...)` per §6.1 (public read path; keep the
  table's own RLS restrictive); (2) ensure `ad_campaigns.creative` jsonb carries
  the in-app subset `{ tagline, image_url, cta_label, link }`; (3) *optional*
  `featured_placements.weight int default 1` for fairness — **defer to A5/A12**;
  A7 works without it.
- **A3 (`LOCATION.md`) — viewer region.** Provides `useViewerRegion()` →
  coarse region string for signed-in (from `user_locations`) and anonymous (edge
  geo) viewers. A7 passes it straight to the RPC.
- **A4 (`ANALYTICS.md`) — events + counting.** Owns `trackEvent`,
  `analytics_events`, consent-gated `user_id` attribution, and the impression
  counter that powers the per-user cap. A7 emits `featured_impression` /
  `featured_click` with the props in §6.2.
- **A5 (`CAMPAIGNS.md`) — inventory, status, scheduling, creative freeze.**
  Adopted as-is from A5's finished design: **slot-week inventory map 1 / browse 3
  / detail 1 per region-week** with anti-oversell in the DB; `ad_campaigns.status`
  transitions and activation limits; **creative frozen at admin approval** (A7
  renders it verbatim, §6.1); radius targeting clamped **5–100 km at city
  granularity** with **k-anonymous reach previews (floor 30)** — advertisers
  never see individual users. A5 left per-view rotation and in-app impression
  caps to A7 (§5.2, §5.3).
- **A9 (`PRICING.md`) — `featured_per_week` entitlement** that bounds how many
  placements a business may run.
- **A12 (`ABUSE_AND_LIMITS.md`) — abuse/fairness policing.** A7 owns the in-app
  impression-cap numbers (§5.3); A12 polices gaming of them (shell advertisers
  hoarding slots, click fraud) and may layer stricter abuse-driven limits on top.
- **A1 (`COMPLIANCE.md`) — disclosure copy + the contextual-vs-behavioral consent
  line.** Owns the final label wording and confirms §3.2. A7 centralizes the
  label constant (§4.2) and structures the components so the rules in §4.3 are
  enforced by construction.

---

## 8. Open questions for the orchestrator (A14)

1. Confirm `useViewerRegion()` (A3) resolves a usable region for **anonymous**
   map/browse viewers; if not, anonymous users simply see no ads (acceptable —
   fail closed to empty).
2. Confirm A4's `trackEvent` is safe to call pre-consent (it must no-op the
   `user_id` attribution, not drop the event's aggregate/anonymous form).
3. ~~A5 to decide the ordering seam.~~ **Resolved:** A5 confirmed components read
   active `featured_placements` directly via a public non-personalized RPC; A7
   owns the client-side per-view rotation (§5.2). The optional
   `claim_inapp_batch` path is not needed for read-side rendering.
