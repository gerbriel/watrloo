-- Signup collects first/last name + optional phone + consent choices.
--
-- These are PII and `profiles` is world-readable by design, so they live in a
-- separate owner-and-admin-only table, written by the signup trigger from the
-- auth metadata (the client has no session yet when confirmation is on).

create table if not exists public.profile_private (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  first_name        text check (char_length(first_name) <= 80),
  last_name         text check (char_length(last_name) <= 80),
  phone             text check (char_length(phone) <= 32),
  terms_accepted_at timestamptz,
  created_at        timestamptz not null default now()
);
alter table public.profile_private enable row level security;

drop policy if exists "users read their own private profile" on public.profile_private;
create policy "users read their own private profile" on public.profile_private
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "users update their own private profile" on public.profile_private;
create policy "users update their own private profile" on public.profile_private
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "admins read private profiles" on public.profile_private;
create policy "admins read private profiles" on public.profile_private
  for select to authenticated using ((select public.is_admin()));

-- Extend the signup trigger: same race-safe username logic as before, plus the
-- private profile row and the consent row sourced from signup metadata.
-- Marketing opt-in arrives pre-checked from the form (owner decision, US
-- launch); absence of the key still means false.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  desired text;
  attempts int := 0;
begin
  if exists (select 1 from public.profiles p where p.id = new.id) then
    return new;
  end if;

  desired := regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-zA-Z0-9_]', '', 'g'
  );
  if char_length(desired) < 3 then
    desired := 'user_' || encode(extensions.gen_random_bytes(5), 'hex');
  end if;
  desired := left(desired, 24);

  loop
    begin
      insert into public.profiles (id, username) values (new.id, desired);
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 5 then raise; end if;
      desired := left(desired, 17) || '_' || encode(extensions.gen_random_bytes(3), 'hex');
    end;
  end loop;

  insert into public.profile_private (user_id, first_name, last_name, phone, terms_accepted_at)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'first_name', ''), 80), ''),
    nullif(left(coalesce(new.raw_user_meta_data ->> 'last_name', ''), 80), ''),
    nullif(left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 32), ''),
    case when (new.raw_user_meta_data ->> 'terms_accepted') = 'true' then now() end
  )
  on conflict (user_id) do nothing;

  insert into public.user_consents (user_id, marketing_opt_in, source)
  values (new.id, coalesce((new.raw_user_meta_data ->> 'marketing_opt_in')::boolean, false), 'signup')
  on conflict (user_id) do nothing;

  return new;
end;
$$;
