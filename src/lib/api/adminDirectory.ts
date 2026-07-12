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
