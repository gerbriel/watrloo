-- Watrloo: self-service account deletion.
--
-- A client holding only the anon key cannot delete its own auth.users row, so
-- this SECURITY DEFINER RPC does it on the caller's behalf — and only ever for
-- the caller (auth.uid()), never an arbitrary id.
--
-- Deleting the auth user cascades: profiles -> reviews -> review_photos (rows),
-- and user_roles. Bathrooms the user added are kept but un-owned
-- (bathrooms.created_by -> null), so community content survives. The photo
-- *files* in storage are not reachable from SQL (the storage service owns the
-- bytes), so the client deletes those from the user's `<uid>/` prefix before
-- calling this. See src/lib/api/profiles.ts.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from auth.users where id = uid;
end;
$$;

grant execute on function public.delete_my_account() to authenticated;
