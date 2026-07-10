import { supabase } from '@/lib/supabase';
import type { AppRole, Bathroom, Profile, Review } from '@/types/db';

/**
 * All of these are thin wrappers over SECURITY DEFINER RPCs. The RPC re-checks
 * the caller's role in the database and writes an audit row in the same
 * transaction, so the React layer here is only ergonomics — it enforces nothing.
 */

export async function softDeleteReview(reviewId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('moderate_soft_delete_review', {
    p_review_id: reviewId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function restoreReview(reviewId: string): Promise<void> {
  const { error } = await supabase.rpc('moderate_restore_review', {
    p_review_id: reviewId,
  });
  if (error) throw error;
}

export async function softDeleteBathroom(bathroomId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('moderate_soft_delete_bathroom', {
    p_bathroom_id: bathroomId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function restoreBathroom(bathroomId: string): Promise<void> {
  const { error } = await supabase.rpc('moderate_restore_bathroom', {
    p_bathroom_id: bathroomId,
  });
  if (error) throw error;
}

/** Resolve a report. `dismiss` = no action needed; otherwise mark it handled. */
export async function resolveReport(reportId: string, dismiss: boolean): Promise<void> {
  const { error } = await supabase.rpc('moderate_resolve_report', {
    p_report_id: reportId,
    p_dismiss: dismiss,
  });
  if (error) throw error;
}

/** The roles a given user holds. Admin-only in practice (RLS gates the read). */
export async function getUserRoles(userId: string): Promise<AppRole[]> {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId);
  if (error) throw error;
  return ((data ?? []) as { role: AppRole }[]).map((r) => r.role);
}

export async function grantRole(userId: string, role: AppRole): Promise<void> {
  const { error } = await supabase.rpc('admin_grant_role', {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}

export async function revokeRole(userId: string, role: AppRole): Promise<void> {
  const { error } = await supabase.rpc('admin_revoke_role', {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}

// --- Admin listings (moderators see removed rows too, via RLS) --------------

export interface ModeratedReview extends Review {
  author: Pick<Profile, 'username'> | null;
  bathroom: Pick<Bathroom, 'id' | 'name'> | null;
}

export async function listReviewsForModeration(limit = 100): Promise<ModeratedReview[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*, author:profiles(username), bathroom:bathrooms(id, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ModeratedReview[];
}

const BATHROOM_COLUMNS =
  'id,name,address,lat,lng,description,wheelchair_accessible,gender_neutral,changing_table,requires_key,created_by,created_at,deleted_at,deleted_by';

export async function listBathroomsForModeration(limit = 100): Promise<Bathroom[]> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select(BATHROOM_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as Bathroom[];
}
