# Targeting & Placement — Ranked Ideas

Grounding note: the shipped implementation (`supabase/migrations/20260712000000_growth_phase0_featured.sql`,
`src/lib/api/growth.ts`, `src/pages/Explore.tsx`, `src/components/growth/FeaturedCard.tsx`) is much
thinner than the `docs/growth/INAPP_ADS.md` / `CAMPAIGNS.md` design docs describe. Today: `active_featured(p_surface, p_region)`
does a flat text equality (`fp.region = p_region`, or `null` passes everything); Explore.tsx calls it with
**no region argument at all**; only `surface='browse'` actually renders (`FeaturedCard` in the Explore list);
`map` and `detail` are valid enum values with zero rendering code; there is no radius/PostGIS targeting despite
`bathrooms.geog` (generated PostGIS point, `nearby_bathrooms` RPC) already existing; no keyword, amenity,
viewport, or dayparting targeting exists at all. `featured_placements.bathroom_id` and `ad_campaigns.bathroom_id`
already reference `public.bathrooms`, so **every geo-targeting idea below can join straight to `bathrooms.geog`
with no new geometry column** — only a `radius_km` numeric is needed in most cases. None of these ideas need an
Edge Function — PostGIS, `pg_trgm`, and `now()`-based time math all run fine inside a `SECURITY DEFINER` SQL/plpgsql
RPC, matching the existing `nearby_bathrooms`/`search_bathrooms` pattern. Every idea below is additive to the
current schema/components and keeps ads out of `reviews`/`review_photos` entirely.

---

## 1. Real PostGIS radius targeting for featured placements

Replace `active_featured`'s flat `fp.region = p_region` text match with a real `ST_DWithin` radius query.
Add one column — `featured_placements.radius_km numeric` (or read it off `ad_campaigns`) — and join
`fp.bathroom_id → bathrooms.geog` (already a generated PostGIS point) against a **viewer-context point**
(map center, or the currently-viewed bathroom's own point on detail pages) instead of a fuzzy city string.
This directly reuses the `nearby_bathrooms` pattern (`supabase/migrations/20260710010000_search_geo_privacy.sql:144`)
and needs no new consent surface: the "viewer point" is either the map's own current center (page state) or
the bathroom being viewed (page content) — never a stored personal location. This is the single highest-leverage
change because every other geo idea below builds on it.
**Effort:** M. **Touches:** new migration adding `radius_km` + rewriting `active_featured` (currently at
`supabase/migrations/20260712000000_growth_phase0_featured.sql:270`); `src/lib/api/growth.ts` (`activeFeatured` signature); a radius input in `src/pages/business/Campaigns.tsx`'s create-campaign form. **Ship-first:** yes.

## 2. `SponsorSlot` on the bathroom detail page (radius-matched, two-case)

`BathroomDetail.tsx` currently has zero ad surface even though `surface='detail'` is a valid enum value —
this is free real estate. Case (a): the viewed bathroom itself has an active `detail` placement → "Sponsored
by {business}". Case (b): no self-placement, but another business's `detail` campaign is within its `radius_km`
of *this bathroom's* `geog` (not the viewer's) → "Sponsored · nearby". Both cases target off page content
(the listing being viewed), so no viewer location or consent is ever needed — this is the cleanest, cheapest
contextual signal in the whole domain.
**Effort:** S. **Touches:** new `src/components/growth/SponsorSlot.tsx`; mount in `src/pages/BathroomDetail.tsx` between ratings and reviews; extend `active_featured` (or a sibling RPC) to accept `p_bathroom_id` for the self/nearby join. **Ship-first:** yes.

## 3. Sponsored search results (keyword targeting)

Explore's search box already computes a debounced `query` and calls `search_bathrooms` (trigram similarity via
`pg_trgm`, already installed). Add `ad_campaigns.target_keywords text[]` and match it against the same debounced
term with `similarity()`/`ILIKE`, surfaced only when `query` is non-empty (a distinct commercial moment from
cold browsing — "diaper," "showers," "24 hour," "truck stop"). This is the highest-value single idea in the
list (search intent is the highest-CPC ad placement category that exists) and is purely contextual — the term
a person just typed, never stored against them.
**Effort:** M. **Touches:** migration adding `target_keywords`; new RPC or `active_featured` param `p_query`;
`src/pages/Explore.tsx` (pass `debounced` through, label distinctly e.g. "Sponsored result" vs. "Sponsored");
`src/components/growth/FeaturedCard.tsx` variant. **Ship-first:** yes.

## 4. Targeting-specificity waterfall

`active_featured` today is single-tier: exact region match or nothing. `DATA_MODEL.md`'s email eligibility
CTE already demonstrates the right pattern (radius OR region OR country, first match wins) — apply the same
OR-chain to `active_featured` once radius targeting (#1) lands: try radius → then region string → then
country → then "untargeted" campaigns, first tier with any eligible row wins. Increases fill without ever
serving something that doesn't match at all — "empty is default" stays true when literally nothing qualifies.
**Effort:** S. **Touches:** `active_featured` RPC rewrite (same file as #1) — SQL-only, no client changes.

## 5. Zero-results contextual ad fallback

`Explore.tsx` already has a distinct empty-state branch (`bathrooms.length === 0`, lines ~102-113) that
currently renders only text. A search that turns up nothing organic is a dead end today — and it's also the
one moment showing an ad can't possibly bury real content, since there is none. Hook a keyword-targeted
placement (#3) into that exact branch: "Nothing matched 'diaper changing' — Sponsored: {business}".
**Effort:** S. **Touches:** `src/pages/Explore.tsx` empty-state branch only, reusing #3's query plumbing.

## 6. Map surface: `FeaturedNearbyStrip` + elevated pin, targeted by live viewport

Wire up the still-unrendered `surface='map'` placements: an overlay strip + one elevated/ring-highlighted pin
on `BathroomMap`. Target it by the **map's actual current viewport** (center + a radius derived from zoom)
rather than a static region string — add a `moveend` listener (none exists today; `BathroomMap.tsx` has no
`onMove`/`getBounds` callback yet) that reports the live center to the parent, which re-queries `active_featured`.
This is explicitly audience-free: the viewport is what the *page* is showing right now, not a profile of the
person looking.
**Effort:** M. **Touches:** `src/components/map/BathroomMap.tsx` (new `onViewportChange` prop, elevated-pin
rendering in `ratingPinElement`); new `FeaturedNearbyStrip` component; `src/pages/Explore.tsx` map pane.

## 7. Dayparting via the placement's own coarse local time

Add `ad_campaigns.daypart_hours smallint[]` / `daypart_days smallint[]` and filter `active_featured` by
`extract(hour from now() at time zone tz)`, using the **promoted bathroom's own region** to resolve a
representative IANA zone (a small static `region_timezones` map, same idea `CAMPAIGNS.md §4.4` already
sketches for email windowing) — not the viewer's timezone, so again no location consent is implicated. Lets a
lunch-spot advertiser run "11am–2pm only" placements as `CAMPAIGNS.md` itself calls out as a target use case.
**Effort:** M. **Touches:** new migration (`region_timezones` + columns); `active_featured` WHERE clause;
a simple hour/day picker in `src/pages/business/Campaigns.tsx`.

## 8. Amenity-context targeting on the detail page

Extend #2's `SponsorSlot` nearby-case predicate with `ad_campaigns.target_amenities jsonb` matched against the
*viewed bathroom's own* `wheelchair_accessible`/`gender_neutral`/`changing_table`/`requires_key` flags
(`src/types/db.ts:19-24`) — e.g. a family-travel brand targets pages showing `changing_table = true`, or a
"key-free alternative nearby" ad targets `requires_key = true` pages. Zero new UI needed since it rides on #2's
slot; purely a WHERE-clause addition plus one jsonb column and a few checkboxes in the campaign form.
**Effort:** S (on top of #2) / M standalone. **Touches:** `ad_campaigns.target_amenities` column; `SponsorSlot`
predicate; `src/pages/business/Campaigns.tsx` amenity checkboxes.

## 9. Zoom-level gating for the map strip

Only surface `FeaturedNearbyStrip`/elevated pins once the map is zoomed to roughly neighborhood level
(e.g. `zoom >= 13`); suppress at city/region-wide zoom where "nearby" would be misleading. Zoom is pure map
state (audience-free), and this is a one-line guard once #6 exists — prevents a "Featured nearby" claim from
reading as false when the viewport spans 50km.
**Effort:** S. **Touches:** `src/components/map/BathroomMap.tsx` / the `FeaturedNearbyStrip` mount condition.

## 10. Corridor/highway targeting

For a public-bathroom app, "along my route" beats "near a point" for a meaningful slice of advertisers (travel
plazas, rest-stop-adjacent businesses). Model a corridor as a buffered `extensions.geography(LineString,4326)`
and match campaigns whose corridor is within N meters of the candidate bathroom's `geog`
(`ST_DWithin(bathrooms.geog, corridor, buffer_m)`), reusing the same PostGIS install used for `bathrooms.geog`.
Needs an advertiser-facing way to define the line (two-point "from/to" city picker is enough for v1; a
draw-a-route UI is a stretch). Highest differentiation, highest cost.
**Effort:** L. **Touches:** new migration (`corridor geography(LineString,4326)`, buffer column); `active_featured`
predicate; a from/to city picker in `src/pages/business/Campaigns.tsx`; k-anonymity/reach-preview math needs
rethinking for a line instead of a point.

---

**Top picks:** Ship real PostGIS radius targeting first (#1) — it's cheap (joins existing `bathrooms.geog`, no
new geometry column) and every other geo idea depends on it. Pair it with the detail-page `SponsorSlot` (#2),
which is pure upside on a surface that currently shows zero ads. Then add sponsored search results (#3) — it's
the single highest-commercial-value placement (search intent) and slots into search plumbing that already exists.
