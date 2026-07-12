-- Let a "request business access" submission name the specific listings it
-- wants to claim: existing bathrooms picked from search, and free-text
-- locations that aren't on Watrloo yet. Advisory only — the admin reviews the
-- request. Postgres can't foreign-key array elements, so stale ids (a bathroom
-- deleted after the request) are simply ignored at review time.

alter table public.business_access_requests
  add column if not exists requested_bathroom_ids uuid[] not null default '{}',
  add column if not exists requested_new_locations text[] not null default '{}';

-- The insert policies only gate on requester_id, and `grant insert on <table>`
-- already covers new columns, so no RLS/grant change is needed. But anon can
-- insert here, so bound the array sizes — this is the manual request path, not
-- the bulk one (CSV import handles whole chains after approval).
alter table public.business_access_requests
  drop constraint if exists bar_requested_counts_chk;
alter table public.business_access_requests
  add constraint bar_requested_counts_chk check (
    coalesce(array_length(requested_bathroom_ids, 1), 0) <= 1000
    and coalesce(array_length(requested_new_locations, 1), 0) <= 500
  );
