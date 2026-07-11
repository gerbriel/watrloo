-- Watrloo: photo-level moderation.
--
-- A review can be fine while one of its photos is not (explicit content, a
-- face, a license plate). The existing tools were all-or-nothing: soft-delete
-- the whole review. This adds a targeted, audited takedown of a single photo.
--
-- Unlike review removal this is NOT reversible: the point is to destroy the
-- offending bytes, not to hide them behind RLS. The client removes the
-- storage object first (policy below — SQL can't reach bytes), then calls the
-- RPC, which drops the row and writes the audit record. If the RPC fails, the
-- client retries both halves: re-removing a missing object is a no-op and the
-- RPC skips the audit row when the photo is already gone, so the pair is
-- idempotent. The reverse order would leave explicit bytes publicly served at
-- their URL with no row left pointing at them — exactly the failure that
-- matters most here.

-- The audit log's CHECKs enumerate every known action; widen them first.
alter table public.moderation_actions
  drop constraint moderation_actions_action_check;
alter table public.moderation_actions
  add constraint moderation_actions_action_check check (action in (
    'soft_delete_review', 'restore_review',
    'soft_delete_bathroom', 'restore_bathroom',
    'resolve_report', 'dismiss_report',
    'grant_role', 'revoke_role',
    -- business-tier actions (20260711000000) — must survive this rewrite
    'update_bathroom', 'approve_access_request', 'verify_claim', 'reject_claim',
    'delete_review_photo'));

alter table public.moderation_actions
  drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions
  add constraint moderation_actions_target_type_check check (
    target_type in ('review', 'bathroom', 'report', 'profile', 'photo'));

-- Storage: the author-only policy confines deletes to the uploader's own
-- `<uid>/` prefix; a moderator must be able to reach anyone's objects here.
create policy "moderators delete any review photo object"
  on storage.objects for delete to authenticated
  using (bucket_id = 'review-photos' and (select public.is_moderator()));

-- Row + audit in one transaction, same shape as the other moderation RPCs.
-- The storage_path lands in the audit detail so what-was-removed survives in
-- the log after the row is gone.
create or replace function public.moderate_delete_review_photo(p_photo_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo public.review_photos%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.review_photos
   where id = p_photo_id
   returning * into v_photo;

  -- Already gone (a retry, or two moderators racing): nothing to audit twice.
  if v_photo.id is null then
    return;
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
  values ((select auth.uid()), 'delete_review_photo', 'photo', p_photo_id,
          jsonb_build_object(
            'reason', p_reason,
            'review_id', v_photo.review_id,
            'storage_path', v_photo.storage_path));
end;
$$;

grant execute on function public.moderate_delete_review_photo(uuid, text) to authenticated;
