# DATA_MODEL — Watrloo growth platform schema (A2, authoritative)

**Summary.** This is the single source of truth for every new table the growth
pivot adds: consent, coarse location, CRM segments, ad campaigns + per-recipient
send logs, featured placements, newsletter, email suppressions, first-party
analytics, and pricing plans/entitlements. It extends the live schema in place
(RLS on every table, `SECURITY DEFINER` RPCs, `set search_path=''`, initplan
policy form, PostGIS `geog` in the `extensions` schema, `moderation_actions`
audit). Every other agent references the table/column names defined here.

**Dependencies.** Consumes: existing migrations `20260710000000_init` …
`20260711000000_business_accounts` (this doc extends them). Feeds: A1
COMPLIANCE (consent/suppression are enforced in the send-path RPCs defined
here), A3 LOCATION (owns IP→geo resolution + segment predicate DSL; calls
`capture_location`/`admin_materialize_segment`), A4 ANALYTICS (`analytics_events`
+ `log_event`), A5 CAMPAIGNS (campaign lifecycle RPCs), A6 EMAIL_DELIVERY
(`campaign_eligible_recipients` + `record_campaign_send` + `unsubscribe_by_token`),
A7 INAPP_ADS (`featured_placements` + `active_featured_placements`), A8 NEWSLETTER
(`newsletter_*`), A9 PRICING (owns the `plans` rows — mine are FK-satisfying
placeholders), A10 ADVERTISER_CONSOLE (member-scoped campaign RLS + aggregate
reach RPCs), A11 ADMIN_CRM (admin-only reads of everything), A12 ABUSE_AND_LIMITS
(frequency cap + entitlement helpers), A14 ARCHITECTURE (integration seams).

> **This is a DESIGN.** No migration is applied. The SQL below is written to drop
> into a new file `supabase/migrations/20260712000000_growth_platform.sql`. The
> orchestrator applies it later. Nothing here changes the live DB.

---

## 1. Design decisions (read before the SQL)

1. **Naming is canonical.** Table/column names match the contract's canonical
   model exactly (`user_consents.marketing_opt_in`, `location_opt_in`,
   `gpc_detected`, `consent_updated_at`, `source`; `ad_campaigns.type/status/
   target_region/target_geog/radius_km/segment_id/frequency_per_week/creative`;
   etc.). Where I add a column the contract didn't list, it is flagged in §8.

2. **RLS strategy — three tiers.**
   - **Own-row** (`user_consents`): a user reads their own consent; writes funnel
     through `set_consent` so the timestamps and the consent↔suppression coupling
     are always consistent.
   - **Admin-only CRM** (`user_locations`, `user_segments`, `segment_members`,
     `campaign_sends`, `newsletter_sends`, `email_suppressions`,
     `analytics_events`, `growth_settings`): `using ((select public.is_admin()))`.
     Advertisers **never** get row access to any of these — they see only
     aggregate counts via `SECURITY DEFINER` RPCs that return numbers, never
     user_ids or locations.
   - **Business-scoped** (`ad_campaigns`, `featured_placements`): a member sees
     ONLY their own business's rows via `is_business_member(business_id)`; active
     `featured_placements` are additionally public so the app can render ads
     (same pattern as verified `bathroom_claims`).

3. **Mutations go through `SECURITY DEFINER` RPCs**, matching the existing
   codebase. Client tables get `select` (and, for a few, narrow `insert`)
   grants; lifecycle writes (approve/submit/send/suppress/grant) have **no**
   client write policy — the RPC is the only path and it re-checks role/consent
   and writes an audit row to `moderation_actions`.

4. **Frequency cap has two independent gates**, both enforced server-side at send
   time (contract: "at most a few promotional messages per week; default 3/7d,
   configurable"):
   - **Platform cap** — total promotional messages (campaign + newsletter) a user
     may receive in a trailing 7 days. Default **3**, stored in `growth_settings`
     (`promo_weekly_cap`) so it is configurable without a deploy.
   - **Per-campaign cap** — `ad_campaigns.frequency_per_week`: how often *one*
     campaign may hit the same user in 7 days. Both are checked in
     `campaign_eligible_recipients` and re-checked in `record_campaign_send`.

5. **Entitlements tie to `subscriptions.plan`.** I add `plans` (keyed by the same
   text `subscriptions.plan` already holds) + a FK, plus typed caps
   (`max_locations`, `blasts_per_month`, `featured_per_week`, `team_seats`,
   `analytics_level`, …) and an optional `plan_features` EAV table for
   overrides/flags A9 hasn't first-classed. Helper RPCs
   (`can_send_blast`/`can_add_location`/`can_feature`) are the checks the code and
   RLS-adjacent RPCs call. **A9 PRICING owns the actual rows/prices**; I seed
   FK-satisfying placeholders incl. the existing `'standard'` value.

6. **Coarse location only, consent-gated.** `user_locations` stores city/region/
   country + a **city-centroid** `geog` — never a raw IP, never street-level.
   The IP→geo resolution happens in the sign-in Edge Function (A3 owns it):
   country from Cloudflare's `CF-IPCountry` request header when present; city +
   region + centroid from a **MaxMind GeoLite2 City** lookup (free, self-hostable
   — satisfies the "free/self-hostable geo source" constraint) done in the
   function. The function then calls `capture_location(...)` with the already-
   coarsened values, and that RPC writes a row **only if the user's
   `location_opt_in` is true**. Radius targeting uses `ST_DWithin` on the centroid
   with a **≥5 km minimum radius**, so it can never isolate a block.

7. **PostGIS is available** — installed in the `extensions` schema by
   `20260710010000_search_geo_privacy.sql` (PostGIS + pg_trgm). All spatial types/
   functions are referenced schema-qualified (`extensions.geography(Point,4326)`,
   `extensions.st_dwithin`, `extensions.st_setsrid`, `extensions.st_point`) exactly
   like `bathrooms.geog` / `nearby_bathrooms`. **Verified: no new extension needed.**

8. **Retention.** `user_locations.expires_at` (default now()+`location_retention_days`,
   90) and an `analytics_events` time index support a pg_cron purge (scheduling
   deferred to A13 SCALING / A3). `growth_settings` holds the day-count knobs.

9. **Send logs survive account deletion.** `campaign_sends.user_id` /
   `newsletter_sends.user_id` / `analytics_events.user_id` are
   `on delete set null`, so `delete_my_account()` (which cascades `auth.users`)
   doesn't destroy the CAN-SPAM audit trail or aggregate counts. `user_consents`
   and `user_locations` cascade-delete with the user (they are the user's PII).

---

## 2. Table catalog (quick reference — exact SQL in §7)

| Table | Purpose | RLS (read / write) | Key indexes |
| --- | --- | --- | --- |
| `growth_settings` | Tunable knobs (`promo_weekly_cap=3`, retention days) | admin / RPC | pk(key) |
| `plans` | Pricing tiers + typed entitlement caps | **public** read / admin RPC | pk(key) |
| `plan_features` | Per-plan entitlement overrides/flags (EAV) | public read / admin RPC | pk(plan_key,feature) |
| `user_consents` | 1/user: marketing + location opt-in, GPC | **own** + admin / `set_consent` | pk(user_id) |
| `user_locations` | Coarse location log, city-centroid `geog` | **admin only** / `capture_location` | GiST(geog), (user_id,captured_at desc), (expires_at) |
| `user_segments` | Saved segment definitions (predicate jsonb) | admin only / RPC | pk(id) |
| `segment_members` | Optional materialization of a segment | admin only / RPC | pk(segment_id,user_id) |
| `ad_campaigns` | Email-blast / featured campaign + targeting | **business-scoped** + admin / RPC | (business_id,status), GiST(target_geog), (status) |
| `campaign_sends` | Per-recipient send log (cap + suppression + audit) | **admin only** (advertisers get aggregate RPC) / RPC | (user_id,sent_at) partial, unique(unsubscribe_token), (campaign_id,status) |
| `featured_placements` | Time-boxed in-app/newsletter ad slot | member(own)+**active public** / RPC | (surface,starts_at,ends_at) partial, GiST(region_geog), (business_id,starts_at) |
| `email_suppressions` | Unsub/bounce/complaint kill-switch | admin only / RPC | unique(email), (user_id) |
| `newsletter_editions` | Periodic newsletter issue | **sent public** + admin / RPC | pk(id), unique(slug) |
| `newsletter_sends` | Per-recipient newsletter log | admin only / RPC | (user_id,sent_at) partial, unique(unsubscribe_token) |
| `analytics_events` | First-party events, no PII, coarse region | admin read / **client insert own** | BRIN(occurred_at), (event,occurred_at desc) |

---

## 3. The eligibility / targeting query — the heart of the system

Given a campaign, return the users who are **marketing-opted-in AND in-region AND
under both frequency caps AND not suppressed**. It composes cleanly from CTEs:

1. **`latest_loc`** — one row per user: their most recent coarse location
   (`distinct on (user_id) … order by user_id, captured_at desc`). Feeds both the
   geo gate and the `region` label attached to each recipient (for aggregate
   geographic reach).
2. **`candidates`** — everyone with `user_consents.marketing_opt_in = true`.
   Absence of a consent row = not a candidate (opt-in, not opt-out).
3. **Targeting gate** — a candidate passes if the campaign has no geo/segment
   target (unconstrained), OR their centroid is within `radius_km` of
   `target_geog` (`ST_DWithin`, clamped to ≥5 km), OR their `ip_region`/`ip_country`
   matches, OR they are in the campaign's `segment_id` (materialized members or
   dynamic predicate via `segment_user_ids`).
4. **Suppression gate** — `not exists` a row in `email_suppressions` matching the
   user's `user_id` **or** their `auth.users.email` (case-insensitive).
5. **Frequency gate** — `promo_sends_last_7d(user_id) < promo_weekly_cap()`
   (platform cap across campaigns + newsletter) **AND**
   `campaign_sends_last_7d(user_id, campaign_id) < ad_campaigns.frequency_per_week`
   (per-campaign cap).

The full `campaign_eligible_recipients` body is in §7.13; the same CTE is reused
by `estimate_campaign_reach` which returns `count(*)` only (advertiser sees "~N
reachable", never who). Both are `SECURITY DEFINER` and gated so only admins or
the service-role delivery worker can enumerate recipients — an advertiser can
never call the recipient-listing form.

---

## 4. SECURITY DEFINER RPC surface

All are `security definer`, `set search_path=''`, re-check authorization
server-side, and (for state changes) write a `moderation_actions` audit row.
`42501` → HTTP 403 at PostgREST. Full bodies for the load-bearing ones are in §7;
the rest are signature + behavior.

### Consent & location
| RPC | Behavior |
| --- | --- |
| `set_consent(p_marketing bool, p_location bool, p_gpc bool, p_source text) → user_consents` | Upserts the caller's row; stamps `consent_updated_at` + per-flag `*_opt_in_at`. **Couples to suppression:** marketing→false inserts a `global_optout` suppression for the caller's email; marketing→true deletes the caller's `unsubscribe`/`global_optout` suppressions (bounce/complaint stay). If `p_gpc` true, forces marketing off (CPRA GPC = opt-out signal). |
| `capture_location(p_ip_city text, p_ip_region text, p_ip_country text, p_lat float8, p_lng float8, p_source text) → void` | Sign-in hook. Inserts a `user_locations` row for `auth.uid()` **only if `location_opt_in`**; builds `geog` from the city centroid; sets `expires_at`. Never receives a raw IP. No-op (not an error) when consent absent. |

### Campaign lifecycle (A5)
| RPC | Behavior |
| --- | --- |
| `create_campaign(p_business_id, p_type, p_targeting jsonb, p_creative jsonb, p_starts_at, p_ends_at, p_frequency_per_week, p_segment_id) → uuid` | Manager of `p_business_id` creates a `draft`. Checks the plan actually allows the type (`can_send_blast`/`can_feature`). Coerces `radius_km` to ≥5. Audit `create_campaign`. |
| `submit_campaign(p_campaign_id) → void` | Manager moves `draft`/`rejected`→`pending_review`; validates creative completeness + coarse targeting; stamps `submitted_at`. Audit `submit_campaign`. |
| `admin_review_campaign(p_campaign_id, p_approve bool, p_notes text) → void` | Admin → `approved` (or `running` if within window) / `rejected`. For a `featured` campaign, approval calls `activate_featured_from_campaign`. Audit `approve_campaign`/`reject_campaign`. |
| `pause_campaign(p_campaign_id)` / `resume_campaign(p_campaign_id) → void` | Manager or admin toggles `running`↔`paused`. Audit. |

### Send path (A6) — consent + suppression + cap enforced HERE
| RPC | Behavior |
| --- | --- |
| `campaign_eligible_recipients(p_campaign_id) → table(user_id uuid, email text, region text)` | The §3 query. Admin or service-role only. |
| `estimate_campaign_reach(p_business_id, p_target_region, p_target_country, p_lat, p_lng, p_radius_km, p_segment_id) → int` | Same targeting CTE, returns `count(*)` only. Gated `is_business_manager(p_business_id) or is_admin`. Powers the advertiser's "estimated reach" without exposing identities. |
| `record_campaign_send(p_campaign_id, p_user_id, p_channel, p_status, p_resend_message_id, p_skip_reason) → uuid` | Inserts a `campaign_sends` row. When `p_status='sent'`, **re-verifies** `is_promo_eligible` (defense-in-depth against races) and downgrades to `skipped` if the user became ineligible. Stamps `sent_at`, captures coarse `region`, mints `unsubscribe_token`. Admin/service-role only. |
| `unsubscribe_by_token(p_token uuid) → void` | **Anon-callable** (CAN-SPAM one-click + RFC 8058 List-Unsubscribe-Post). Finds the send (campaign or newsletter) by token, suppresses the email (`unsubscribe`), sets `marketing_opt_in=false` if the user is known. Idempotent. Audit `unsubscribe`. |
| `campaign_reach(p_campaign_id) → record` | Aggregate counts (`queued/sent/delivered/bounced/complained/unsubscribed/skipped`) for the advertiser console. Gated `is_business_member(business_id) or is_admin`. **Never returns user_ids.** |

### Featured placements (A7) & newsletter (A8)
| RPC | Behavior |
| --- | --- |
| `admin_grant_featured_placement(p_business_id, p_bathroom_id, p_surface, p_region, p_lat, p_lng, p_radius_km, p_starts_at, p_ends_at, p_edition_id) → uuid` | Admin creates a placement; enforces `can_feature` (plan `featured_per_week` vs count in trailing 7d). Audit `grant_featured`. |
| `activate_featured_from_campaign(p_campaign_id) → int` | Materializes placement rows from an approved `featured` campaign; entitlement-checked. Returns count created. |
| `active_featured_placements(p_surface, p_region, p_lat, p_lng) → setof featured_placements` | **`SECURITY INVOKER`** read for the app to render ads; relies on the "active placements are public" policy. Returns active, in-window rows for the surface near a coarse point/region. No user data. |
| `admin_create_newsletter(...)`, `admin_schedule_newsletter(id, at)`, `record_newsletter_send(...)` | Admin authors/schedules an edition; `record_newsletter_send` mirrors `record_campaign_send` (consent+suppression+cap, mints token). |

### Segments (A3/A11), entitlements (A9/A12), analytics (A4)
| RPC | Behavior |
| --- | --- |
| `admin_create_segment(p_name, p_predicate jsonb) → uuid` / `admin_materialize_segment(p_segment_id) → int` | Admin defines / refreshes a segment. Predicate DSL owned by A3. |
| `segment_user_ids(p_segment_id) → table(user_id uuid)` | Resolves a segment to user_ids (materialized `segment_members`, or dynamic predicate). Internal to the eligibility query. |
| `business_plan(p_business_id) → plans` | The business's current plan row (join `subscriptions`). Gated member/admin. |
| `entitlement_int(p_business_id, p_feature) → int` | Cap for a feature (typed `plans` column, overridden by `plan_features`); `null` = unlimited. |
| `can_send_blast(p_business_id) → bool`, `can_add_location(p_business_id) → bool`, `can_feature(p_business_id) → bool` | Used in RPC guards and surfaced to the advertiser console. |
| `admin_upsert_plan(...)` | Admin (A9's console) edits a plan row. Audit `update_plan`. |
| `log_event(p_event, p_props jsonb, p_session_id, p_region, p_country) → void` | Optional consent-aware server-side event write. High-volume client events use the direct INSERT policy instead (cheaper). |

---

## 5. Reconciliation with the existing schema

- **`ad_campaigns.business_id → public.businesses(id)`** (`on delete cascade`);
  `featured_placements.business_id` likewise. Campaign authorship reuses
  `is_business_member`/`is_business_manager` from `20260711000000`.
- **`subscriptions.plan → plans(key)`.** New FK on the existing column. Existing
  rows hold `'standard'`; I seed a `'standard'` plan so the FK validates. Adding
  the FK is the only change this migration makes to an existing table's shape
  (plus the two `moderation_actions` CHECK swaps below).
- **Reuse `is_admin()` / `is_moderator()`** for all admin-only RLS and RPC guards;
  no new role machinery.
- **Audit → `public.moderation_actions`** with `detail jsonb`, exactly as the
  moderation and business RPCs do. New **action** verbs: `create_campaign`,
  `submit_campaign`, `approve_campaign`, `reject_campaign`, `pause_campaign`,
  `resume_campaign`, `send_campaign`, `grant_featured`, `revoke_featured`,
  `create_segment`, `materialize_segment`, `suppress_email`, `unsubscribe`,
  `create_newsletter`, `send_newsletter`, `update_plan`. New **target_type**
  values: `campaign`, `placement`, `segment`, `suppression`, `newsletter`,
  `business`, `user`, `plan`.

  > **⚠ Latent bug found & fixed here.** `20260711000000_business_accounts.sql`
  > has `admin_approve_access_request` insert `target_type='business'` into
  > `moderation_actions`, but that migration **only extended the `action` CHECK,
  > not the `target_type` CHECK** (still `('review','bathroom','report','profile')`
  > from `20260710020000`). So approving an access request currently violates the
  > `moderation_actions_target_type_check` constraint. My migration drops and
  > re-adds **both** CHECKs with the full vocabulary (incl. `'business'`), which
  > repairs the existing path as a side effect. Flag to A14/orchestrator.

---

## 6. Invented fields & anticipated cross-agent requests

The `docs/growth/` dir was empty when I wrote this, so there are no literal
"REQUEST TO A2" lines yet. Fields I added beyond the contract's canonical list,
and why (all are the schema's to own — other agents should reference these names):

| Field / object | Why | For agent |
| --- | --- | --- |
| `user_consents.marketing_opt_in_at` / `location_opt_in_at` | Proof-of-consent timestamp (GDPR Art. 7(1) / CPRA) — *when* each flag was granted, distinct from last-touch `consent_updated_at`. | A1 |
| `growth_settings` table + `promo_weekly_cap` | Makes the "configurable" frequency cap real without a deploy; home for retention knobs. | A12, A13 |
| `campaign_sends.skip_reason` / status `'skipped'` | Records *why* an eligible-looking recipient was dropped (`suppressed`/`freq_cap`/`not_opted_in`/`out_of_region`) — needed for deliverability debugging + advertiser transparency. | A6, A10 |
| `campaign_sends.region`, `analytics_events.region/country`, `newsletter_editions.region` | Coarse geo denormalized at write time so aggregate reach/analytics never need to touch `user_locations` (admin-only). | A4, A10, A11 |
| `featured_placements.surface = 'newsletter'` + `edition_id`, `region_geog`, `radius_km`, `priority` | Contract says the newsletter "may embed featured_placements slots"; needed a surface + edition link. `region_geog`/`radius_km` give featured slots the same coarse geo-targeting as campaigns. | A7, A8 |
| `ad_campaigns.target_country`, `submitted_at`, `reviewed_by/at`, `review_notes` | Country-level targeting (coarsest tier) + the review workflow columns A5 needs. | A5 |
| `email_suppressions.reason='global_optout'` + `campaign_id` provenance | Distinguishes a user-level kill-switch from a per-message unsubscribe; links a suppression to the send that caused it. | A1, A6 |
| `plans` typed caps + `plan_features` EAV | A9 owns values; I own the shape the code checks. | A9, A12 |

---

## 7. THE MIGRATION (one-shot, ordered, ready to apply)

> Drop into `supabase/migrations/20260712000000_growth_platform.sql`. Ordered so
> every function exists before the policy/RPC that calls it, and every FK target
> exists before the FK. Heavily commented in the house style.

```sql
-- Watrloo: growth platform — consent, coarse location, CRM, ad campaigns,
-- featured placements, newsletter, suppressions, first-party analytics, plans.
--
-- Extends the live schema in place. RLS on every table. Mutations go through
-- SECURITY DEFINER RPCs that re-check role/consent and audit to
-- moderation_actions. PostGIS lives in the `extensions` schema (installed by
-- 20260710010000); all spatial calls are schema-qualified. Coarse location only:
-- city-centroid geog, never a raw IP, never street level. Consent is opt-in;
-- absence of a row = no consent. Consent + suppression + frequency cap are
-- enforced at SEND time by the RPCs, not just at signup.

-- ===========================================================================
-- 0. Tunable settings (configurable caps / retention windows)
-- ===========================================================================
create table public.growth_settings (
  key        text primary key,
  int_value  integer,
  text_value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

insert into public.growth_settings (key, int_value) values
  ('promo_weekly_cap', 3),           -- max promotional messages / user / 7 days
  ('location_retention_days', 90),   -- user_locations purge horizon
  ('analytics_retention_days', 365)  -- analytics_events purge horizon
on conflict (key) do nothing;

alter table public.growth_settings enable row level security;
grant select on public.growth_settings to authenticated;
create policy "admins read growth settings"
  on public.growth_settings for select to authenticated
  using ((select public.is_admin()));
-- Writes: admin RPC / service_role only (no write policy).

create or replace function public.setting_int(p_key text, p_default integer)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select int_value from public.growth_settings where key = p_key),
    p_default);
$$;

create or replace function public.promo_weekly_cap()
returns integer
language sql stable security definer set search_path = ''
as $$ select public.setting_int('promo_weekly_cap', 3); $$;

grant execute on function public.setting_int(text, integer) to authenticated;
grant execute on function public.promo_weekly_cap() to authenticated;

-- ===========================================================================
-- 1. Plans + entitlements. A9 PRICING owns the ROWS; this owns the SHAPE.
--    Keyed by the same text `subscriptions.plan` already stores.
-- ===========================================================================
create table public.plans (
  key             text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  name            text not null check (char_length(name) between 1 and 80),
  description     text check (char_length(description) <= 500),
  price_cents     integer not null default 0 check (price_cents >= 0),
  billing_period  text not null default 'month' check (billing_period in ('month','year')),
  -- Typed entitlement caps the code checks in hot paths. NULL = unlimited.
  max_locations   integer check (max_locations is null or max_locations >= 1),
  blasts_per_month  integer not null default 0 check (blasts_per_month >= 0),
  featured_per_week integer not null default 0 check (featured_per_week >= 0),
  team_seats      integer check (team_seats is null or team_seats >= 1),
  analytics_level text not null default 'basic' check (analytics_level in ('none','basic','advanced')),
  csv_import      boolean not null default false,
  api_access      boolean not null default false,
  sort_order      integer not null default 0,
  is_public       boolean not null default true,   -- shown on the pricing page
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Optional EAV overrides / feature flags A9 hasn't first-classed as a column.
create table public.plan_features (
  plan_key   text not null references public.plans (key) on delete cascade,
  feature    text not null check (char_length(feature) between 1 and 60),
  int_value  integer,
  bool_value boolean,
  text_value text,
  primary key (plan_key, feature)
);

-- FK-satisfying PLACEHOLDER rows. A9 replaces prices/caps; 'standard' exists so
-- the FK on the live subscriptions.plan default validates.
insert into public.plans (key, name, price_cents, max_locations, blasts_per_month, featured_per_week, team_seats, analytics_level, csv_import, api_access, sort_order) values
  ('standard',  'Standard (legacy alias)', 1000, 1,    2,  1, 2,    'basic',    false, false, 0),
  ('small',     'Small',                   1000, 1,    2,  1, 2,    'basic',    false, false, 1),
  ('growth',    'Growth',                  3000, 5,    8,  3, 5,    'advanced', true,  false, 2),
  ('chain',     'Chain',                   9000, 50,   30, 10, 20,  'advanced', true,  true,  3),
  ('enterprise','Enterprise',              0,    null, 200, 40, null,'advanced', true,  true,  4)
on conflict (key) do nothing;

alter table public.plans         enable row level security;
alter table public.plan_features enable row level security;
grant select on public.plans         to anon, authenticated;  -- pricing page is public
grant select on public.plan_features to anon, authenticated;
create policy "plans are viewable by everyone"
  on public.plans for select using (is_public or (select public.is_admin()));
create policy "plan features are viewable by everyone"
  on public.plan_features for select using (true);
-- Writes: admin_upsert_plan / service_role only.

-- Tie the existing subscriptions.plan to a real plan. Existing rows are
-- 'standard', which we seeded above, so this validates.
alter table public.subscriptions
  add constraint subscriptions_plan_fkey
  foreign key (plan) references public.plans (key);

-- ===========================================================================
-- 2. Consent — one row per user. Absence = no consent. Own-row RLS; writes via
--    set_consent so timestamps + the consent<->suppression link stay consistent.
-- ===========================================================================
create table public.user_consents (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  marketing_opt_in    boolean not null default false,
  location_opt_in     boolean not null default false,
  gpc_detected        boolean not null default false,
  source              text check (char_length(source) <= 100),  -- 'signup'|'settings'|'banner'|...
  marketing_opt_in_at timestamptz,   -- proof-of-consent (A1): when granted
  location_opt_in_at  timestamptz,
  consent_updated_at  timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

alter table public.user_consents enable row level security;
grant select on public.user_consents to authenticated;
create policy "users read their own consent"
  on public.user_consents for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));
-- Writes via set_consent only (keeps timestamps + suppression coupling atomic).

-- ===========================================================================
-- 3. Coarse location log — ADMIN ONLY. City-centroid geog, never a raw IP.
--    Retention-limited via expires_at (+ a pg_cron purge, scheduled by A13).
-- ===========================================================================
create table public.user_locations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  captured_at timestamptz not null default now(),
  ip_city    text check (char_length(ip_city) <= 120),
  ip_region  text check (char_length(ip_region) <= 120),   -- state / province
  ip_country text check (char_length(ip_country) <= 2),     -- ISO 3166-1 alpha-2
  geog       extensions.geography(Point, 4326),             -- CITY CENTROID, not precise
  source     text check (char_length(source) <= 40),        -- 'signin'|'geoip'|'manual'
  expires_at timestamptz not null default (now() + interval '90 days')
);
create index user_locations_user_recent_idx on public.user_locations (user_id, captured_at desc);
create index user_locations_geog_idx on public.user_locations using gist (geog);
create index user_locations_expires_idx on public.user_locations (expires_at);
create index user_locations_country_idx on public.user_locations (ip_country);

alter table public.user_locations enable row level security;
grant select on public.user_locations to authenticated;   -- RLS narrows to admin
create policy "admins read all locations"
  on public.user_locations for select to authenticated
  using ((select public.is_admin()));
-- Writes via capture_location only.

-- ===========================================================================
-- 4. Segments — saved CRM definitions + optional materialization. ADMIN ONLY.
-- ===========================================================================
create table public.user_segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 1000),
  predicate   jsonb not null default '{}'::jsonb,  -- DSL owned by A3 LOCATION
  is_dynamic  boolean not null default true,       -- true = evaluate live; false = use segment_members
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.segment_members (
  segment_id uuid not null references public.user_segments (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (segment_id, user_id)
);
create index segment_members_user_idx on public.segment_members (user_id);

alter table public.user_segments   enable row level security;
alter table public.segment_members enable row level security;
grant select on public.user_segments   to authenticated;
grant select on public.segment_members to authenticated;
create policy "admins read segments"
  on public.user_segments for select to authenticated
  using ((select public.is_admin()));
create policy "admins read segment members"
  on public.segment_members for select to authenticated
  using ((select public.is_admin()));
-- Writes via admin_create_segment / admin_materialize_segment only.

-- ===========================================================================
-- 5. Email suppressions — unsub/bounce/complaint kill-switch. ADMIN ONLY read.
--    Presence of a row for an email = suppressed. Checked at SEND time.
-- ===========================================================================
create table public.email_suppressions (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,   -- store lowercased
  user_id     uuid references auth.users (id) on delete set null,
  reason      text not null check (reason in ('unsubscribe','bounce','complaint','manual','global_optout')),
  source      text check (char_length(source) <= 40),  -- 'one_click'|'list_unsub'|'resend_webhook'|'admin'
  campaign_id uuid references public.ad_campaigns (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (email)   -- one row per address = the kill switch
);
create index email_suppressions_user_idx on public.email_suppressions (user_id);

alter table public.email_suppressions enable row level security;
grant select on public.email_suppressions to authenticated;   -- RLS narrows to admin
create policy "admins read suppressions"
  on public.email_suppressions for select to authenticated
  using ((select public.is_admin()));
-- Writes via set_consent / unsubscribe_by_token / webhook(service_role) / admin RPC.

-- ===========================================================================
-- 6. Ad campaigns — business-scoped. Targeting is COARSE (radius >= 5km on a
--    city centroid). Lifecycle status advances only through the RPCs.
-- ===========================================================================
create table public.ad_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses (id) on delete cascade,
  type               text not null check (type in ('email_blast','featured')),
  status             text not null default 'draft'
                     check (status in ('draft','pending_review','approved','running','paused','done','rejected')),
  -- targeting (any subset; all NULL = untargeted / whole audience)
  target_region      text check (char_length(target_region) <= 120),
  target_country     text check (char_length(target_country) <= 2),
  target_geog        extensions.geography(Point, 4326),   -- city centroid
  radius_km          double precision check (radius_km is null or radius_km between 5 and 500),
  segment_id         uuid references public.user_segments (id) on delete set null,
  -- schedule + cap
  starts_at          timestamptz,
  ends_at            timestamptz,
  frequency_per_week smallint not null default 3 check (frequency_per_week between 1 and 7),
  -- creative: {subject, body_html, body_text, image_url, link_url, cta}
  creative           jsonb not null default '{}'::jsonb,
  -- review workflow
  submitted_at       timestamptz,
  reviewed_by        uuid references public.profiles (id) on delete set null,
  reviewed_at        timestamptz,
  review_notes       text check (char_length(review_notes) <= 2000),
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index ad_campaigns_business_idx on public.ad_campaigns (business_id, status);
create index ad_campaigns_status_idx   on public.ad_campaigns (status)
  where status in ('approved','running');
create index ad_campaigns_target_geog_idx on public.ad_campaigns using gist (target_geog);
create index ad_campaigns_segment_idx on public.ad_campaigns (segment_id);

alter table public.ad_campaigns enable row level security;
grant select, insert, update on public.ad_campaigns to authenticated;
-- Members see ONLY their own business's campaigns; admins see all.
create policy "members read their campaigns"
  on public.ad_campaigns for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
-- Managers create drafts for their business (status pinned to draft).
create policy "managers create draft campaigns"
  on public.ad_campaigns for insert to authenticated
  with check (
    (select public.is_business_manager(business_id))
    and status = 'draft'
    and created_by = (select auth.uid())
  );
-- Managers edit content ONLY while draft/rejected; status is pinned so they can
-- never self-approve. All forward transitions go through the RPCs (definer).
create policy "managers edit their draft campaigns"
  on public.ad_campaigns for update to authenticated
  using ((select public.is_business_manager(business_id)) and status in ('draft','rejected'))
  with check ((select public.is_business_manager(business_id)) and status in ('draft','rejected'));

-- ===========================================================================
-- 7. Campaign sends — per-recipient log. ADMIN ONLY (advertisers get aggregate
--    counts via campaign_reach). Powers cap + suppression + audit + reach.
-- ===========================================================================
create table public.campaign_sends (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.ad_campaigns (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,  -- survives account deletion
  channel           text not null default 'email' check (channel in ('email','in_app','newsletter')),
  status            text not null default 'queued'
                    check (status in ('queued','sent','delivered','bounced','complained','failed','skipped')),
  skip_reason       text check (skip_reason in ('not_opted_in','suppressed','freq_cap','out_of_region')),
  unsubscribe_token uuid not null default gen_random_uuid(),
  region            text check (char_length(region) <= 120),  -- coarse, denormalized for aggregate reach
  resend_message_id text,
  queued_at         timestamptz not null default now(),
  sent_at           timestamptz,
  updated_at        timestamptz not null default now()
);
-- Frequency-cap lookup: "how many promos has this user had recently".
create index campaign_sends_user_sent_idx on public.campaign_sends (user_id, sent_at desc)
  where status in ('sent','delivered');
-- Per-campaign frequency + duplicate-suppression lookup.
create index campaign_sends_campaign_user_idx on public.campaign_sends (campaign_id, user_id);
-- Aggregate reach counts.
create index campaign_sends_campaign_status_idx on public.campaign_sends (campaign_id, status);
create unique index campaign_sends_token_idx on public.campaign_sends (unsubscribe_token);

alter table public.campaign_sends enable row level security;
grant select on public.campaign_sends to authenticated;   -- RLS narrows to admin
create policy "admins read campaign sends"
  on public.campaign_sends for select to authenticated
  using ((select public.is_admin()));
-- Writes via record_campaign_send only. Advertisers use campaign_reach (counts).

-- ===========================================================================
-- 8. Featured placements — time-boxed slot. Member sees own; ACTIVE ones public
--    so the app can render the ad. Frequency-limited per week via can_feature.
-- ===========================================================================
create table public.featured_placements (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.ad_campaigns (id) on delete set null,
  business_id uuid not null references public.businesses (id) on delete cascade,
  bathroom_id uuid references public.bathrooms (id) on delete set null,  -- promoted listing
  surface     text not null check (surface in ('map','browse','detail','newsletter')),
  region      text check (char_length(region) <= 120),
  region_geog extensions.geography(Point, 4326),
  radius_km   double precision check (radius_km is null or radius_km between 5 and 500),
  edition_id  uuid references public.newsletter_editions (id) on delete set null, -- when surface='newsletter'
  priority    smallint not null default 0,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      text not null default 'scheduled'
              check (status in ('scheduled','active','paused','done','rejected')),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (ends_at >= starts_at)
);
create index featured_active_idx on public.featured_placements (surface, starts_at, ends_at)
  where status = 'active';
create index featured_geog_idx on public.featured_placements using gist (region_geog);
create index featured_business_idx on public.featured_placements (business_id, starts_at desc);
create index featured_edition_idx on public.featured_placements (edition_id);

alter table public.featured_placements enable row level security;
grant select on public.featured_placements to anon, authenticated;
-- Active, in-window placements are public so the app can render them (like
-- verified claims). No user PII on the row.
create policy "active placements are public"
  on public.featured_placements for select
  using (status = 'active' and now() between starts_at and ends_at);
-- Business members see all statuses of their own placements; admins see all.
create policy "members read their placements"
  on public.featured_placements for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
-- Writes via admin_grant_featured_placement / activate_featured_from_campaign.

-- ===========================================================================
-- 9. Newsletter — editions + per-recipient sends.
-- ===========================================================================
create table public.newsletter_editions (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 200),
  slug        text unique check (slug ~ '^[a-z0-9-]{1,120}$'),
  status      text not null default 'draft'
              check (status in ('draft','scheduled','sending','sent','archived')),
  subject     text check (char_length(subject) <= 200),
  body_html   text,
  body_text   text,
  region      text check (char_length(region) <= 120),  -- optional coarse targeting
  scheduled_at timestamptz,
  sent_at     timestamptz,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.newsletter_sends (
  id                uuid primary key default gen_random_uuid(),
  edition_id        uuid not null references public.newsletter_editions (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,
  status            text not null default 'queued'
                    check (status in ('queued','sent','delivered','bounced','complained','failed','skipped')),
  skip_reason       text check (skip_reason in ('not_opted_in','suppressed','freq_cap','out_of_region')),
  unsubscribe_token uuid not null default gen_random_uuid(),
  resend_message_id text,
  queued_at         timestamptz not null default now(),
  sent_at           timestamptz,
  unique (edition_id, user_id)
);
create index newsletter_sends_user_sent_idx on public.newsletter_sends (user_id, sent_at desc)
  where status in ('sent','delivered');
create unique index newsletter_sends_token_idx on public.newsletter_sends (unsubscribe_token);

alter table public.newsletter_editions enable row level security;
alter table public.newsletter_sends    enable row level security;
grant select on public.newsletter_editions to anon, authenticated;
grant select on public.newsletter_sends    to authenticated;
-- Sent/archived editions are a public web archive; drafts admin-only.
create policy "sent newsletters are public"
  on public.newsletter_editions for select
  using (status in ('sent','archived') or (select public.is_admin()));
create policy "admins read newsletter sends"
  on public.newsletter_sends for select to authenticated
  using ((select public.is_admin()));

-- ===========================================================================
-- 10. First-party analytics. Admin read; clients insert their OWN events. No
--     PII in props. High-volume: BRIN time index; monthly partitioning is a
--     later scaling step (A4/A13).
-- ===========================================================================
create table public.analytics_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete set null,  -- nullable/anon
  session_id  text check (char_length(session_id) <= 64),          -- opaque, not PII
  event       text not null check (char_length(event) between 1 and 80),
  props       jsonb not null default '{}'::jsonb,                   -- NO PII
  region      text check (char_length(region) <= 120),             -- coarse
  country     text check (char_length(country) <= 2),
  occurred_at timestamptz not null default now(),
  ingested_at timestamptz not null default now()
);
create index analytics_events_time_brin on public.analytics_events using brin (occurred_at);
create index analytics_events_event_idx on public.analytics_events (event, occurred_at desc);
create index analytics_events_user_idx  on public.analytics_events (user_id) where user_id is not null;

alter table public.analytics_events enable row level security;
grant select on public.analytics_events to authenticated;  -- RLS narrows to admin
grant insert on public.analytics_events to anon, authenticated;
create policy "admins read analytics"
  on public.analytics_events for select to authenticated
  using ((select public.is_admin()));
-- Cheap first-party ingestion: a client may write only anonymous events or its
-- own. Consent nuance (attach user_id only with consent) is enforced client-side
-- and, for server writes, by log_event. See A4 ANALYTICS.
create policy "clients log their own events"
  on public.analytics_events for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));

-- ===========================================================================
-- 11. updated_at triggers (reuse public.touch_updated_at from init).
-- ===========================================================================
create trigger plans_touch_updated_at
  before update on public.plans for each row execute function public.touch_updated_at();
create trigger ad_campaigns_touch_updated_at
  before update on public.ad_campaigns for each row execute function public.touch_updated_at();
create trigger campaign_sends_touch_updated_at
  before update on public.campaign_sends for each row execute function public.touch_updated_at();
create trigger user_segments_touch_updated_at
  before update on public.user_segments for each row execute function public.touch_updated_at();
create trigger newsletter_editions_touch_updated_at
  before update on public.newsletter_editions for each row execute function public.touch_updated_at();

-- ===========================================================================
-- 12. Frequency-cap + eligibility helpers.
-- ===========================================================================
-- Promotional messages (campaign + newsletter) a user received in trailing 7d.
create or replace function public.promo_sends_last_7d(p_user_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*) from public.campaign_sends cs
       where cs.user_id = p_user_id and cs.status in ('sent','delivered')
         and cs.sent_at >= now() - interval '7 days')
  + (select count(*) from public.newsletter_sends ns
       where ns.user_id = p_user_id and ns.status in ('sent','delivered')
         and ns.sent_at >= now() - interval '7 days');
$$;

-- Sends of ONE campaign to a user in trailing 7d (per-campaign cap).
create or replace function public.campaign_sends_last_7d(p_user_id uuid, p_campaign_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::int from public.campaign_sends cs
   where cs.user_id = p_user_id and cs.campaign_id = p_campaign_id
     and cs.status in ('sent','delivered')
     and cs.sent_at >= now() - interval '7 days';
$$;

-- Is a user eligible for ANY promo right now: opted-in, not suppressed, under
-- the platform weekly cap. (Per-campaign cap + region are applied by callers.)
create or replace function public.is_promo_eligible(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select
    exists (select 1 from public.user_consents c
              where c.user_id = p_user_id and c.marketing_opt_in)
    and not exists (
      select 1 from public.email_suppressions s
      join auth.users u on u.id = p_user_id
      where s.user_id = p_user_id or lower(s.email) = lower(u.email))
    and public.promo_sends_last_7d(p_user_id) < public.promo_weekly_cap();
$$;

-- Resolve a segment to user_ids (materialized members, else dynamic predicate).
-- Dynamic predicate evaluation is a placeholder; A3 LOCATION owns the DSL.
create or replace function public.segment_user_ids(p_segment_id uuid)
returns table (user_id uuid)
language plpgsql stable security definer set search_path = ''
as $$
declare seg public.user_segments;
begin
  select * into seg from public.user_segments where id = p_segment_id;
  if seg.id is null then return; end if;

  if not seg.is_dynamic then
    return query select m.user_id from public.segment_members m where m.segment_id = p_segment_id;
    return;
  end if;

  -- Minimal dynamic predicate: {country, region, marketing_opt_in, active_since}.
  -- A3 extends this. Uses the latest coarse location per user.
  return query
  with latest_loc as (
    select distinct on (l.user_id) l.user_id, l.ip_region, l.ip_country
    from public.user_locations l order by l.user_id, l.captured_at desc)
  select c.user_id
  from public.user_consents c
  left join latest_loc ll on ll.user_id = c.user_id
  where (not (seg.predicate ? 'marketing_opt_in')
         or c.marketing_opt_in = (seg.predicate->>'marketing_opt_in')::boolean)
    and (not (seg.predicate ? 'country')
         or upper(ll.ip_country) = upper(seg.predicate->>'country'))
    and (not (seg.predicate ? 'region')
         or lower(ll.ip_region) = lower(seg.predicate->>'region'));
end;
$$;

grant execute on function public.promo_sends_last_7d(uuid) to authenticated;
grant execute on function public.campaign_sends_last_7d(uuid, uuid) to authenticated;
grant execute on function public.is_promo_eligible(uuid) to authenticated;
grant execute on function public.segment_user_ids(uuid) to authenticated;

-- ===========================================================================
-- 13. THE eligibility / targeting query — recipients for a campaign.
--     Admin or service-role (delivery worker) only. Advertisers cannot call it.
-- ===========================================================================
create or replace function public.campaign_eligible_recipients(p_campaign_id uuid)
returns table (user_id uuid, email text, region text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  c   public.ad_campaigns;
  cap integer := public.promo_weekly_cap();
begin
  -- authz: admins, or the delivery worker (service_role has no auth.uid()).
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into c from public.ad_campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'no such campaign' using errcode = 'P0002';
  end if;

  return query
  with latest_loc as (
    select distinct on (l.user_id)
           l.user_id, l.geog, l.ip_region, l.ip_country
    from public.user_locations l
    order by l.user_id, l.captured_at desc
  ),
  candidates as (                                   -- opted-in only
    select con.user_id from public.user_consents con where con.marketing_opt_in
  ),
  targeted as (
    select cand.user_id
    from candidates cand
    left join latest_loc ll on ll.user_id = cand.user_id
    where
      -- segment gate
      ( c.segment_id is null
        or cand.user_id in (select s.user_id from public.segment_user_ids(c.segment_id) s) )
      and
      -- coarse geo gate (untargeted, or radius on centroid, or region, or country)
      ( (c.target_geog is null and c.target_region is null and c.target_country is null)
        or (c.target_geog is not null and ll.geog is not null
             and extensions.st_dwithin(
                   ll.geog, c.target_geog,
                   greatest(5, least(coalesce(c.radius_km, 50), 500)) * 1000.0))
        or (c.target_region is not null and ll.ip_region is not null
             and lower(ll.ip_region) = lower(c.target_region))
        or (c.target_country is not null and ll.ip_country is not null
             and upper(ll.ip_country) = upper(c.target_country)) )
  )
  select t.user_id, u.email, coalesce(ll.ip_region, ll.ip_country) as region
  from targeted t
  join auth.users u on u.id = t.user_id
  left join latest_loc ll on ll.user_id = t.user_id
  where u.email is not null
    -- suppression gate (by user_id OR email)
    and not exists (
      select 1 from public.email_suppressions s
      where s.user_id = t.user_id or lower(s.email) = lower(u.email))
    -- platform weekly cap  AND  per-campaign weekly cap
    and public.promo_sends_last_7d(t.user_id) < cap
    and public.campaign_sends_last_7d(t.user_id, p_campaign_id) < c.frequency_per_week;
end;
$$;

-- Advertiser-facing: COUNT of reachable users for a proposed targeting, no ids.
create or replace function public.estimate_campaign_reach(
  p_business_id uuid,
  p_target_region text default null,
  p_target_country text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_km double precision default null,
  p_segment_id uuid default null
)
returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_geog extensions.geography(Point, 4326);
  v_count integer;
begin
  if not ((select public.is_business_manager(p_business_id)) or (select public.is_admin())) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_lat is not null and p_lng is not null then
    v_geog := extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography;
  end if;

  with latest_loc as (
    select distinct on (l.user_id) l.user_id, l.geog, l.ip_region, l.ip_country
    from public.user_locations l order by l.user_id, l.captured_at desc),
  candidates as (
    select con.user_id from public.user_consents con where con.marketing_opt_in)
  select count(*) into v_count
  from candidates cand
  left join latest_loc ll on ll.user_id = cand.user_id
  join auth.users u on u.id = cand.user_id
  where u.email is not null
    and ( p_segment_id is null
          or cand.user_id in (select s.user_id from public.segment_user_ids(p_segment_id) s) )
    and ( (v_geog is null and p_target_region is null and p_target_country is null)
          or (v_geog is not null and ll.geog is not null
               and extensions.st_dwithin(ll.geog, v_geog,
                     greatest(5, least(coalesce(p_radius_km, 50), 500)) * 1000.0))
          or (p_target_region is not null and lower(ll.ip_region) = lower(p_target_region))
          or (p_target_country is not null and upper(ll.ip_country) = upper(p_target_country)) )
    and not exists (
      select 1 from public.email_suppressions s
      where s.user_id = cand.user_id or lower(s.email) = lower(u.email));
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.campaign_eligible_recipients(uuid) to authenticated, service_role;
grant execute on function public.estimate_campaign_reach(uuid, text, text, double precision, double precision, double precision, uuid) to authenticated;

-- ===========================================================================
-- 14. Consent + location capture RPCs.
-- ===========================================================================
create or replace function public.set_consent(
  p_marketing boolean, p_location boolean, p_gpc boolean default false, p_source text default 'settings')
returns public.user_consents
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  v_marketing boolean := p_marketing;
  v_email text;
  v_row public.user_consents;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  -- GPC is a legally-binding opt-out signal (CPRA): it forces marketing off.
  if p_gpc then v_marketing := false; end if;

  insert into public.user_consents as c
    (user_id, marketing_opt_in, location_opt_in, gpc_detected, source,
     marketing_opt_in_at, location_opt_in_at, consent_updated_at)
  values (uid, v_marketing, p_location, p_gpc, p_source,
     case when v_marketing then now() end,
     case when p_location  then now() end, now())
  on conflict (user_id) do update set
     marketing_opt_in = excluded.marketing_opt_in,
     location_opt_in  = excluded.location_opt_in,
     gpc_detected     = excluded.gpc_detected,
     source           = excluded.source,
     marketing_opt_in_at = case when excluded.marketing_opt_in and not c.marketing_opt_in
                                then now() else c.marketing_opt_in_at end,
     location_opt_in_at  = case when excluded.location_opt_in and not c.location_opt_in
                                then now() else c.location_opt_in_at end,
     consent_updated_at = now()
  returning * into v_row;

  select email into v_email from auth.users where id = uid;
  if not v_marketing then
    -- Opting out = global kill switch.
    insert into public.email_suppressions (email, user_id, reason, source)
    values (lower(v_email), uid, 'global_optout', 'consent')
    on conflict (email) do update set reason = 'global_optout', user_id = uid;
  else
    -- Re-subscribing clears user-driven suppressions, NOT bounces/complaints.
    delete from public.email_suppressions
     where user_id = uid and reason in ('unsubscribe','global_optout');
  end if;
  return v_row;
end;
$$;

create or replace function public.capture_location(
  p_ip_city text, p_ip_region text, p_ip_country text,
  p_lat double precision, p_lng double precision, p_source text default 'signin')
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  v_days integer := public.setting_int('location_retention_days', 90);
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  -- Silently no-op without location consent (not an error — keeps sign-in clean).
  if not exists (select 1 from public.user_consents c
                 where c.user_id = uid and c.location_opt_in) then
    return;
  end if;

  insert into public.user_locations (user_id, ip_city, ip_region, ip_country, geog, source, expires_at)
  values (uid, p_ip_city, p_ip_region, upper(left(p_ip_country, 2)),
    case when p_lat is not null and p_lng is not null
      then extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography end,
    p_source, now() + make_interval(days => v_days));
end;
$$;

grant execute on function public.set_consent(boolean, boolean, boolean, text) to authenticated;
grant execute on function public.capture_location(text, text, text, double precision, double precision, text) to authenticated;

-- ===========================================================================
-- 15. Unsubscribe by token — anon-callable (CAN-SPAM one-click / RFC 8058).
-- ===========================================================================
create or replace function public.unsubscribe_by_token(p_token uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_email text;
  v_campaign uuid;
begin
  -- Look up the token in campaign sends, then newsletter sends.
  select cs.user_id, cs.campaign_id into v_user, v_campaign
  from public.campaign_sends cs where cs.unsubscribe_token = p_token;
  if not found then
    select ns.user_id into v_user
    from public.newsletter_sends ns where ns.unsubscribe_token = p_token;
    if not found then return; end if;   -- unknown token: no-op, never error
  end if;

  if v_user is not null then
    select email into v_email from auth.users where id = v_user;
    update public.user_consents set marketing_opt_in = false, consent_updated_at = now()
     where user_id = v_user;
  end if;

  if v_email is not null then
    insert into public.email_suppressions (email, user_id, reason, source, campaign_id)
    values (lower(v_email), v_user, 'unsubscribe', 'one_click', v_campaign)
    on conflict (email) do update set reason = 'unsubscribe';
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values (v_user, 'unsubscribe', 'user', coalesce(v_user, gen_random_uuid()),
          jsonb_build_object('token', p_token, 'campaign', v_campaign));
end;
$$;

grant execute on function public.unsubscribe_by_token(uuid) to anon, authenticated;

-- ===========================================================================
-- 16. Analytics log RPC (consent-aware server-side path; clients may INSERT).
-- ===========================================================================
create or replace function public.log_event(
  p_event text, p_props jsonb default '{}'::jsonb, p_session_id text default null,
  p_region text default null, p_country text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := (select auth.uid());
begin
  insert into public.analytics_events (user_id, session_id, event, props, region, country)
  values (uid, p_session_id, left(p_event, 80), coalesce(p_props, '{}'::jsonb),
          p_region, upper(left(p_country, 2)));
end;
$$;
grant execute on function public.log_event(text, jsonb, text, text, text) to anon, authenticated;

-- ===========================================================================
-- 17. Entitlement helpers (A9 caps / A12 limits).
-- ===========================================================================
create or replace function public.business_plan(p_business_id uuid)
returns public.plans
language sql stable security definer set search_path = ''
as $$
  select p.* from public.plans p
  join public.subscriptions s on s.plan = p.key
  where s.business_id = p_business_id;
$$;

create or replace function public.entitlement_int(p_business_id uuid, p_feature text)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select pf.int_value from public.plan_features pf
       join public.subscriptions s on s.plan = pf.plan_key
      where s.business_id = p_business_id and pf.feature = p_feature),
    (select case p_feature
              when 'max_locations'     then p.max_locations
              when 'blasts_per_month'  then p.blasts_per_month
              when 'featured_per_week' then p.featured_per_week
              when 'team_seats'        then p.team_seats
            end
       from public.plans p join public.subscriptions s on s.plan = p.key
      where s.business_id = p_business_id));
$$;

create or replace function public.can_add_location(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select count(*) from public.bathroom_claims c
       where c.business_id = p_business_id and c.status = 'verified')
    < public.entitlement_int(p_business_id, 'max_locations'), true);  -- null cap = unlimited
$$;

create or replace function public.can_send_blast(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select count(*) from public.ad_campaigns a
       where a.business_id = p_business_id and a.type = 'email_blast'
         and a.status in ('approved','running','done')
         and date_trunc('month', coalesce(a.starts_at, a.submitted_at, a.created_at))
             = date_trunc('month', now()))
    < public.entitlement_int(p_business_id, 'blasts_per_month'), true);
$$;

create or replace function public.can_feature(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select count(*) from public.featured_placements f
       where f.business_id = p_business_id
         and f.starts_at >= now() - interval '7 days')
    < public.entitlement_int(p_business_id, 'featured_per_week'), true);
$$;

grant execute on function public.business_plan(uuid)      to authenticated;
grant execute on function public.entitlement_int(uuid, text) to authenticated;
grant execute on function public.can_add_location(uuid)   to authenticated;
grant execute on function public.can_send_blast(uuid)     to authenticated;
grant execute on function public.can_feature(uuid)        to authenticated;

-- ===========================================================================
-- 18. Campaign lifecycle RPCs (A5). Guards + audit; status advances here only.
-- ===========================================================================
create or replace function public.create_campaign(
  p_business_id uuid, p_type text, p_targeting jsonb, p_creative jsonb,
  p_starts_at timestamptz default null, p_ends_at timestamptz default null,
  p_frequency_per_week smallint default 3, p_segment_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_geog extensions.geography(Point, 4326);
begin
  if not (select public.is_business_manager(p_business_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_type not in ('email_blast','featured') then
    raise exception 'invalid type' using errcode = '22023';
  end if;
  if p_type = 'email_blast' and not public.can_send_blast(p_business_id) then
    raise exception 'blast allowance exhausted' using errcode = '22023';
  end if;
  if p_type = 'featured' and not public.can_feature(p_business_id) then
    raise exception 'featured allowance exhausted' using errcode = '22023';
  end if;
  if (p_targeting ? 'lat') and (p_targeting ? 'lng') then
    v_geog := extensions.st_setsrid(
      extensions.st_point((p_targeting->>'lng')::float8, (p_targeting->>'lat')::float8), 4326)::extensions.geography;
  end if;

  insert into public.ad_campaigns
    (business_id, type, status, target_region, target_country, target_geog, radius_km,
     segment_id, starts_at, ends_at, frequency_per_week, creative, created_by)
  values (p_business_id, p_type, 'draft',
     p_targeting->>'region', upper(left(p_targeting->>'country', 2)), v_geog,
     greatest(5, coalesce((p_targeting->>'radius_km')::float8, 50)),
     p_segment_id, p_starts_at, p_ends_at,
     greatest(1, least(coalesce(p_frequency_per_week, 3), 7)), coalesce(p_creative,'{}'::jsonb),
     (select auth.uid()))
  returning id into v_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'create_campaign', 'campaign', v_id,
          jsonb_build_object('business', p_business_id, 'type', p_type));
  return v_id;
end;
$$;

create or replace function public.submit_campaign(p_campaign_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ad_campaigns;
begin
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v.id is null or not (select public.is_business_manager(v.business_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v.status not in ('draft','rejected') then
    raise exception 'not editable' using errcode = '22023';
  end if;
  if coalesce(v.creative->>'subject','') = '' or coalesce(v.creative->>'body_html','') = '' then
    raise exception 'creative incomplete' using errcode = '22023';
  end if;

  update public.ad_campaigns set status = 'pending_review', submitted_at = now()
   where id = p_campaign_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'submit_campaign', 'campaign', p_campaign_id);
end;
$$;

create or replace function public.admin_review_campaign(
  p_campaign_id uuid, p_approve boolean, p_notes text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.ad_campaigns;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v.id is null or v.status <> 'pending_review' then
    raise exception 'not pending review' using errcode = '22023';
  end if;

  update public.ad_campaigns set
     status = case when p_approve then
                case when now() between coalesce(starts_at, now()) and coalesce(ends_at, 'infinity'::timestamptz)
                     then 'running' else 'approved' end
              else 'rejected' end,
     reviewed_by = (select auth.uid()), reviewed_at = now(), review_notes = p_notes
   where id = p_campaign_id;

  if p_approve and v.type = 'featured' then
    perform public.activate_featured_from_campaign(p_campaign_id);
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case when p_approve then 'approve_campaign' else 'reject_campaign' end,
          'campaign', p_campaign_id, jsonb_build_object('notes', p_notes));
end;
$$;

create or replace function public.pause_campaign(p_campaign_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v public.ad_campaigns;
begin
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v.id is null or not ((select public.is_business_manager(v.business_id)) or (select public.is_admin())) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.ad_campaigns set status = 'paused' where id = p_campaign_id and status = 'running';
  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'pause_campaign', 'campaign', p_campaign_id);
end;
$$;

create or replace function public.resume_campaign(p_campaign_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v public.ad_campaigns;
begin
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v.id is null or not ((select public.is_business_manager(v.business_id)) or (select public.is_admin())) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.ad_campaigns set status = 'running' where id = p_campaign_id and status = 'paused';
  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'resume_campaign', 'campaign', p_campaign_id);
end;
$$;

grant execute on function public.create_campaign(uuid, text, jsonb, jsonb, timestamptz, timestamptz, smallint, uuid) to authenticated;
grant execute on function public.submit_campaign(uuid)                to authenticated;
grant execute on function public.admin_review_campaign(uuid, boolean, text) to authenticated;
grant execute on function public.pause_campaign(uuid)                 to authenticated;
grant execute on function public.resume_campaign(uuid)                to authenticated;

-- ===========================================================================
-- 19. Send-path record + advertiser aggregate reach.
-- ===========================================================================
create or replace function public.record_campaign_send(
  p_campaign_id uuid, p_user_id uuid, p_channel text default 'email',
  p_status text default 'sent', p_resend_message_id text default null,
  p_skip_reason text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_status text := p_status;
  v_skip text := p_skip_reason;
  v_region text;
begin
  -- admin or delivery worker (service_role) only
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Defense-in-depth: a 'sent' must still be eligible at write time (races).
  if v_status = 'sent' and not public.is_promo_eligible(p_user_id) then
    v_status := 'skipped'; v_skip := coalesce(v_skip, 'suppressed');
  end if;

  select coalesce(l.ip_region, l.ip_country) into v_region
  from public.user_locations l where l.user_id = p_user_id
  order by l.captured_at desc limit 1;

  insert into public.campaign_sends
    (campaign_id, user_id, channel, status, skip_reason, region, resend_message_id,
     sent_at)
  values (p_campaign_id, p_user_id, p_channel, v_status, v_skip, v_region, p_resend_message_id,
     case when v_status in ('sent','delivered') then now() end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Aggregate reach for the advertiser console — COUNTS ONLY, never identities.
create or replace function public.campaign_reach(p_campaign_id uuid)
returns table (queued int, sent int, delivered int, bounced int,
               complained int, unsubscribed int, skipped int)
language plpgsql stable security definer set search_path = ''
as $$
declare v_business uuid;
begin
  select business_id into v_business from public.ad_campaigns where id = p_campaign_id;
  if v_business is null
     or not ((select public.is_business_member(v_business)) or (select public.is_admin())) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  select
    count(*) filter (where status = 'queued')::int,
    count(*) filter (where status = 'sent')::int,
    count(*) filter (where status = 'delivered')::int,
    count(*) filter (where status = 'bounced')::int,
    count(*) filter (where status = 'complained')::int,
    (select count(*)::int from public.email_suppressions s
       where s.campaign_id = p_campaign_id and s.reason = 'unsubscribe'),
    count(*) filter (where status = 'skipped')::int
  from public.campaign_sends where campaign_id = p_campaign_id;
end;
$$;

grant execute on function public.record_campaign_send(uuid, uuid, text, text, text, text) to authenticated, service_role;
grant execute on function public.campaign_reach(uuid) to authenticated;

-- ===========================================================================
-- 20. Featured placement RPCs (A7) + serving read.
-- ===========================================================================
create or replace function public.admin_grant_featured_placement(
  p_business_id uuid, p_bathroom_id uuid, p_surface text, p_region text,
  p_lat double precision, p_lng double precision, p_radius_km double precision,
  p_starts_at timestamptz, p_ends_at timestamptz, p_edition_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_geog extensions.geography(Point, 4326);
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.can_feature(p_business_id) then
    raise exception 'featured allowance exhausted' using errcode = '22023';
  end if;
  if p_lat is not null and p_lng is not null then
    v_geog := extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography;
  end if;

  insert into public.featured_placements
    (business_id, bathroom_id, surface, region, region_geog, radius_km, edition_id,
     starts_at, ends_at, status, created_by)
  values (p_business_id, p_bathroom_id, p_surface, p_region, v_geog,
     case when p_radius_km is not null then greatest(5, p_radius_km) end, p_edition_id,
     p_starts_at, p_ends_at, 'active', (select auth.uid()))
  returning id into v_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'grant_featured', 'placement', v_id,
          jsonb_build_object('business', p_business_id, 'surface', p_surface));
  return v_id;
end;
$$;

create or replace function public.activate_featured_from_campaign(p_campaign_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v public.ad_campaigns; v_id uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v from public.ad_campaigns where id = p_campaign_id;
  if v.id is null or v.type <> 'featured' then
    raise exception 'not a featured campaign' using errcode = '22023';
  end if;
  if not public.can_feature(v.business_id) then
    raise exception 'featured allowance exhausted' using errcode = '22023';
  end if;

  insert into public.featured_placements
    (campaign_id, business_id, bathroom_id, surface, region, region_geog, radius_km,
     starts_at, ends_at, status, created_by)
  values (v.id, v.business_id, (v.creative->>'bathroom_id')::uuid,
     coalesce(v.creative->>'surface', 'browse'), v.target_region, v.target_geog, v.radius_km,
     coalesce(v.starts_at, now()), coalesce(v.ends_at, now() + interval '7 days'),
     'active', (select auth.uid()))
  returning id into v_id;
  return 1;
end;
$$;

-- App-facing read: active placements for a surface near a coarse point/region.
-- SECURITY INVOKER: relies on the "active placements are public" policy.
create or replace function public.active_featured_placements(
  p_surface text, p_region text default null,
  p_lat double precision default null, p_lng double precision default null)
returns setof public.featured_placements
language sql stable set search_path = ''
as $$
  select f.* from public.featured_placements f
  where f.surface = p_surface
    and f.status = 'active'
    and now() between f.starts_at and f.ends_at
    and ( f.region_geog is null
          or (p_lat is null or p_lng is null)
          or extensions.st_dwithin(
               f.region_geog,
               extensions.st_setsrid(extensions.st_point(p_lng, p_lat), 4326)::extensions.geography,
               coalesce(f.radius_km, 50) * 1000.0) )
    and (f.region is null or p_region is null or lower(f.region) = lower(p_region))
  order by f.priority desc, f.starts_at desc;
$$;

grant execute on function public.admin_grant_featured_placement(uuid, uuid, text, text, double precision, double precision, double precision, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.activate_featured_from_campaign(uuid) to authenticated;
grant execute on function public.active_featured_placements(text, text, double precision, double precision) to anon, authenticated;

-- ===========================================================================
-- 21. Segment + plan admin RPCs (thin; A3/A9 own the logic depth).
-- ===========================================================================
create or replace function public.admin_create_segment(p_name text, p_predicate jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.user_segments (name, predicate, created_by)
  values (p_name, coalesce(p_predicate,'{}'::jsonb), (select auth.uid())) returning id into v_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id)
  values ((select auth.uid()), 'create_segment', 'segment', v_id);
  return v_id;
end;
$$;

create or replace function public.admin_materialize_segment(p_segment_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.segment_members where segment_id = p_segment_id;
  insert into public.segment_members (segment_id, user_id)
  select p_segment_id, s.user_id from public.segment_user_ids(p_segment_id) s
  on conflict do nothing;
  get diagnostics n = row_count;
  update public.user_segments set is_dynamic = false, updated_at = now() where id = p_segment_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'materialize_segment', 'segment', p_segment_id,
          jsonb_build_object('count', n));
  return n;
end;
$$;

create or replace function public.admin_upsert_plan(
  p_key text, p_name text, p_price_cents integer, p_max_locations integer,
  p_blasts_per_month integer, p_featured_per_week integer, p_team_seats integer,
  p_analytics_level text default 'basic', p_csv_import boolean default false,
  p_api_access boolean default false, p_sort_order integer default 0, p_is_public boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.plans (key, name, price_cents, max_locations, blasts_per_month,
     featured_per_week, team_seats, analytics_level, csv_import, api_access, sort_order, is_public)
  values (p_key, p_name, p_price_cents, p_max_locations, p_blasts_per_month,
     p_featured_per_week, p_team_seats, p_analytics_level, p_csv_import, p_api_access, p_sort_order, p_is_public)
  on conflict (key) do update set
     name = excluded.name, price_cents = excluded.price_cents, max_locations = excluded.max_locations,
     blasts_per_month = excluded.blasts_per_month, featured_per_week = excluded.featured_per_week,
     team_seats = excluded.team_seats, analytics_level = excluded.analytics_level,
     csv_import = excluded.csv_import, api_access = excluded.api_access,
     sort_order = excluded.sort_order, is_public = excluded.is_public, updated_at = now();
  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'update_plan', 'plan', gen_random_uuid(), jsonb_build_object('plan', p_key));
end;
$$;

grant execute on function public.admin_create_segment(text, jsonb)      to authenticated;
grant execute on function public.admin_materialize_segment(uuid)         to authenticated;
grant execute on function public.admin_upsert_plan(text, text, integer, integer, integer, integer, integer, text, boolean, boolean, integer, boolean) to authenticated;

-- ===========================================================================
-- 22. Extend the moderation audit vocabulary. NOTE: this also REPAIRS a latent
--     bug — 20260711000000 wrote target_type='business' but never widened the
--     target_type CHECK, so admin_approve_access_request currently violates it.
-- ===========================================================================
alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    -- growth platform:
    'create_campaign', 'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'send_campaign',
    'grant_featured', 'revoke_featured',
    'create_segment', 'materialize_segment',
    'suppress_email', 'unsubscribe',
    'create_newsletter', 'send_newsletter', 'update_plan'));

alter table public.moderation_actions drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in (
    'review', 'bathroom', 'report', 'profile',
    'business', 'campaign', 'placement', 'segment', 'suppression',
    'newsletter', 'user', 'plan'));
```

---

## 8. `src/types/db.ts` additions (append; keep the file's hand-maintained mirror rule)

```ts
// --- Growth platform (consent, CRM, campaigns, ads, analytics) --------------

export interface GrowthSetting {
  key: string;
  int_value: number | null;
  text_value: string | null;
  updated_at: string;
  updated_by: Uuid | null;
}

export type AnalyticsLevel = 'none' | 'basic' | 'advanced';

export interface Plan {
  key: string;
  name: string;
  description: string | null;
  price_cents: number;
  billing_period: 'month' | 'year';
  max_locations: number | null;      // null = unlimited
  blasts_per_month: number;
  featured_per_week: number;
  team_seats: number | null;         // null = unlimited
  analytics_level: AnalyticsLevel;
  csv_import: boolean;
  api_access: boolean;
  sort_order: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlanFeature {
  plan_key: string;
  feature: string;
  int_value: number | null;
  bool_value: boolean | null;
  text_value: string | null;
}

export interface UserConsent {
  user_id: Uuid;
  marketing_opt_in: boolean;
  location_opt_in: boolean;
  gpc_detected: boolean;
  source: string | null;
  marketing_opt_in_at: string | null;
  location_opt_in_at: string | null;
  consent_updated_at: string;
  created_at: string;
}

/** Admin-only. `geog` is a city centroid (never precise). */
export interface UserLocation {
  id: Uuid;
  user_id: Uuid;
  captured_at: string;
  ip_city: string | null;
  ip_region: string | null;
  ip_country: string | null;   // ISO 3166-1 alpha-2
  source: string | null;
  expires_at: string;
}

export interface UserSegment {
  id: Uuid;
  name: string;
  description: string | null;
  predicate: Record<string, unknown>;
  is_dynamic: boolean;
  created_by: Uuid | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentMember {
  segment_id: Uuid;
  user_id: Uuid;
  added_at: string;
}

export type CampaignType = 'email_blast' | 'featured';
export type CampaignStatus =
  | 'draft' | 'pending_review' | 'approved' | 'running' | 'paused' | 'done' | 'rejected';

export interface CampaignCreative {
  subject?: string;
  body_html?: string;
  body_text?: string;
  image_url?: string;
  link_url?: string;
  cta?: string;
  surface?: 'map' | 'browse' | 'detail' | 'newsletter';
  bathroom_id?: Uuid;
}

export interface AdCampaign {
  id: Uuid;
  business_id: Uuid;
  type: CampaignType;
  status: CampaignStatus;
  target_region: string | null;
  target_country: string | null;
  radius_km: number | null;
  segment_id: Uuid | null;
  starts_at: string | null;
  ends_at: string | null;
  frequency_per_week: number;
  creative: CampaignCreative;
  submitted_at: string | null;
  reviewed_by: Uuid | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_by: Uuid | null;
  created_at: string;
  updated_at: string;
}

export type SendChannel = 'email' | 'in_app' | 'newsletter';
export type SendStatus =
  | 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'skipped';
export type SkipReason = 'not_opted_in' | 'suppressed' | 'freq_cap' | 'out_of_region';

/** Admin-only. Advertisers see only `CampaignReach` aggregates. */
export interface CampaignSend {
  id: Uuid;
  campaign_id: Uuid;
  user_id: Uuid | null;
  channel: SendChannel;
  status: SendStatus;
  skip_reason: SkipReason | null;
  unsubscribe_token: Uuid;
  region: string | null;
  resend_message_id: string | null;
  queued_at: string;
  sent_at: string | null;
  updated_at: string;
}

/** Aggregate-only reach for the advertiser console (no identities). */
export interface CampaignReach {
  queued: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  skipped: number;
}

export type FeaturedSurface = 'map' | 'browse' | 'detail' | 'newsletter';
export type FeaturedStatus = 'scheduled' | 'active' | 'paused' | 'done' | 'rejected';

export interface FeaturedPlacement {
  id: Uuid;
  campaign_id: Uuid | null;
  business_id: Uuid;
  bathroom_id: Uuid | null;
  surface: FeaturedSurface;
  region: string | null;
  radius_km: number | null;
  edition_id: Uuid | null;
  priority: number;
  starts_at: string;
  ends_at: string;
  status: FeaturedStatus;
  created_by: Uuid | null;
  created_at: string;
}

export type SuppressionReason =
  | 'unsubscribe' | 'bounce' | 'complaint' | 'manual' | 'global_optout';

export interface EmailSuppression {
  id: Uuid;
  email: string;
  user_id: Uuid | null;
  reason: SuppressionReason;
  source: string | null;
  campaign_id: Uuid | null;
  created_at: string;
}

export type NewsletterStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'archived';

export interface NewsletterEdition {
  id: Uuid;
  title: string;
  slug: string | null;
  status: NewsletterStatus;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  region: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_by: Uuid | null;
  created_at: string;
  updated_at: string;
}

export interface NewsletterSend {
  id: Uuid;
  edition_id: Uuid;
  user_id: Uuid | null;
  status: SendStatus;
  skip_reason: SkipReason | null;
  unsubscribe_token: Uuid;
  resend_message_id: string | null;
  queued_at: string;
  sent_at: string | null;
}

export interface AnalyticsEvent {
  id: Uuid;
  user_id: Uuid | null;
  session_id: string | null;
  event: string;
  props: Record<string, unknown>;
  region: string | null;
  country: string | null;
  occurred_at: string;
  ingested_at: string;
}

// --- Growth write payloads --------------------------------------------------

export interface ConsentUpdate {
  marketing: boolean;
  location: boolean;
  gpc?: boolean;
  source?: string;
}

/** Coarse targeting an advertiser sets on a campaign. All fields optional. */
export interface CampaignTargeting {
  region?: string;
  country?: string;      // ISO alpha-2
  lat?: number;          // city centroid
  lng?: number;
  radius_km?: number;    // clamped to >= 5 server-side
}
```

---

## 9. Open items for other agents

- **A1 COMPLIANCE** — confirm the consent↔suppression coupling in `set_consent`
  meets GDPR withdrawal + CPRA GPC obligations; confirm `unsubscribe_by_token`
  honoring (email suppression + `marketing_opt_in=false`) satisfies CAN-SPAM's
  "10 business days" as *immediate*. Decide whether newsletter counts toward the
  3/week platform cap (I currently count it via `promo_sends_last_7d`).
- **A3 LOCATION** — owns the IP→geo resolver (GeoLite2 City in the sign-in Edge
  Function) that calls `capture_location`, and the segment `predicate` DSL that
  `segment_user_ids` interprets (my version handles only `country`/`region`/
  `marketing_opt_in`). Confirm the ≥5 km radius floor.
- **A6 EMAIL_DELIVERY** — the send loop is: `campaign_eligible_recipients` →
  Resend (100/day, 3,000/mo free tier) → `record_campaign_send`. Resend
  bounce/complaint webhooks write `email_suppressions` (reason `bounce`/
  `complaint`) as `service_role`.
- **A9 PRICING** — replace my placeholder `plans` rows via `admin_upsert_plan`;
  the schema/caps are fixed, the numbers are yours. Keep `'standard'` present (the
  live `subscriptions` FK references it) or migrate existing rows first.
- **A14 ARCHITECTURE** — please surface the `moderation_actions` target_type CHECK
  repair (§5) in the rollout notes; it fixes an existing latent constraint
  violation on `admin_approve_access_request`.

---

## Reconciliation addendum (canonical resolutions)

This section reconciles the cross-agent relay batches (A3–A12) against the draft
above. **Where this addendum conflicts with an earlier section, the addendum
wins.** Schema deltas are collected into one ordered delta migration in §R.11
(`supabase/migrations/20260712010000_growth_reconciliation.sql`), applied after
`20260712000000_growth_platform.sql`. Where both migrations are still unapplied,
the orchestrator may fold the delta into the base file instead — §R.9
(analytics partitioning) **must** be folded in pre-application.

### R.1 `campaign_sends` — idempotency, retries, engagement (A5 + A6 + A4)

**Conflict resolved:** A6 assumed a two-column unique `(campaign_id, user_id)`;
A5 needs the same campaign to reach the same user more than once when
`frequency_per_week > 1` (recurring occurrences). **Canonical uniqueness is A5's
three-column form: `unique (campaign_id, user_id, occurrence_key)`.** A6's
idempotent upsert must include `occurrence_key` in its conflict target;
`occurrence_key` identifies the scheduler occurrence (e.g. `'2026-W29'` or an
occurrence uuid rendered as text; single-shot campaigns use the default
`'initial'`). Retrying the same occurrence is therefore idempotent, while a next
occurrence is a new row — the weekly frequency caps (not uniqueness) bound how
many occurrences may actually send.

New columns (DDL in §R.11): `occurrence_key text not null default 'initial'`,
`batch_id uuid` (worker batch grouping), retry machinery `attempt_count smallint
not null default 0` + `next_attempt_at timestamptz` + `last_error text`, a new
non-terminal status `'retrying'`, A4's **`send_token uuid`** (opaque, unique —
used in open-pixel/click-redirect URLs so engagement tracking never exposes the
unsubscribe capability; **distinct from `unsubscribe_token`**), and engagement
stamps `opened_at timestamptz` / `clicked_at timestamptz` (written by A6's
webhook handler / A4's redirect endpoint as `service_role`).

Status vocabulary (canonical): non-terminal `queued`, `retrying`, `sent`;
terminal `delivered`, `bounced`, `complained`, `failed`, `skipped`. `sent` may
upgrade to `delivered`/`bounced`/`complained` via the Resend webhook.
`resend_message_id` already exists in the draft (§7.7) — confirmed canonical.

### R.2 k-anonymity floor — ONE number: **30**

Resolves 30 (A5) vs 30 (A11) vs 100 (A10): **canonical floor = 30**, stored as
`growth_settings.k_anonymity_floor` so it is tunable without redesign. A new
`public.k_anonymity_floor()` helper is granted to `authenticated` so A10's UI
"just reads it" (raw `growth_settings` stays admin-only).

Enforcement: every **advertiser-facing** audience count
(`estimate_campaign_reach`, and any A10 segment preview) returns **NULL** when
the true count is below the floor — the UI renders "audience too small
(< 30)". Admin surfaces (A11 CRM) see true counts; admins already hold row
access, so a floor there protects nothing. Delivery
(`campaign_eligible_recipients`) is not floored — it returns identities to the
admin/service-role worker only.

### R.3 Config table name

**`growth_settings` is canonical.** A12's `growth_config` is the **same table**
— read every `growth_config` reference in ABUSE_AND_LIMITS.md as
`growth_settings`. No second table exists.

### R.4 `user_consents` — full consent row (A4 + A8)

Two new columns: **`analytics_opt_in boolean not null default false`** (A4's
third toggle — gates attaching `user_id` to `analytics_events`; anonymous
events need no consent) and **`newsletter_opt_out boolean not null default
false`** (A8). Full canonical row: `user_id`, `marketing_opt_in`,
`location_opt_in`, `analytics_opt_in`, `newsletter_opt_out`, `gpc_detected`,
`source`, proof-of-consent stamps (`marketing_opt_in_at`, `location_opt_in_at`,
`analytics_opt_in_at` — invented for parity, flag for A1), `consent_updated_at`,
`created_at`.

**Pinned semantics (keeps the opt-in-first rule):** `newsletter_opt_out` is a
sub-preference *under* the marketing opt-in umbrella. Newsletter eligibility =
`marketing_opt_in AND NOT newsletter_opt_out` (then suppression + weekly cap as
usual). A default of `false` never widens the audience beyond people who
explicitly opted into marketing. GPC forcing `marketing_opt_in = false` thereby
kills the newsletter too. `set_consent` is re-signed to v2 (§R.11 step 2);
`log_event` now nulls `user_id` when the caller lacks `analytics_opt_in`.

### R.5 From A3 — `geo_cities` + coarse-location hygiene

- New reference table **`geo_cities`** (`geoname_id integer primary key`, `city`,
  `region`, `country char(2)`, `centroid geography(Point,4326)`, `population`)
  — the GeoLite2/GeoNames city-centroid lookup, imported by A3's job as
  `service_role`. Public-read (it is public reference data, no PII); GiST on
  `centroid`.
- `user_locations` gains **`accuracy_km double precision check (>= 5)`** (the
  coarseness of the resolved centroid; never below the 5 km floor) and
  **`geoname_id integer references geo_cities`** so segments can join city
  metadata instead of string-matching `ip_city`.
- **Confirmed: `user_locations` has NO ip/inet column** — by design, and
  verified against §7.3. Raw IPs never touch the database; the Edge Function
  discards them after the GeoLite2 lookup.

### R.6 From A6 — webhook dedupe + daily volume

- **`webhook_events`**: Resend webhooks are delivered via Svix, which retries;
  the `svix-id` header is the dedupe key. Table: `id text primary key` (svix
  message id), `provider`, `event_type`, `payload jsonb`, `received_at`,
  `processed_at`. The webhook Edge Function does
  `insert … on conflict (id) do nothing` and only processes on `found`.
  Admin-only read; `service_role` writes.
- **`daily_send_volume` view** (`security_invoker`): per-day/source/channel/
  status counts across `campaign_sends` + `newsletter_sends`, for budget
  monitoring against Resend's 100/day free tier. Effectively admin-only (the
  underlying tables are).

### R.7 From A12 — budgets, fairness, ad reporting, race-free caps

- **`platform_send_counters`** (`day`, `channel`, `sent_count`, pk `(day,
  channel)`) + **`claim_platform_send_budget(p_channel, p_requested) → int`**:
  atomically grants up to the remaining daily budget
  (`growth_settings.daily_email_budget`, default **100** = Resend free tier/day)
  using a `select … for update` on the counter row; returns the granted count
  (0 = budget exhausted, worker stops).
- **Per-advertiser-per-user sub-cap**: at most
  `growth_settings.advertiser_user_weekly_cap` (default **1**) message per
  business per user per 7 days, regardless of how many campaigns that business
  runs. New helper `business_sends_last_7d(user_id, business_id)`; gate added
  inside `campaign_eligible_recipients` (§R.11 step 4). Order of gates is now:
  platform 3/7d cap → advertiser 1/7d cap → per-campaign `frequency_per_week`.
- **`claim_send_slot(p_campaign_id, p_user_id, p_occurrence_key) → boolean`**:
  serializes concurrent delivery workers with
  `pg_advisory_xact_lock(hashtextextended('watrloo:send:'||user_id, 0))`,
  re-checks all three caps **counting `queued`/`retrying` claims too** (so two
  workers can't both pass a stale count), then inserts the `queued` row
  `on conflict do nothing`. Returns whether the slot was claimed.
- **`featured_waitlist_credits`**: fair allocation when featured slots
  oversubscribe. Row = a purchased/entitled credit: `business_id`, `surface`,
  `region`, `credits`, `tier_weight` (plan-derived, modest), `requested_at`,
  `booked_at` (set when converted), `placement_id`. Allocation order:
  `credits desc, tier_weight desc, requested_at asc`. **Anti-monopoly cap:** one
  advertiser may hold at most `ceil(slots/2)` concurrently active/scheduled
  placements per (surface, region) window — `slots` from
  `growth_settings.featured_slots_per_surface` (default 4). Enforced by
  `featured_monopoly_ok(...)`, which `admin_grant_featured_placement` and
  `activate_featured_from_campaign` must call (one-line `perform` guard).
- **`reports` extended to ads**: nullable `campaign_id` and
  `featured_placement_id` FKs; the exactly-one-target CHECK widens to sum over
  four columns. Users can now report an ad; the existing moderation queue
  handles it unchanged.

### R.8 From A9 — entitlement matrix + plan key migration

Canonical `plans` entitlement surface (typed columns unless noted):
`max_locations`, `blasts_per_month`, **`max_recipients_per_blast`** (new column —
the cost fuse: hard per-blast recipient ceiling, checked by A6 before queueing),
`featured_per_week`, **`newsletter_slots_per_month`** (new column, checked by
A8's booking RPC via `entitlement_int`), `team_seats`, `analytics_level`,
`api_access`, `csv_import`, **`priority_support boolean`** (new),
**`overage_enabled boolean`** (new — whether exceeding a cap is soft-blocked or
billable later). `plan_features` EAV remains for per-business overrides of any
of these (same keys). `entitlement_int` gains case arms for the two new int
caps.

**Adjusted, not adopted verbatim:** A9 wrote `subscriptions.plan → plans.id` and
the names `seats`/`analytics_tier`. The pk stays **`plans.key text`** — the live
`subscriptions.plan` column is already text, so a uuid pk would force a
column-type migration on a live table for zero gain; wherever A9's doc says
`plans.id`, read `plans.key`. `seats` ≡ `team_seats` and `analytics_tier` ≡
`analytics_level` (the draft's names are already threaded through
`entitlement_int`/`admin_upsert_plan`). **Adopted:** the bottom tier is named
**`'solo'`**; the delta migration seeds it and runs
`update subscriptions set plan='solo' where plan='standard'`, then removes the
`'standard'` placeholder row.

### R.9 From A4 — analytics partitioning + rollups + audit verb

- **`analytics_events` is monthly range-partitioned on `occurred_at`.** This
  **supersedes §7.10's plain table** and must be folded into the base migration
  *before* it is applied (a plain table cannot be ALTERed into a partitioned
  one; if §7 somehow ships first, the fallback is rename → create partitioned →
  `insert select` → drop). PK becomes `(id, occurred_at)` (partition key must be
  in the PK). A default partition catches strays; A4's pg_cron job creates
  `analytics_events_YYYY_MM` ahead of time and detaches+drops expired months
  (which also implements the 365-day retention cheaply). BRIN + the existing
  indexes live on the parent. RLS/policies unchanged.
- **Rollup tables** (written by A4's pg_cron job as `service_role`):
  `analytics_daily` (day/event/region/country → users, events; admin-only) and
  `campaign_daily` (day/campaign_id → queued/sent/delivered/opened/clicked/
  bounced/complained/skipped; readable by the campaign's business members —
  aggregates only, this is what powers A10's charts without touching
  `campaign_sends`).
- New `moderation_actions` verb **`view_user_analytics`** — logged whenever an
  admin surface reveals a *single user's* analytics/CRM detail (§R.10).

### R.10 From A11 — admin RPC surface + audit-on-reveal

Signatures are canonical here; full bodies live in ADMIN_CRM.md. All are
`SECURITY DEFINER`, `set search_path=''`, gated `is_admin()`, errcode `42501`.

| RPC | Behavior |
| --- | --- |
| `admin_crm_search(p_query text, p_filters jsonb, p_lim int, p_off int) → table(user_id, username, email, marketing_opt_in, location_opt_in, analytics_opt_in, newsletter_opt_out, region, country, last_seen)` | List/search users joined to consent + latest coarse location. Logs ONE `crm_search` audit row per call with `detail = {query, filters}` (not one per result row). |
| `admin_crm_user(p_user_id uuid) → jsonb` | Full dossier: consent row, location history, send history, recent events. **Audit-on-reveal rule:** every call logs `crm_view_user` (target_type `user`, target_id = the user) — individual-level PII reveals are always attributable. Analytics drill-downs on one user log `view_user_analytics` likewise. |
| `admin_update_segment(p_segment_id, p_name, p_predicate) → void` / `admin_delete_segment(p_segment_id) → void` | Segment CRUD completing §7.21's create/materialize. Audit `update_segment`/`delete_segment`. |
| `admin_preview_segment(p_segment_id) → int` | True member count (admin context — no k-floor; the floor is advertiser-facing, §R.2). |
| `admin_campaign_queue() → setof ad_campaigns` | `status = 'pending_review'` ordered by `submitted_at` — the approval queue. |

### R.11 Delta migration — `20260712010000_growth_reconciliation.sql`

```sql
-- Watrloo growth platform: reconciliation delta. Applies AFTER
-- 20260712000000_growth_platform.sql. Ordered: settings -> reference tables ->
-- column adds -> replaced functions -> new tables -> constraint widenings.

-- ---------------------------------------------------------------------------
-- 1. Settings + k-anonymity floor
-- ---------------------------------------------------------------------------
insert into public.growth_settings (key, int_value) values
  ('k_anonymity_floor', 30),           -- advertiser-facing audience-count floor
  ('advertiser_user_weekly_cap', 1),   -- msgs per business per user per 7d
  ('daily_email_budget', 100),         -- Resend free tier: 100/day
  ('featured_slots_per_surface', 4)    -- concurrent featured slots per surface
on conflict (key) do nothing;

create or replace function public.k_anonymity_floor()
returns integer
language sql stable security definer set search_path = ''
as $$ select public.setting_int('k_anonymity_floor', 30); $$;
grant execute on function public.k_anonymity_floor() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. geo_cities (A3) + user_locations hygiene. NOTE: user_locations has NO
--    ip/inet column — confirmed by design; raw IPs never reach the database.
-- ---------------------------------------------------------------------------
create table public.geo_cities (
  geoname_id integer primary key,
  city       text not null check (char_length(city) <= 200),
  region     text check (char_length(region) <= 120),
  country    text not null check (char_length(country) = 2),
  centroid   extensions.geography(Point, 4326) not null,
  population integer
);
create index geo_cities_centroid_idx on public.geo_cities using gist (centroid);
create index geo_cities_country_region_idx on public.geo_cities (country, region);

alter table public.geo_cities enable row level security;
grant select on public.geo_cities to anon, authenticated;   -- public reference data
create policy "geo cities are viewable by everyone"
  on public.geo_cities for select using (true);
-- Writes: A3's GeoLite2/GeoNames import job as service_role only.

alter table public.user_locations
  add column accuracy_km double precision check (accuracy_km is null or accuracy_km >= 5),
  add column geoname_id integer references public.geo_cities (geoname_id) on delete set null;
create index user_locations_geoname_idx on public.user_locations (geoname_id);

-- ---------------------------------------------------------------------------
-- 3. user_consents: analytics (A4) + newsletter sub-preference (A8);
--    set_consent v2. Newsletter eligibility = marketing_opt_in AND NOT
--    newsletter_opt_out — never wider than the marketing opt-in.
-- ---------------------------------------------------------------------------
alter table public.user_consents
  add column analytics_opt_in    boolean not null default false,
  add column analytics_opt_in_at timestamptz,
  add column newsletter_opt_out  boolean not null default false;

drop function public.set_consent(boolean, boolean, boolean, text);

create function public.set_consent(
  p_marketing boolean, p_location boolean,
  p_analytics boolean default false, p_newsletter_optout boolean default false,
  p_gpc boolean default false, p_source text default 'settings')
returns public.user_consents
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  v_marketing boolean := p_marketing;
  v_email text;
  v_row public.user_consents;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_gpc then v_marketing := false; end if;   -- GPC = binding opt-out (CPRA)

  insert into public.user_consents as c
    (user_id, marketing_opt_in, location_opt_in, analytics_opt_in, newsletter_opt_out,
     gpc_detected, source, marketing_opt_in_at, location_opt_in_at, analytics_opt_in_at,
     consent_updated_at)
  values (uid, v_marketing, p_location, p_analytics, p_newsletter_optout, p_gpc, p_source,
     case when v_marketing then now() end,
     case when p_location  then now() end,
     case when p_analytics then now() end, now())
  on conflict (user_id) do update set
     marketing_opt_in = excluded.marketing_opt_in,
     location_opt_in  = excluded.location_opt_in,
     analytics_opt_in = excluded.analytics_opt_in,
     newsletter_opt_out = excluded.newsletter_opt_out,
     gpc_detected     = excluded.gpc_detected,
     source           = excluded.source,
     marketing_opt_in_at = case when excluded.marketing_opt_in and not c.marketing_opt_in
                                then now() else c.marketing_opt_in_at end,
     location_opt_in_at  = case when excluded.location_opt_in and not c.location_opt_in
                                then now() else c.location_opt_in_at end,
     analytics_opt_in_at = case when excluded.analytics_opt_in and not c.analytics_opt_in
                                then now() else c.analytics_opt_in_at end,
     consent_updated_at = now()
  returning * into v_row;

  select email into v_email from auth.users where id = uid;
  if not v_marketing then
    insert into public.email_suppressions (email, user_id, reason, source)
    values (lower(v_email), uid, 'global_optout', 'consent')
    on conflict (email) do update set reason = 'global_optout', user_id = uid;
  else
    delete from public.email_suppressions
     where user_id = uid and reason in ('unsubscribe','global_optout');
  end if;
  return v_row;
end;
$$;
grant execute on function public.set_consent(boolean, boolean, boolean, boolean, boolean, text) to authenticated;

-- log_event: only attach user_id with analytics consent.
create or replace function public.log_event(
  p_event text, p_props jsonb default '{}'::jsonb, p_session_id text default null,
  p_region text default null, p_country text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := (select auth.uid());
begin
  if uid is not null and not exists (
    select 1 from public.user_consents c where c.user_id = uid and c.analytics_opt_in
  ) then
    uid := null;   -- keep the event, drop the identity
  end if;
  insert into public.analytics_events (user_id, session_id, event, props, region, country)
  values (uid, p_session_id, left(p_event, 80), coalesce(p_props, '{}'::jsonb),
          p_region, upper(left(p_country, 2)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. campaign_sends: occurrence idempotency, retries, engagement (R.1).
--    CANONICAL uniqueness: (campaign_id, user_id, occurrence_key).
-- ---------------------------------------------------------------------------
alter table public.campaign_sends
  add column occurrence_key text not null default 'initial'
             check (char_length(occurrence_key) between 1 and 60),
  add column batch_id        uuid,
  add column attempt_count   smallint not null default 0,
  add column next_attempt_at timestamptz,
  add column last_error      text,
  add column send_token      uuid not null default gen_random_uuid(),
  add column opened_at       timestamptz,
  add column clicked_at      timestamptz;

alter table public.campaign_sends drop constraint campaign_sends_status_check;
alter table public.campaign_sends add constraint campaign_sends_status_check
  check (status in ('queued','retrying','sent','delivered','bounced','complained','failed','skipped'));

create unique index campaign_sends_occurrence_idx
  on public.campaign_sends (campaign_id, user_id, occurrence_key);
create unique index campaign_sends_send_token_idx
  on public.campaign_sends (send_token);
create index campaign_sends_batch_idx on public.campaign_sends (batch_id);
create index campaign_sends_retry_idx on public.campaign_sends (next_attempt_at)
  where status = 'retrying';

-- Per-advertiser sub-cap helper (A12): msgs from ONE business to a user in 7d.
create or replace function public.business_sends_last_7d(p_user_id uuid, p_business_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::int
  from public.campaign_sends cs
  join public.ad_campaigns a on a.id = cs.campaign_id
  where cs.user_id = p_user_id and a.business_id = p_business_id
    and cs.status in ('sent','delivered')
    and cs.sent_at >= now() - interval '7 days';
$$;
grant execute on function public.business_sends_last_7d(uuid, uuid) to authenticated;

-- record_campaign_send v2: occurrence-aware idempotent upsert.
drop function public.record_campaign_send(uuid, uuid, text, text, text, text);

create function public.record_campaign_send(
  p_campaign_id uuid, p_user_id uuid, p_channel text default 'email',
  p_status text default 'sent', p_resend_message_id text default null,
  p_skip_reason text default null, p_occurrence_key text default 'initial',
  p_batch_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_status text := p_status;
  v_skip text := p_skip_reason;
  v_region text;
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_status = 'sent' and not public.is_promo_eligible(p_user_id) then
    v_status := 'skipped'; v_skip := coalesce(v_skip, 'suppressed');
  end if;

  select coalesce(l.ip_region, l.ip_country) into v_region
  from public.user_locations l where l.user_id = p_user_id
  order by l.captured_at desc limit 1;

  insert into public.campaign_sends as cs
    (campaign_id, user_id, occurrence_key, batch_id, channel, status, skip_reason,
     region, resend_message_id, sent_at)
  values (p_campaign_id, p_user_id, p_occurrence_key, p_batch_id, p_channel, v_status,
     v_skip, v_region, p_resend_message_id,
     case when v_status in ('sent','delivered') then now() end)
  on conflict (campaign_id, user_id, occurrence_key) do update set
     status = excluded.status,
     skip_reason = excluded.skip_reason,
     batch_id = coalesce(excluded.batch_id, cs.batch_id),
     resend_message_id = coalesce(excluded.resend_message_id, cs.resend_message_id),
     attempt_count = cs.attempt_count + 1,
     sent_at = coalesce(cs.sent_at, excluded.sent_at),
     updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.record_campaign_send(uuid, uuid, text, text, text, text, text, uuid) to authenticated, service_role;

-- Race-free slot claim (A12): advisory-locked, counts queued claims too.
create or replace function public.claim_send_slot(
  p_campaign_id uuid, p_user_id uuid, p_occurrence_key text default 'initial')
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  c public.ad_campaigns;
  v_adv_cap integer := public.setting_int('advertiser_user_weekly_cap', 1);
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into c from public.ad_campaigns where id = p_campaign_id;
  if c.id is null then raise exception 'no such campaign' using errcode = 'P0002'; end if;

  -- Serialize all cap checks for this user across concurrent workers.
  perform pg_advisory_xact_lock(hashtextextended('watrloo:send:' || p_user_id::text, 0));

  if not public.is_promo_eligible(p_user_id) then return false; end if;

  -- Counts INCLUDE queued/retrying claims so parallel occurrences can't race.
  if (select count(*) from public.campaign_sends cs
       where cs.user_id = p_user_id
         and cs.status in ('queued','retrying','sent','delivered')
         and coalesce(cs.sent_at, cs.queued_at) >= now() - interval '7 days')
     >= public.promo_weekly_cap() then return false; end if;

  if (select count(*) from public.campaign_sends cs
       join public.ad_campaigns a on a.id = cs.campaign_id
       where cs.user_id = p_user_id and a.business_id = c.business_id
         and cs.status in ('queued','retrying','sent','delivered')
         and coalesce(cs.sent_at, cs.queued_at) >= now() - interval '7 days')
     >= v_adv_cap then return false; end if;

  if (select count(*) from public.campaign_sends cs
       where cs.user_id = p_user_id and cs.campaign_id = p_campaign_id
         and cs.status in ('queued','retrying','sent','delivered')
         and coalesce(cs.sent_at, cs.queued_at) >= now() - interval '7 days')
     >= c.frequency_per_week then return false; end if;

  insert into public.campaign_sends (campaign_id, user_id, occurrence_key, status)
  values (p_campaign_id, p_user_id, p_occurrence_key, 'queued')
  on conflict (campaign_id, user_id, occurrence_key) do nothing;
  return found;
end;
$$;
grant execute on function public.claim_send_slot(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Eligibility query v2: adds the per-advertiser 1/7d sub-cap (gate order:
--    platform cap -> advertiser cap -> per-campaign cap). Body otherwise as §7.13.
-- ---------------------------------------------------------------------------
create or replace function public.campaign_eligible_recipients(p_campaign_id uuid)
returns table (user_id uuid, email text, region text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  c   public.ad_campaigns;
  cap integer := public.promo_weekly_cap();
  adv_cap integer := public.setting_int('advertiser_user_weekly_cap', 1);
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into c from public.ad_campaigns where id = p_campaign_id;
  if c.id is null then raise exception 'no such campaign' using errcode = 'P0002'; end if;

  return query
  with latest_loc as (
    select distinct on (l.user_id)
           l.user_id, l.geog, l.ip_region, l.ip_country
    from public.user_locations l
    order by l.user_id, l.captured_at desc
  ),
  candidates as (
    select con.user_id from public.user_consents con where con.marketing_opt_in
  ),
  targeted as (
    select cand.user_id
    from candidates cand
    left join latest_loc ll on ll.user_id = cand.user_id
    where
      ( c.segment_id is null
        or cand.user_id in (select s.user_id from public.segment_user_ids(c.segment_id) s) )
      and
      ( (c.target_geog is null and c.target_region is null and c.target_country is null)
        or (c.target_geog is not null and ll.geog is not null
             and extensions.st_dwithin(
                   ll.geog, c.target_geog,
                   greatest(5, least(coalesce(c.radius_km, 50), 500)) * 1000.0))
        or (c.target_region is not null and ll.ip_region is not null
             and lower(ll.ip_region) = lower(c.target_region))
        or (c.target_country is not null and ll.ip_country is not null
             and upper(ll.ip_country) = upper(c.target_country)) )
  )
  select t.user_id, u.email, coalesce(ll.ip_region, ll.ip_country) as region
  from targeted t
  join auth.users u on u.id = t.user_id
  left join latest_loc ll on ll.user_id = t.user_id
  where u.email is not null
    and not exists (
      select 1 from public.email_suppressions s
      where s.user_id = t.user_id or lower(s.email) = lower(u.email))
    and public.promo_sends_last_7d(t.user_id) < cap
    and public.business_sends_last_7d(t.user_id, c.business_id) < adv_cap
    and public.campaign_sends_last_7d(t.user_id, p_campaign_id) < c.frequency_per_week;
end;
$$;

-- estimate_campaign_reach v2: k-anonymity floor — NULL when count < floor.
-- (Same body as §7.13's estimator, then:)
--   if v_count < public.k_anonymity_floor() then return null; end if;
--   return v_count;
-- The orchestrator applies that two-line tail change to the §7.13 body.

-- ---------------------------------------------------------------------------
-- 6. plans: full entitlement matrix (A9) + 'standard' -> 'solo' migration.
--    PK stays plans.key (text); read A9's "plans.id" as plans.key.
-- ---------------------------------------------------------------------------
alter table public.plans
  add column max_recipients_per_blast   integer check (max_recipients_per_blast is null or max_recipients_per_blast >= 1),
  add column newsletter_slots_per_month integer not null default 0 check (newsletter_slots_per_month >= 0),
  add column priority_support           boolean not null default false,
  add column overage_enabled            boolean not null default false;

insert into public.plans
  (key, name, price_cents, max_locations, blasts_per_month, max_recipients_per_blast,
   featured_per_week, newsletter_slots_per_month, team_seats, analytics_level,
   csv_import, api_access, priority_support, overage_enabled, sort_order)
values
  ('solo', 'Solo', 1000, 1, 2, 500, 1, 0, 2, 'basic', false, false, false, false, 1)
on conflict (key) do nothing;

update public.subscriptions set plan = 'solo' where plan = 'standard';
delete from public.plans where key = 'standard';

create or replace function public.entitlement_int(p_business_id uuid, p_feature text)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select pf.int_value from public.plan_features pf
       join public.subscriptions s on s.plan = pf.plan_key
      where s.business_id = p_business_id and pf.feature = p_feature),
    (select case p_feature
              when 'max_locations'              then p.max_locations
              when 'blasts_per_month'           then p.blasts_per_month
              when 'max_recipients_per_blast'   then p.max_recipients_per_blast
              when 'featured_per_week'          then p.featured_per_week
              when 'newsletter_slots_per_month' then p.newsletter_slots_per_month
              when 'team_seats'                 then p.team_seats
            end
       from public.plans p join public.subscriptions s on s.plan = p.key
      where s.business_id = p_business_id));
$$;

-- ---------------------------------------------------------------------------
-- 7. webhook_events (Svix dedupe, A6) + daily send-volume view.
-- ---------------------------------------------------------------------------
create table public.webhook_events (
  id           text primary key,          -- svix-id header (dedupe key)
  provider     text not null default 'resend',
  event_type   text not null check (char_length(event_type) <= 80),
  payload      jsonb not null default '{}'::jsonb,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
create index webhook_events_unprocessed_idx on public.webhook_events (received_at)
  where processed_at is null;

alter table public.webhook_events enable row level security;
grant select on public.webhook_events to authenticated;
create policy "admins read webhook events"
  on public.webhook_events for select to authenticated
  using ((select public.is_admin()));
-- Writes: the webhook Edge Function as service_role, insert .. on conflict (id) do nothing.

create view public.daily_send_volume
with (security_invoker = on) as
select coalesce(sent_at, queued_at)::date as day, 'campaign' as source,
       channel, status, count(*)::int as sends
from public.campaign_sends group by 1, 2, 3, 4
union all
select coalesce(sent_at, queued_at)::date, 'newsletter', 'email', status, count(*)::int
from public.newsletter_sends group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- 8. Platform daily send budget (A12) — atomic claim against Resend's 100/day.
-- ---------------------------------------------------------------------------
create table public.platform_send_counters (
  day        date not null,
  channel    text not null check (channel in ('email','in_app')),
  sent_count integer not null default 0 check (sent_count >= 0),
  primary key (day, channel)
);
alter table public.platform_send_counters enable row level security;
grant select on public.platform_send_counters to authenticated;
create policy "admins read send counters"
  on public.platform_send_counters for select to authenticated
  using ((select public.is_admin()));

create or replace function public.claim_platform_send_budget(
  p_channel text default 'email', p_requested integer default 1)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_budget integer := public.setting_int('daily_email_budget', 100);
  v_cur integer;
  v_granted integer;
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.platform_send_counters (day, channel)
  values (current_date, p_channel)
  on conflict (day, channel) do nothing;

  select sent_count into v_cur from public.platform_send_counters
   where day = current_date and channel = p_channel
   for update;                                  -- row lock = atomic budget claim

  v_granted := least(greatest(p_requested, 0), greatest(v_budget - v_cur, 0));
  update public.platform_send_counters
     set sent_count = v_cur + v_granted
   where day = current_date and channel = p_channel;
  return v_granted;                             -- 0 => budget exhausted, stop
end;
$$;
grant execute on function public.claim_platform_send_budget(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Featured fairness (A12): waitlist credits + anti-monopoly cap.
-- ---------------------------------------------------------------------------
create table public.featured_waitlist_credits (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  surface      text not null check (surface in ('map','browse','detail','newsletter')),
  region       text check (char_length(region) <= 120),
  credits      integer not null default 1 check (credits >= 0),
  tier_weight  numeric not null default 1.0 check (tier_weight between 0.5 and 3.0),
  requested_at timestamptz not null default now(),
  booked_at    timestamptz,   -- set when a credit converts into a placement
  placement_id uuid references public.featured_placements (id) on delete set null
);
create index featured_waitlist_open_idx
  on public.featured_waitlist_credits (surface, region, requested_at)
  where booked_at is null;

alter table public.featured_waitlist_credits enable row level security;
grant select on public.featured_waitlist_credits to authenticated;
create policy "members read their waitlist credits"
  on public.featured_waitlist_credits for select to authenticated
  using ((select public.is_business_member(business_id)) or (select public.is_admin()));
-- Writes: admin RPC / service_role. Allocation order when oversubscribed:
-- credits desc, tier_weight desc, requested_at asc.

-- Anti-monopoly: one advertiser holds at most ceil(slots/2) concurrent
-- active/scheduled placements per (surface, region) window.
create or replace function public.featured_monopoly_ok(
  p_business_id uuid, p_surface text, p_region text,
  p_starts_at timestamptz, p_ends_at timestamptz)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (
    select count(*) from public.featured_placements f
    where f.business_id = p_business_id
      and f.surface = p_surface
      and (f.region is not distinct from p_region)
      and f.status in ('scheduled','active')
      and f.starts_at < p_ends_at and f.ends_at > p_starts_at
  ) < ceil(public.setting_int('featured_slots_per_surface', 4) / 2.0);
$$;
grant execute on function public.featured_monopoly_ok(uuid, text, text, timestamptz, timestamptz) to authenticated;
-- NOTE for the orchestrator: add to §7.20's admin_grant_featured_placement and
-- activate_featured_from_campaign, right after the can_feature() guard:
--   if not public.featured_monopoly_ok(<business>, <surface>, <region>, <starts>, <ends>)
--   then raise exception 'advertiser slot cap reached' using errcode = '22023'; end if;

-- ---------------------------------------------------------------------------
-- 10. reports: users can report ads (A12). Widen the one-target CHECK.
-- ---------------------------------------------------------------------------
alter table public.reports
  add column campaign_id uuid references public.ad_campaigns (id) on delete cascade,
  add column featured_placement_id uuid references public.featured_placements (id) on delete cascade;

-- The original inline CHECK is unnamed; Postgres named it reports_check.
-- Verify with \d public.reports before applying if in doubt.
alter table public.reports drop constraint reports_check;
alter table public.reports add constraint reports_one_target_check
  check ( (review_id is not null)::int + (bathroom_id is not null)::int
        + (campaign_id is not null)::int + (featured_placement_id is not null)::int = 1 );

-- ---------------------------------------------------------------------------
-- 11. Analytics rollups (A4). (Partitioning of analytics_events itself is a
--     PRE-APPLICATION amendment to §7.10 — see the DDL right after this block.)
-- ---------------------------------------------------------------------------
create table public.analytics_daily (
  day     date not null,
  event   text not null,
  region  text not null default '',
  country text not null default '',
  users   integer not null default 0,
  events  integer not null default 0,
  primary key (day, event, region, country)
);
alter table public.analytics_daily enable row level security;
grant select on public.analytics_daily to authenticated;
create policy "admins read analytics rollups"
  on public.analytics_daily for select to authenticated
  using ((select public.is_admin()));

create table public.campaign_daily (
  day         date not null,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  queued int not null default 0, sent int not null default 0,
  delivered int not null default 0, opened int not null default 0,
  clicked int not null default 0, bounced int not null default 0,
  complained int not null default 0, skipped int not null default 0,
  primary key (day, campaign_id)
);
alter table public.campaign_daily enable row level security;
grant select on public.campaign_daily to authenticated;
-- Aggregates only — safe for the advertiser console (A10 charts read this).
create policy "members read their campaign rollups"
  on public.campaign_daily for select to authenticated
  using (
    exists (select 1 from public.ad_campaigns a
            where a.id = campaign_id
              and (select public.is_business_member(a.business_id)))
    or (select public.is_admin())
  );
-- Writes: A4's pg_cron rollup job as service_role.

-- ---------------------------------------------------------------------------
-- 12. Moderation audit vocabulary — add the CRM/analytics reveal verbs.
-- ---------------------------------------------------------------------------
alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'create_campaign', 'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'send_campaign',
    'grant_featured', 'revoke_featured',
    'create_segment', 'materialize_segment', 'update_segment', 'delete_segment',
    'suppress_email', 'unsubscribe',
    'create_newsletter', 'send_newsletter', 'update_plan',
    'view_user_analytics', 'crm_search', 'crm_view_user'));
```

**Pre-application amendment to §7.10** (partitioned `analytics_events` —
replaces the plain `create table` there; cannot ship as a later ALTER):

```sql
create table public.analytics_events (
  id          uuid not null default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete set null,
  session_id  text check (char_length(session_id) <= 64),
  event       text not null check (char_length(event) between 1 and 80),
  props       jsonb not null default '{}'::jsonb,
  region      text check (char_length(region) <= 120),
  country     text check (char_length(country) <= 2),
  occurred_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(),
  primary key (id, occurred_at)               -- partition key must be in the PK
) partition by range (occurred_at);

create table public.analytics_events_default
  partition of public.analytics_events default;
-- A4's pg_cron job pre-creates analytics_events_YYYY_MM monthly partitions:
--   create table public.analytics_events_2026_08 partition of public.analytics_events
--     for values from ('2026-08-01') to ('2026-09-01');
-- and detach+drops months older than analytics_retention_days (cheap retention).

-- Indexes/RLS/policies exactly as §7.10 (they attach to the parent).
```

### R.12 Types delta (`src/types/db.ts`)

```ts
// R.1/R.4/R.5–R.9 additions — merge into the §8 block.
export interface UserConsent {
  // ...existing fields...
  analytics_opt_in: boolean;
  analytics_opt_in_at: string | null;
  newsletter_opt_out: boolean;
}
export type SendStatus =
  | 'queued' | 'retrying' | 'sent' | 'delivered'
  | 'bounced' | 'complained' | 'failed' | 'skipped';
export interface CampaignSend {
  // ...existing fields...
  occurrence_key: string;
  batch_id: Uuid | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  send_token: Uuid;         // engagement tracking; NOT the unsubscribe token
  opened_at: string | null;
  clicked_at: string | null;
}
export interface Plan {
  // ...existing fields...
  max_recipients_per_blast: number | null;
  newsletter_slots_per_month: number;
  priority_support: boolean;
  overage_enabled: boolean;
}
export interface GeoCity {
  geoname_id: number; city: string; region: string | null;
  country: string; population: number | null;
}
export interface UserLocation {
  // ...existing fields...
  accuracy_km: number | null;
  geoname_id: number | null;
}
export interface WebhookEvent {
  id: string; provider: string; event_type: string;
  payload: Record<string, unknown>; received_at: string; processed_at: string | null;
}
export interface PlatformSendCounter { day: string; channel: 'email' | 'in_app'; sent_count: number; }
export interface FeaturedWaitlistCredit {
  id: Uuid; business_id: Uuid; surface: FeaturedSurface; region: string | null;
  credits: number; tier_weight: number; requested_at: string;
  booked_at: string | null; placement_id: Uuid | null;
}
export interface Report {
  // ...existing fields...
  campaign_id: Uuid | null;
  featured_placement_id: Uuid | null;
}
export interface CampaignDaily {
  day: string; campaign_id: Uuid; queued: number; sent: number; delivered: number;
  opened: number; clicked: number; bounced: number; complained: number; skipped: number;
}
```

### R.13 Rejected / adjusted requests

1. **A9: `plans.id uuid` pk → ADJUSTED.** The pk stays `plans.key text`. The live
   `subscriptions.plan` column is text; a uuid pk forces a type migration on a
   live table for zero gain. Read A9's `plans.id` as `plans.key`. The
   `'standard' → 'solo'` migration and the full entitlement key list are adopted.
2. **A9: `seats` / `analytics_tier` column names → ADJUSTED** to the draft's
   `team_seats` / `analytics_level` (identical semantics; already threaded
   through `entitlement_int` and `admin_upsert_plan`). Alias, not a second field.
3. **A10: k-anonymity floor of 100 → REJECTED.** Canonical is **30** (A5 and A11
   independently chose 30; 100 makes small-city campaigns permanently preview-
   blind). It lives in `growth_settings.k_anonymity_floor`, so raising it later
   is a config change, not a redesign.
4. **A6: `unique (campaign_id, user_id)` → REPLACED** by
   `unique (campaign_id, user_id, occurrence_key)` (A5's form). A6 must add
   `occurrence_key` to its upsert conflict target; single-shot campaigns use the
   default `'initial'` and behave exactly as A6 assumed.
5. **A12: `growth_config` → same table**, canonical name `growth_settings`.
6. **A8: `newsletter_opt_out default false` → ACCEPTED with pinned semantics**:
   it only narrows the marketing-opted-in audience
   (`marketing_opt_in AND NOT newsletter_opt_out`); it never creates a
   newsletter audience by default. This keeps the owner's opt-in-first decision
   intact — flag to A1 to confirm the framing in the policy text.
7. **A12: per-advertiser 1/7d sub-cap → ACCEPTED, made configurable**
   (`growth_settings.advertiser_user_weekly_cap`, default 1) and enforced in
   both `campaign_eligible_recipients` and `claim_send_slot`.
