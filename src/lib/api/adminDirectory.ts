import { supabase } from '@/lib/supabase';

/**
 * Admin directories (migration 20260713030000): live user search and the org
 * roster. Both are is_admin-gated SECURITY DEFINER RPCs because normal RLS
 * deliberately hides other people's roles and business memberships.
 */

export interface DirectoryUser {
  user_id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
  roles: string[];
  businesses: { id: string; name: string; role: string }[];
  review_count: number;
  removed_reviews: number;
}

export type UserRoleFilter = 'admin' | 'moderator' | 'business' | 'none';

export async function searchUsers(opts: {
  search?: string;
  role?: UserRoleFilter;
  businessId?: string;
  limit?: number;
  offset?: number;
}): Promise<DirectoryUser[]> {
  const { data, error } = await supabase.rpc('admin_list_users', {
    p_search: opts.search ?? null,
    p_role: opts.role ?? null,
    p_business_id: opts.businessId ?? null,
    p_limit: opts.limit ?? 50,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw error;
  return (data ?? []) as DirectoryUser[];
}

export interface DirectoryOrg {
  id: string;
  name: string;
  slug: string | null;
  website: string | null;
  logo_url: string | null;
  created_at: string;
  suspended_at: string | null;
  owner_username: string | null;
  subscription_status: string | null;
  subscription_plan: string | null;
  member_count: number;
  verified_claims: number;
  pending_claims: number;
  campaign_count: number;
  open_reports: number;
}

export async function listOrgs(search?: string): Promise<DirectoryOrg[]> {
  const { data, error } = await supabase.rpc('admin_list_businesses', {
    p_search: search ?? null,
  });
  if (error) throw error;
  return (data ?? []) as DirectoryOrg[];
}

/** Mass role grant/revoke. The caller's own admin role is never bulk-revoked. */
export async function bulkSetRole(
  userIds: string[],
  role: 'moderator' | 'admin',
  grant: boolean,
): Promise<number> {
  const { data, error } = await supabase.rpc('admin_bulk_set_role', {
    p_user_ids: userIds,
    p_role: role,
    p_grant: grant,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Admin: create an org outright (owner optional — assign later by username). */
export async function createOrg(opts: {
  name: string;
  website?: string;
  ownerId?: string;
  plan?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('admin_create_business', {
    p_name: opts.name,
    p_website: opts.website ?? null,
    p_owner_id: opts.ownerId ?? null,
    p_plan: opts.plan ?? 'solo',
  });
  if (error) throw error;
  return data as string;
}

/** Admin: permanently delete an org (cascades members, claims, campaigns…). */
export async function deleteOrg(businessId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('admin_delete_business', {
    p_business_id: businessId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

/** Admin: set a user's org role ('owner'|'manager'|'staff') or null to remove. */
export async function setOrgMember(
  businessId: string,
  userId: string,
  role: 'owner' | 'manager' | 'staff' | null,
): Promise<void> {
  const { error } = await supabase.rpc('admin_set_org_member', {
    p_business_id: businessId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}
