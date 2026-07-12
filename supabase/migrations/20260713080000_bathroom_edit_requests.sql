-- Watrloo: bathroom edit requests — the approval path the ownership model
-- implies. Creators can't touch a bathroom after adding it (20260713060000);
-- instead they PROPOSE an edit, and an admin approves (patch applied in the
-- same transaction) or rejects with a note. Reviews are untouched by this:
-- authors keep full control of their own reviews.

-- Audit vocabulary (FULL list — the standing rule).
alter table public.moderation_actions drop constraint if exists moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'delete_review_photo',
    'submit_campaign', 'approve_campaign', 'reject_campaign',
    'pause_campaign', 'resume_campaign', 'stop_campaign',
    'suspend_business', 'unsuspend_business', 'dispatch_blast',
    'set_growth_setting', 'update_placement',
    'grant_appeal', 'deny_appeal', 'hard_delete_bathroom',
    'upsert_attribute',
    'assign_bathroom', 'unassign_bathroom',
    'create_business', 'delete_business', 'set_org_member',
    'approve_edit_request', 'reject_edit_request'            -- new
  ));

create table if not exists public.bathroom_edit_requests (
  id            uuid primary key default gen_random_uuid(),
  bathroom_id   uuid not null references public.bathrooms (id) on delete cascade,
  requester_id  uuid not null references public.profiles (id) on delete cascade,
  -- Only the fact fields, validated key-by-key in the RPC.
  proposed      jsonb not null,
  note          text check (char_length(note) <= 1000),
  status        text not null default 'open' check (status in ('open','approved','rejected')),
  decided_by    uuid references public.profiles (id) on delete set null,
  decision_note text check (char_length(decision_note) <= 1000),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists bathroom_edit_requests_open_idx
  on public.bathroom_edit_requests (created_at desc) where status = 'open';

alter table public.bathroom_edit_requests enable row level security;
grant select on public.bathroom_edit_requests to authenticated;
drop policy if exists "requester reads own edit requests, moderators all" on public.bathroom_edit_requests;
create policy "requester reads own edit requests, moderators all"
  on public.bathroom_edit_requests for select to authenticated
  using (requester_id = (select auth.uid()) or (select public.is_moderator()));
-- Writes via RPC only.

-- Creator proposes an edit to a bathroom they added. One open request per
-- bathroom per requester; unknown keys rejected.
create or replace function public.file_bathroom_edit(
  p_bathroom_id uuid, p_proposed jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  k text;
  v_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from public.bathrooms b
                  where b.id = p_bathroom_id and b.created_by = uid
                    and b.deleted_at is null) then
    raise exception 'not a live bathroom you created' using errcode = '42501';
  end if;
  if exists (select 1 from public.bathroom_edit_requests r
              where r.bathroom_id = p_bathroom_id and r.requester_id = uid
                and r.status = 'open') then
    raise exception 'you already have an open edit request for this bathroom'
      using errcode = '23505';
  end if;
  if p_proposed is null or p_proposed = '{}'::jsonb then
    raise exception 'nothing proposed' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_proposed) loop
    if k not in ('name','address','description',
                 'wheelchair_accessible','gender_neutral','changing_table','requires_key') then
      raise exception 'unknown field: %', k using errcode = '22023';
    end if;
  end loop;

  insert into public.bathroom_edit_requests (bathroom_id, requester_id, proposed, note)
  values (p_bathroom_id, uid, p_proposed, nullif(left(btrim(coalesce(p_note,'')), 1000), ''))
  returning id into v_id;
  return v_id;
end; $$;
grant execute on function public.file_bathroom_edit(uuid, jsonb, text) to authenticated;

-- Admin decides. Approving applies the proposed patch in the same transaction.
create or replace function public.admin_decide_bathroom_edit(
  p_request_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.bathroom_edit_requests;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into r from public.bathroom_edit_requests
   where id = p_request_id and status = 'open';
  if r.id is null then
    raise exception 'request not open' using errcode = 'P0002';
  end if;

  if p_approve then
    update public.bathrooms set
      name = coalesce(nullif(btrim(r.proposed ->> 'name'), ''), name),
      address = coalesce(nullif(btrim(r.proposed ->> 'address'), ''), address),
      description = case when r.proposed ? 'description'
                         then nullif(btrim(r.proposed ->> 'description'), '')
                         else description end,
      wheelchair_accessible = coalesce((r.proposed ->> 'wheelchair_accessible')::boolean, wheelchair_accessible),
      gender_neutral        = coalesce((r.proposed ->> 'gender_neutral')::boolean, gender_neutral),
      changing_table        = coalesce((r.proposed ->> 'changing_table')::boolean, changing_table),
      requires_key          = coalesce((r.proposed ->> 'requires_key')::boolean, requires_key)
    where id = r.bathroom_id;

    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values ((select auth.uid()), 'update_bathroom', 'bathroom', r.bathroom_id,
            jsonb_build_object('via', 'edit_request', 'request', r.id));
  end if;

  update public.bathroom_edit_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = (select auth.uid()),
         decision_note = nullif(left(btrim(coalesce(p_note,'')), 1000), ''),
         decided_at = now()
   where id = p_request_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()),
          case when p_approve then 'approve_edit_request' else 'reject_edit_request' end,
          'bathroom', r.bathroom_id,
          jsonb_build_object('request', r.id, 'note', p_note));
end; $$;
grant execute on function public.admin_decide_bathroom_edit(uuid, boolean, text) to authenticated;
