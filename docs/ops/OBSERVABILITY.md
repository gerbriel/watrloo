# Watrloo — Observability, error tracking & diagnostics

**Author:** OBSERVABILITY agent · **Date:** 2026-07-09
**Constraint honored:** self-sufficient. Everything here lives inside **Supabase + the browser**. No Sentry, Datadog, LogRocket, PostHog cloud, or any third-party SaaS on the hot path.

> This document proposes code. It does **not** apply it. Every SQL block belongs to the schema/DATA agent's migrations; every `.ts`/`.tsx` block is for the FEATURES/PLATFORM agent to paste. Nothing here edits source, migrations, `vite.config.ts`, or `package.json`.

Two hard dependencies on other agents are flagged inline:
- **USER ROLES agent** owns `profiles.role` / `public.is_admin()`. The admin read policy and `/admin/errors` gate are written against that helper and marked `DEPENDS ON ROLES`.
- **PLATFORM agent** owns `main.tsx`, `App.tsx`, `router.tsx`, and `vite.config.ts` wiring. The three-line install is marked `WIRING`.

## Verification

Independent fact-check of the platform claims in this document (checked 2026-07-10 against primary sources).

| Claim | Status | Source | Correction / note |
|---|---|---|---|
| Free-plan log retention = **1 day** (Pro 7, Team 28) | **CONFIRMED** | [pricing](https://supabase.com/pricing) | Free is **1 day** for API/Postgres logs specifically; **Auth Audit logs are 1 hour** on Free. The "1 day" figure the doc relies on is correct |
| `pg_stat_statements` **enabled by default** on every project | **CONFIRMED** | [database/inspect](https://supabase.com/docs/guides/database/inspect) | the cited [pg_stat_statements extension page](https://supabase.com/docs/guides/database/extensions/pg_stat_statements) does **not** itself state "enabled by default" — the Debugging & monitoring page does ("every Supabase project has the pg_stat_statements extension enabled by default") |
| `pg_stat_statements` retains **~5,000** statements | **UNVERIFIABLE** | — | matches the Postgres default `pg_stat_statements.max = 5000`, but not confirmed as Supabase's value in primary docs |
| `pg_cron` available on the **Free** plan | **CONFIRMED** | [discussion #37405](https://github.com/orgs/supabase/discussions/37405) | Supabase staff: "Cron is only limited by the resources it uses CPU/Memory/Disk wise on any tier." The doc's correction of the earlier "pg_cron is Pro-gated" claim is **right** |
| `pg_net` for async outbound HTTP from Postgres | **CONFIRMED** | [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) | available extension |
| Sentry self-hosted minimum ≈ **4 CPU / 16 GB RAM / 20 GB disk** | **CONFIRMED** | [Sentry self-hosted](https://develop.sentry.dev/self-hosted/) | exact: **4 CPU cores, 16 GB RAM + 16 GB swap, 20 GB free disk** (32 GB RAM recommended) |
| Sentry self-hosted runs **~40+ containers** | **UNVERIFIABLE** | — | the self-hosted page does not state a container count; the order-of-magnitude ("a large multi-service stack") is not in doubt |

---

## 1. Today's reality

Every function in `src/lib/api/*.ts` ends in `if (error) throw error`. Here is where those throws actually land, traced through the code.

### 1.1 There is no error boundary anywhere

- `src/router.tsx` — `createBrowserRouter([...])` defines **no `errorElement`** on any route. `src/App.tsx`, `src/main.tsx` — **no `ErrorBoundary`** component exists in the repo (confirmed: `grep` finds zero).
- Because this is a **data router** (`createBrowserRouter` + `<RouterProvider>`), React Router v7 supplies a **built-in default error boundary**: if a *route element* throws **during render**, the user sees React Router's generic **"Unexpected Application Error!"** screen (message only in a production build; stack in dev) — unstyled, off-brand, but **not** a blank page.
- The catch: **`AuthProvider` sits *above* `<RouterProvider>`** in `App.tsx`. Anything that throws during `AuthProvider`'s render, or during module evaluation, is **outside** the router's boundary → nothing catches it → **blank white `#root`**. Concretely:
  - `src/lib/supabase.ts` throws at **import time** if `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are missing → white screen, no React ever mounts.
  - Any render-time throw in `AuthProvider` → white screen.

### 1.2 Unhandled promise rejections

Most async user flows *do* have local `try/catch` (Home, MapPage, BathroomDetail, both forms, SignIn, SignUp) — so the user gets a message. But the message is **shown and discarded**; nothing is recorded. And there are genuinely unhandled paths:

- **`AuthProvider` boot**, `src/auth/AuthProvider.tsx:55` — `supabase.auth.getSession().then(...)` has **no `.catch`**. If the network is down at first paint, the rejection is unhandled, `loading` never flips to `false`, and **every `RequireAuth` route spins forever** while public pages render fine. Nothing is recorded; the promise rejection vanishes.
- Any `async` event handler that isn't wrapped (React does not await handlers) rejects into `window.onunhandledrejection` — **for which nothing is listening**.
- Synchronous throws in event handlers go to `window.onerror` — **for which nothing is listening**.

### 1.3 What the user sees vs. what gets recorded

| Failure mode | What the user sees | What gets recorded |
|---|---|---|
| `listBathrooms()` throws (`Home`) | Styled "Couldn't load bathrooms" + **Try again** | Client: **nothing** (message shown then dropped). Server: the failing PostgREST request in Supabase **API logs — for 24h only**, no stack, not linked to the user action |
| `getBathroom()` / `listReviewsForBathroom()` throws (`BathroomDetail`) | Styled "Couldn't load this bathroom" | Same — **nothing** client-side; 24h API log server-side |
| `listBathrooms({limit:500})` throws (`MapPage`) | Styled "Couldn't load the map" | Same |
| `createBathroom()` rejects (`BathroomForm`) | Inline form error message | **Nothing** client-side; POST failure in 24h API log |
| `upsertReview()` / `uploadReviewPhoto()` rejects (`ReviewForm`) | Inline "Could not save your review" | Same |
| **Render error** in a route component (e.g. `stats.avg_rating.toFixed` on a bad shape) | React Router's generic **"Unexpected Application Error"** screen | **Nothing, anywhere** |
| Render throw in **`AuthProvider`** (above the router) | **Blank white screen** | **Nothing, anywhere** |
| Missing env vars → `supabase.ts` throws at import | **Blank white screen**, React never mounts | **Nothing, anywhere** |
| `getSession()` rejects at boot (offline) | Gated routes **spin forever**; public pages load | **Nothing** — unhandled rejection swallowed |
| Unhandled rejection in an async handler | Usually nothing visible | **Nothing** — no `onunhandledrejection` listener |
| Sync throw in an event handler | Usually nothing visible | **Nothing** — no `onerror` listener |

**The uncomfortable summary:** the only diagnostic that exists today is Supabase's own request log, which on the **Free plan is retained for 1 day** (§3), carries no client stack, and cannot tell you *which user on which route* hit the error. Two of the failure modes are a **fully blank screen with zero trace**. We are flying blind.

---

## 2. The design

A single append-only table `client_errors`, an `errors.ts` sink with client-side dedup + caps + PII scrubbing, three wiring points (`window.onerror`, `window.onunhandledrejection`, a React `ErrorBoundary`), and an admin-only read surface.

### 2.1 Schema + RLS + rate limiting (for the DATA agent's migration)

```sql
-- ---------------------------------------------------------------------------
-- client_errors: append-only sink for browser-side errors.
-- Anonymous clients may INSERT (write-only); they may NOT read, update, or
-- delete. Reads are for service_role (dashboard) and, once roles land, admins.
-- ---------------------------------------------------------------------------
create table public.client_errors (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  message         text not null,
  stack           text,
  component_stack text,
  route           text,                 -- pathname only, never the query string
  user_id         uuid references auth.users (id) on delete set null,
  user_agent      text,
  release         text,                 -- build sha, to line up with source maps
  severity        text not null default 'error'
                  check (severity in ('warning', 'error', 'fatal')),
  fingerprint     text not null,        -- client-computed hash for dedup
  client_ip       inet                  -- stamped by the trigger, not the client
);

create index client_errors_created_at_idx  on public.client_errors (created_at desc);
create index client_errors_fingerprint_idx on public.client_errors (fingerprint, created_at desc);

alter table public.client_errors enable row level security;
```

**RLS — the hard part.** Insert-only for everyone, with **size caps enforced in the policy itself** so a malicious client cannot store multi-megabyte blobs, and **no `select`/`update`/`delete` policy at all** so the table is genuinely write-only to `anon`/`authenticated`:

```sql
-- INSERT: anyone may report, but the row must be small and well-formed.
create policy "anyone may report an error"
  on public.client_errors for insert
  to anon, authenticated
  with check (
        char_length(message) <= 2000
    and (stack is null           or char_length(stack) <= 8000)
    and (component_stack is null or char_length(component_stack) <= 8000)
    and (route is null           or char_length(route) <= 300)
    and (user_agent is null      or char_length(user_agent) <= 400)
    and (release is null         or char_length(release) <= 80)
    and severity in ('warning', 'error', 'fatal')
    -- if a user_id is claimed it must be the caller (anon must send null):
    and (user_id is null or user_id = (select auth.uid()))
  );

-- NOTE: deliberately NO select/update/delete policy for anon/authenticated.
-- With RLS enabled and no permissive policy, those commands return zero rows /
-- are rejected. The table is append-only from the client's point of view.
```

> `client_ip` is intentionally left out of the `WITH CHECK`. Whatever value a client sends is overwritten by the trigger below, so there is no ordering hazard between BEFORE-triggers and the RLS check.

**Rate limiting.** The client can't be trusted to self-limit, so cap on the server with a `SECURITY DEFINER` `BEFORE INSERT` trigger. It runs as the table owner, so it can *count* rows (which `anon` cannot read) and *read the forwarded client IP* from the PostgREST request headers. Returning `NULL` from a `BEFORE INSERT` trigger **silently skips the row without erroring the client** — exactly right for fire-and-forget telemetry:

```sql
create or replace function public.client_errors_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fwd    text := current_setting('request.headers', true)::json ->> 'x-forwarded-for';
  recent int;
begin
  -- Stamp the server-observed IP; ignore anything the client tried to set.
  new.client_ip := nullif(split_part(coalesce(fwd, ''), ',', 1), '')::inet;

  -- Global flood cap: <= 240 rows/minute across ALL clients.
  select count(*) into recent
  from public.client_errors
  where created_at > now() - interval '1 minute';
  if recent >= 240 then
    return null;                      -- drop, don't error
  end if;

  -- Per-fingerprint cap: <= 20 of the same error per hour (backstops the client).
  select count(*) into recent
  from public.client_errors
  where fingerprint = new.fingerprint
    and created_at > now() - interval '1 hour';
  if recent >= 20 then
    return null;
  end if;

  return new;
end;
$$;

create trigger client_errors_guard_trg
  before insert on public.client_errors
  for each row execute function public.client_errors_guard();
```

> **`x-forwarded-for` reliability: unverified.** Reading the client IP via `current_setting('request.headers', true)` is a documented Supabase/PostgREST technique, but whether the header is consistently present and trustworthy behind Supabase's gateway should be confirmed against your project before relying on it for anything but coarse rate-limiting. The global + per-fingerprint row-count caps do not depend on it and are the primary defense.

**Can *you* still read an insert-only, no-select table? Yes — two ways, confirmed:**
1. **`service_role` bypasses RLS entirely** (the role carries `BYPASSRLS`). Every query you run from the **Supabase dashboard SQL Editor / Table Editor**, or with the `service_role` key, sees all rows regardless of the absent `select` policy. This is the core Supabase security model — the dashboard is service-role.
2. **Admins via the app** — add a `select` policy gated to an admin check (below). This is what powers `/admin/errors` in the browser, where only the `anon`/`authenticated` key is available.

```sql
-- DEPENDS ON ROLES: public.is_admin() is owned by the USER ROLES agent.
-- Shown here as the expected shape so this migration is self-describing.
-- create or replace function public.is_admin()
--   returns boolean language sql stable security definer set search_path = ''
-- as $$ select exists (
--   select 1 from public.profiles
--   where id = (select auth.uid()) and role = 'admin') $$;

create policy "admins may read client errors"
  on public.client_errors for select
  to authenticated
  using (public.is_admin());
```

This `select` policy still returns **nothing** to a normal `anon` visitor — only rows for a signed-in admin. `anon` remains write-only.

### 2.2 `src/lib/errors.ts` — the sink

Guards, in order of importance: (1) **never throw into the caller**; (2) **never report while reporting** (reentrancy) and **trip permanently if the sink itself fails** (kills the infinite loop where reporting an error triggers another error); (3) **client-side dedup + per-fingerprint cap + per-session hard cap** (kills "same error 500×"); (4) **PII scrubbing** of message/stack before anything leaves the browser.

```ts
// src/lib/errors.ts
import { supabase } from '@/lib/supabase';

export type Severity = 'warning' | 'error' | 'fatal';

// Injected at build time (see §2.6). Falls back to 'dev' for local runs.
const RELEASE: string = import.meta.env.VITE_RELEASE_SHA ?? 'dev';

const SESSION_REPORT_CAP = 25; // hard cap of reports per page load
const PER_FINGERPRINT_CAP = 3; // same error at most 3x per session (client side)
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

let sending = false;   // reentrancy guard: never report while a report is in flight
let disabled = false;  // trips permanently the first time the sink itself fails
let totalSent = 0;
const seen = new Map<string, number>(); // fingerprint -> count this session

// --- PII scrubbing ---------------------------------------------------------
// Run over BOTH message and stack before anything leaves the browser.
const SCRUBBERS: [RegExp, string][] = [
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<email>'],
  [/eyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}/g, '<jwt>'],
  [/sb_(?:publishable|secret)_[a-zA-Z0-9]+/g, '<supabase-key>'],
  [/(access_token|refresh_token|apikey|password|token)=[^&\s"']+/gi, '$1=<redacted>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
];

function scrub(input: string | null | undefined): string | null {
  if (!input) return null;
  let out = input;
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out;
}

// pathname only — the query string / hash can carry tokens or PII.
function currentRoute(): string {
  try {
    return location.pathname;
  } catch {
    return 'unknown';
  }
}

// Cheap, stable, non-cryptographic hash (djb2-ish) for dedup.
function fingerprint(message: string, stack: string | null): string {
  const topFrame =
    (stack ?? '').split('\n').find((l) => /\.[jt]sx?:\d+/.test(l))?.trim() ?? '';
  const basis = `${currentRoute()}|${message}|${topFrame}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h) ^ basis.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error('Non-serializable thrown value');
  }
}

export function reportError(
  err: unknown,
  opts: { severity?: Severity; componentStack?: string } = {},
): void {
  // Cheap bail-outs that also break the report-an-error-while-reporting loop.
  if (disabled || sending || totalSent >= SESSION_REPORT_CAP) return;

  try {
    const e = toError(err);
    const message = (scrub(e.message) ?? 'Unknown error').slice(0, MAX_MESSAGE);
    const stack = scrub(e.stack)?.slice(0, MAX_STACK) ?? null;
    const fp = fingerprint(message, stack);

    const count = seen.get(fp) ?? 0;
    if (count >= PER_FINGERPRINT_CAP) return; // client-side dedup + cap
    seen.set(fp, count + 1);

    const row = {
      message,
      stack,
      component_stack: scrub(opts.componentStack)?.slice(0, MAX_STACK) ?? null,
      route: currentRoute(),
      user_id: null as string | null, // best-effort filled in send()
      user_agent: navigator.userAgent.slice(0, 400),
      release: RELEASE,
      severity: opts.severity ?? 'error',
      fingerprint: fp,
    };

    sending = true;
    totalSent += 1;
    // Fire-and-forget. Any failure permanently disables the sink so a broken
    // network / broken table can never spiral into repeated failed reports.
    void send(row)
      .catch(() => {
        disabled = true;
      })
      .finally(() => {
        sending = false;
      });
  } catch {
    // The reporter must NEVER throw back into the caller.
    disabled = true;
    sending = false;
  }
}

async function send(row: Record<string, unknown>): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    row.user_id = data.session?.user.id ?? null;
  } catch {
    /* leave user_id null */
  }
  const { error } = await supabase.from('client_errors').insert(row);
  if (error) throw error;
}

// --- Global handlers -------------------------------------------------------
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    // event.error is null for resource-load failures (<img> 404 etc.) — skip.
    if (!event.error) return;
    reportError(event.error, { severity: 'error' });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { severity: 'error' });
  });
}
```

### 2.3 `src/components/ErrorBoundary.tsx`

```tsx
// src/components/ErrorBoundary.tsx
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { reportError } from '@/lib/errors';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, {
      severity: 'fatal',
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return this.props.fallback ?? <DefaultFallback />;
  }
}

function DefaultFallback() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <p className="text-lg font-semibold text-app">Something broke on our end</p>
      <p className="max-w-sm text-sm text-muted">
        The page hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        onClick={() => location.reload()}
        className="mt-2 rounded-lg bg-flush-500 px-4 py-2 text-sm font-medium text-white hover:bg-flush-600"
      >
        Reload
      </button>
    </div>
  );
}
```

A React error boundary only catches errors thrown **during render/lifecycle** of its subtree — it does **not** catch event-handler or async rejections. That is exactly why all three sinks (`onerror`, `onunhandledrejection`, `ErrorBoundary`) are needed, all routed to the same `reportError`.

### 2.4 `WIRING` — how the three sinks attach (for the PLATFORM agent)

Two boundaries are needed because of the `AuthProvider`-above-router problem from §1.1:

```tsx
// src/main.tsx — install global handlers BEFORE React mounts, so a crash during
// the very first render is still captured.
import { installGlobalErrorHandlers } from '@/lib/errors';
installGlobalErrorHandlers();
// ...existing createRoot(...).render(<StrictMode><App/></StrictMode>)
```

```tsx
// src/App.tsx — wrap the WHOLE tree, including AuthProvider, so a render throw
// above the router no longer white-screens.
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ErrorBoundary>
  );
}
```

```tsx
// src/router.tsx — also give the router a route-level errorElement so route
// render errors are reported (and get a branded screen) instead of React
// Router's bare default. A small wrapper reports via useRouteError:
import { useRouteError } from 'react-router-dom';
import { useEffect } from 'react';
import { reportError } from '@/lib/errors';

function RouteError() {
  const error = useRouteError();
  useEffect(() => {
    reportError(error, { severity: 'fatal' });
  }, [error]);
  return (/* branded fallback, same markup as DefaultFallback */ null);
}
// then on the root route object: { element: <Layout />, errorElement: <RouteError />, children: [...] }
```

Also add a `.catch` to `getSession()` in `AuthProvider` (§1.2) so the boot-time-offline hang both reports and flips `loading` to `false`.

### 2.5 `/admin/errors` — the in-app diagnostics surface

A read-only page behind an admin gate. Because the browser only holds the `anon`/`authenticated` key, reads flow through the **`select` policy** from §2.1 (`using (public.is_admin())`), so a non-admin gets an empty result set even if they reach the route.

```tsx
// src/pages/admin/Errors.tsx  (sketch)
// DEPENDS ON ROLES: useAuth().profile.role === 'admin', or a useIsAdmin() hook
// provided by the USER ROLES agent.
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export function AdminErrorsPage() {
  const [rows, setRows] = useState<ClientErrorRow[]>([]);
  useEffect(() => {
    // RLS returns rows only if the caller is an admin; no rows otherwise.
    supabase
      .from('client_errors')
      .select('id, created_at, severity, message, route, release, fingerprint, user_id')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setRows((data ?? []) as ClientErrorRow[]));
  }, []);
  // Group by fingerprint for a "top errors" view; expand for stack + count.
  return /* table: severity · count · route · message · last-seen · release */ null;
}
```

Route registration (`router.tsx`) should gate this the same way `RequireAuth` does, plus an admin check:

```tsx
// { path: '/admin/errors', element: <RequireAdmin><AdminErrorsPage/></RequireAdmin> }
// RequireAdmin = RequireAuth + a profile.role === 'admin' check (ROLES agent).
```

A useful grouping query for the dashboard (run as service_role, or behind `is_admin()`):

```sql
select fingerprint,
       count(*)                        as occurrences,
       max(created_at)                 as last_seen,
       max(severity)                   as worst_severity,
       (array_agg(message order by created_at desc))[1] as latest_message,
       (array_agg(route   order by created_at desc))[1] as latest_route,
       count(distinct user_id)         as users_affected
from public.client_errors
where created_at > now() - interval '7 days'
group by fingerprint
order by occurrences desc
limit 50;
```

### 2.6 Source maps — emit, don't publish, symbolicate offline

A minified stack (`a.b<c$2` at `index-8fk2.js:1:24518`) is useless. But this is a **public-repo, public-app**: shipping `.map` files to the CDN hands anyone your original TypeScript. Resolution:

- **Emit hidden source maps.** In `vite.config.ts` (PLATFORM agent): `build: { sourcemap: 'hidden' }`. `'hidden'` produces the `.map` files **but omits the `//# sourceMappingURL=` comment** from the bundle, so browsers/DevTools won't fetch them and casual visitors can't discover them. (Vite build options — https://vite.dev/config/build-options.)
- **Do not deploy the `.map` files.** Exclude `dist/**/*.map` from what gets uploaded to the static host (they're build artifacts, not runtime assets). Keep them **private**, archived per release: a private branch, a **private** Supabase Storage bucket, or CI artifacts keyed by the git sha.
- **Stamp every error with the release sha** (the `release` column, fed by `VITE_RELEASE_SHA`). That's the key that lets you pull the *matching* `.map` for a stack you're debugging.
- **Symbolicate on demand, offline**, with a tiny Node script using the `source-map` package (dev-only tooling, run locally — never shipped to the browser):

```js
// scripts/symbolicate.mjs  — usage: node scripts/symbolicate.mjs <file.js.map> <line> <col>
import { readFile } from 'node:fs/promises';
import { SourceMapConsumer } from 'source-map';

const [, , mapPath, line, col] = process.argv;
const raw = JSON.parse(await readFile(mapPath, 'utf8'));
await SourceMapConsumer.with(raw, null, (consumer) => {
  const pos = consumer.originalPositionFor({ line: Number(line), column: Number(col) });
  console.log(`${pos.source}:${pos.line}:${pos.column}  ${pos.name ?? ''}`);
});
```

> `source-map` would be a **dev-only** dependency, run offline against archived maps. It never enters the bundle. (If even that's unwanted, Chrome DevTools can load a local `.map` by hand — right-click the frame → "Add source map".)

Why not auto-symbolication? Because that's precisely what a hosted error tracker (Sentry) buys you, and it's off the table (§5). Manual symbolication is the honest cost of self-hosting; for a low-volume app it's a two-minute lookup, not a pipeline.

---

## 3. What Supabase gives you for free (verified)

Supabase already logs a lot; the catch is **retention** and **no push/alerting**.

- **Logs Explorer** (dashboard → Logs) exposes, as separate sources you can SQL-query: **Postgres logs, API / PostgREST request logs, Auth (GoTrue) logs, Storage logs, Realtime logs, Edge Function logs.** (https://supabase.com/docs/guides/telemetry/logs) Query them with the advanced filtering / SQL interface — https://supabase.com/docs/guides/telemetry/advanced-log-filtering.
- **Retention on the Free plan is 1 day.** Verified against the pricing page (https://supabase.com/pricing): **Free = 1 day**, Pro = 7 days, Team = 28 days of log retention (confirmed 2026-07-10; the 1-day figure applies to API/Postgres logs — **Auth Audit logs are retained only 1 hour** on Free). So anything not captured into your *own* table (`client_errors`) is gone in 24 hours. This is the single biggest reason to build §2.
- **What you CAN query:** individual request rows (status, path, latency, auth role), Postgres error/notice messages, auth events (sign-ins, failures) — for the last 24h.
- **What you CANNOT do for free:** retain beyond 1 day; get a **client-side** stack (Supabase only sees the server side of a request — it never sees a React render crash or a `window.onerror`); receive any **push** notification (no email/webhook on error). **Log Drains** (streaming logs to an external sink) exist but are a **Pro** feature and would mean an external service anyway — out of scope.
- **`pg_stat_statements` is enabled by default on every Supabase project** (confirmed 2026-07-10 — but the "enabled by default" statement is on the Debugging & monitoring page https://supabase.com/docs/guides/database/inspect, **not** the extension page https://supabase.com/docs/guides/database/extensions/pg_stat_statements cited here, which only documents how to enable it), and the dashboard's **Database → Query Performance** view + Performance Advisor read from it to flag slow queries and suggest indexes. Caveat: it retains **the latest ~5,000 statements** **[unverified: matches the Postgres default `pg_stat_statements.max = 5000` but not confirmed as Supabase's value in primary docs]**. This is your free slow-query hunting tool — no setup. For this app, the query to watch is the leading-`%` `ILIKE` in `listBathrooms` (a seq scan; the RESEARCH doc's `pg_trgm` GIN index fixes it) and the two-round-trip `attachStats` pattern.

---

## 4. Alerting without a notification channel — the honest analysis

**This is the weak point, and it's structural: Supabase gives you a database and a scheduler, but no way to *reach a human*.** There is no email service, no SMS, no push. Be honest about that up front.

What *is* available, verified:
- **`pg_cron` is available on the Free plan** — every Supabase project ships it; enable with `create extension if not exists pg_cron;` and schedule with `cron.schedule(...)`. (https://supabase.com/docs/guides/database/extensions/pg_cron, https://supabase.com/docs/guides/cron, and confirmed for free tier in https://github.com/orgs/supabase/discussions/37405.) *(An earlier generic web summary claimed pg_cron is Pro-gated; that is outdated/incorrect — the current docs and the free-tier discussion contradict it.)*
- **`pg_net`** lets Postgres make outbound async HTTP calls (https://supabase.com/docs/guides/database/extensions/pg_net).
- **Free-plan caveat that undercuts in-DB scheduling:** free projects are **paused after 1 week of inactivity** (pricing page). A paused project's `cron` jobs don't run, and a paused DB won't answer an external query either. For a sleepy hobby project this makes *any* scheduler unreliable; for an app with daily traffic it's a non-issue. Say which you are.

Given no notification channel, three options, least-bad first:

**Option A — `health_checks` table + the `/admin/errors` dashboard (pure Supabase, pull-only).**
A `pg_cron` job every 5 minutes computes signals into a table you already read in the admin surface. Zero third parties. The cost: **you only find out when you look** — it's a dashboard, not an alert.

```sql
create table public.health_checks (
  id         bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  metric     text not null,
  value      numeric not null,
  ok         boolean not null,
  detail     text
);
alter table public.health_checks enable row level security;
create policy "admins read health" on public.health_checks
  for select to authenticated using (public.is_admin()); -- DEPENDS ON ROLES

select cron.schedule('error-spike-check', '*/5 * * * *', $$
  insert into public.health_checks (metric, value, ok, detail)
  select 'client_errors_5m', c, c < 50,
         case when c >= 50 then 'error spike: ' || c || ' errors in 5 min' end
  from (select count(*)::numeric as c
        from public.client_errors
        where created_at > now() - interval '5 minutes') s;
$$);
```

**Option B — `pg_cron` + `pg_net` opens a GitHub Issue directly (push, fully in Supabase).**
`pg_net` can `POST` to the GitHub REST API from inside Postgres, with a fine-scoped PAT stored in **Supabase Vault**. GitHub is technically a third party — but **the repo already lives on GitHub**, issues are free and unlimited, and an issue is a real notification (email/app). This is the closest thing to true alerting that stays honest.

```sql
select cron.schedule('error-spike-alert', '*/5 * * * *', $$
  with spike as (
    select count(*) as c from public.client_errors
    where created_at > now() - interval '5 minutes')
  select net.http_post(
    url     := 'https://api.github.com/repos/<owner>/watrloo/issues',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat'),
      'User-Agent', 'watrloo-health', 'Accept', 'application/vnd.github+json'),
    body    := jsonb_build_object(
      'title', 'Error spike: ' || c || ' client errors in 5 min',
      'body',  'Auto-filed by pg_cron. Check /admin/errors.',
      'labels', jsonb_build_array('alert', 'observability')))
  from spike where c >= 50;
$$);
```

**Option C — a GitHub Action on a cron queries the DB and opens an issue (push, pull model).**
A scheduled workflow (`on: schedule`) runs a read-only query with a limited key held in GitHub Secrets, and files an issue on threshold. **Is this "third party"?** Judgment call: it's an external runner, *but* it's the same platform already hosting the code, **free with unlimited minutes for public repos**, and GitHub-hosted runners are themselves self-hostable if you ever needed. I'd class it **tier-B-ish, acceptable** — the repo's own CI, not a new SaaS dependency. Its advantage over B: the schedule lives outside the DB, so a misconfigured `pg_cron` can't silently stop your alerts. Its shared disadvantage with A/B: if the free project is **paused**, the query can't even connect.

**Recommendation:** ship **A now** (it's free, in-Supabase, and the dashboard is being built anyway), and add **B** once there's a PAT in Vault. Treat C as the fallback if you want the alert schedule to live outside the DB. Accept the honest truth: **without SMTP or a paid drain, "alerting" means "an issue or a dashboard you check," not a 3am page.** For a bathroom-rating app, that is the correct amount of alerting.

---

## 5. Rejected — and why

| Rejected | Why, specifically |
|---|---|
| **Sentry (SaaS)** | The obvious answer to error tracking, and **off the table**: it's a third-party on the hot path, and its free tier is metered (event caps, 30/90-day retention) — "free tier that can bill/limit later," which this project treats as not-free. |
| **Sentry, self-hosted** | Technically OSS, but **not realistic here.** Self-hosting is via `getsentry/self-hosted` (Docker Compose) and Sentry's own docs state a **minimum of ~4 CPU cores, 16 GB RAM, and 20 GB disk** (confirmed 2026-07-10: exactly 4 CPU cores, 16 GB RAM + 16 GB swap, 20 GB free disk; 32 GB RAM recommended) — it runs **~40+ containers** **[unverified: the self-hosted docs do not state a container count]** (Kafka, ClickHouse, Redis, Postgres, Relay, Snuba, workers…). That is a standing server cluster to babysit and pay for, dwarfing the app it watches. A `client_errors` table plus 150 lines of TypeScript covers this app's needs at ~0 incremental cost. *(Resource figures are Sentry's self-hosted guidance; treat exact numbers as approximate/version-dependent — but the order of magnitude is not in doubt.)* |
| **Datadog / New Relic / Grafana Cloud** | Third-party SaaS, metered free tiers that bill on volume. Same rejection class as Sentry-SaaS. Self-hosting Grafana + Loki/Tempo/Prometheus is possible but is again a standing observability stack far larger than this app warrants. |
| **LogRocket / FullStory (session replay)** | Third-party SaaS; also a serious privacy surface (records user sessions) for an app whose whole ethos is self-sufficiency and minimal data. Hard no. |
| **PostHog Cloud** | Third-party SaaS, metered. (Self-hosted PostHog is OSS but, like Sentry, a multi-container ClickHouse/Kafka stack — same "bigger than the app" problem.) |
| **Supabase Log Drains** | Would stream logs somewhere useful, but it's a **Pro** feature *and* implies an external sink — fails both the free and the self-sufficiency tests. |
| **An email/SMS alert provider (SendGrid, Twilio, Resend…)** | Would give real push alerts, but each is a third-party with a metered free tier. Rejected; hence the GitHub-issue compromise in §4. |

---

## 6. Ship order — the three things to do first

1. **The table + RLS + the `errors.ts` sink + the three sinks wired in.** This is the whole point: today two failure modes are a blank screen with zero trace. `client_errors` (§2.1) + `errors.ts` (§2.2) + `installGlobalErrorHandlers()` in `main.tsx` + `<ErrorBoundary>` around `App` (§2.4). After this, every crash — including the white-screen ones — leaves a fingerprinted, PII-scrubbed row you can read from the dashboard (service_role bypasses the no-select RLS). Also fix the missing `.catch` on `getSession()` while you're in `AuthProvider`.
2. **The rate-limit trigger + `hidden` source maps + release stamping.** Turn on `build.sourcemap: 'hidden'`, feed `VITE_RELEASE_SHA` (git sha) into the build, archive `dist/**/*.map` privately per release, and add `client_errors_guard()` (§2.1) so the table can't be flooded. Now stacks are symbolicatable (§2.6) and the sink is abuse-resistant.
3. **The `/admin/errors` read surface + `health_checks` cron (Option A).** Gate the page on the ROLES agent's admin check, add the `select` policy and the grouping query (§2.5), and schedule the 5-minute `health_checks` job (§4-A). That gives you a place to actually *look* at what #1 is collecting, plus a cheap in-DB signal. Layer in the GitHub-issue alert (§4-B) only once a PAT is in Vault.

Everything above is inside **Supabase + the browser**. The only external touch is the *optional* GitHub-issue alert in §4, which reuses the repo's existing home rather than adding a new SaaS.

---

### Sources
- Supabase pricing (Free = 1-day log retention; 2 projects; 500 MB DB; paused after 1 week; 5 GB egress) — https://supabase.com/pricing
- Logging / Logs Explorer (log sources; retention is plan-based) — https://supabase.com/docs/guides/telemetry/logs
- Advanced log filtering — https://supabase.com/docs/guides/telemetry/advanced-log-filtering
- pg_cron (available on Free; SQL & functions on a schedule) — https://supabase.com/docs/guides/database/extensions/pg_cron · https://supabase.com/docs/guides/cron · https://github.com/orgs/supabase/discussions/37405
- pg_net (async HTTP from Postgres) — https://supabase.com/docs/guides/database/extensions/pg_net
- pg_stat_statements (enabled by default; ~5,000-statement window; Query Performance dashboard) — https://supabase.com/docs/guides/database/extensions/pg_stat_statements
- Vite build source maps (`sourcemap: 'hidden'`) — https://vite.dev/config/build-options
