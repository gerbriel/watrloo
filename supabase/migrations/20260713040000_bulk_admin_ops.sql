-- Watrloo: bulk admin operations — multi-select mass CRUD in the control room.
-- One round trip per batch; every affected item still gets its own audit row,
-- so bulk actions are exactly as accountable as single ones.

-- Soft-remove many bathrooms with one shared reason (moderator power).
create or replace function public.admin_bulk_soft_delete_bathrooms(p_ids uuid[], p_reason text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count int := 0;
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    update public.bathrooms set deleted_at = now(), deleted_by = (select auth.uid())
     where id = v_id and deleted_at is null;
    if found then
      insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
      values ((select auth.uid()), 'soft_delete_bathroom', 'bathroom', v_id,
              jsonb_build_object('reason', p_reason, 'bulk', true));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_bulk_soft_delete_bathrooms(uuid[], text) to authenticated;

create or replace function public.admin_bulk_restore_bathrooms(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count int := 0;
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    update public.bathrooms set deleted_at = null, deleted_by = null
     where id = v_id and deleted_at is not null;
    if found then
      insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
      values ((select auth.uid()), 'restore_bathroom', 'bathroom', v_id,
              jsonb_build_object('bulk', true));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_bulk_restore_bathrooms(uuid[]) to authenticated;

-- Add or remove ONE attribute (category/amenity/caution) across many bathrooms
-- — the "select ten gas stations, tag them Gas station" move.
create or replace function public.admin_bulk_set_attribute(p_ids uuid[], p_slug text, p_add boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count int := 0;
begin
  if not public.is_moderator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (select 1 from public.attribute_defs d where d.slug = p_slug and d.active) then
    raise exception 'unknown or inactive attribute' using errcode = '22023';
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    if p_add then
      insert into public.bathroom_attributes (bathroom_id, attribute_slug)
      values (v_id, p_slug) on conflict do nothing;
      if found then v_count := v_count + 1; end if;
    else
      delete from public.bathroom_attributes
       where bathroom_id = v_id and attribute_slug = p_slug;
      if found then v_count := v_count + 1; end if;
    end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values ((select auth.uid()), 'update_bathroom', 'bathroom', v_id,
            jsonb_build_object('attribute', p_slug, 'added', p_add, 'bulk', true));
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_bulk_set_attribute(uuid[], text, boolean) to authenticated;

-- Mass role grant/revoke (admin power). The caller's own admin role is
-- silently skipped on revoke — a bulk action must never lock out its author.
create or replace function public.admin_bulk_set_role(p_user_ids uuid[], p_role public.app_role, p_grant boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  foreach v_id in array coalesce(p_user_ids, '{}') loop
    if not p_grant and p_role = 'admin' and v_id = (select auth.uid()) then
      continue; -- self-lockout guard
    end if;
    if p_grant then
      insert into public.user_roles (user_id, role, granted_by)
      values (v_id, p_role, (select auth.uid()))
      on conflict (user_id, role) do nothing;
      if not found then continue; end if;
    else
      delete from public.user_roles where user_id = v_id and role = p_role;
      if not found then continue; end if;
    end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, detail)
    values ((select auth.uid()),
            case when p_grant then 'grant_role' else 'revoke_role' end,
            'profile', v_id, jsonb_build_object('role', p_role, 'bulk', true));
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;
grant execute on function public.admin_bulk_set_role(uuid[], public.app_role, boolean) to authenticated;
