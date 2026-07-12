import { supabase } from '@/lib/supabase';
import { STORAGE_BUCKET } from '@/types/db';
import type { AppRole, Bathroom, Profile, Review, ReviewPhoto } from '@/types/db';

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

/**
 * Permanently remove one photo from someone else's review (explicit content).
 * Not a soft delete — the point is to destroy the bytes, so there is no
 * restore. Objects first (a moderator storage policy reaches any folder in the
 * bucket), then the RPC drops the row and writes the audit record. A retry
 * re-runs both halves safely: removing a missing object is a no-op and the
 * RPC skips the audit row when the photo is already gone.
 */
export async function moderatorDeleteReviewPhoto(
  photo: Pick<ReviewPhoto, 'id' | 'storage_path'>,
  reason?: string,
): Promise<void> {
  const { error: storageError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .remove([photo.storage_path]);
  if (storageError) throw storageError;

  const { error } = await supabase.rpc('moderate_delete_review_photo', {
    p_photo_id: photo.id,
    p_reason: reason ?? null,
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
  photos: ReviewPhoto[];
}

export async function listReviewsForModeration(limit = 100): Promise<ModeratedReview[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select(
      '*, author:profiles!reviews_author_id_fkey(username), bathroom:bathrooms(id, name), photos:review_photos(*)',
    )
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

// --- Bulk operations (multi-select mass CRUD; each item audited) -------------

export async function bulkSoftDeleteBathrooms(ids: string[], reason?: string): Promise<number> {
  const { data, error } = await supabase.rpc('admin_bulk_soft_delete_bathrooms', {
    p_ids: ids,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function bulkRestoreBathrooms(ids: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('admin_bulk_restore_bathrooms', { p_ids: ids });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Add or remove one attribute (category/amenity/caution) across many bathrooms. */
export async function bulkSetAttribute(
  ids: string[],
  slug: string,
  add: boolean,
): Promise<number> {
  const { data, error } = await supabase.rpc('admin_bulk_set_attribute', {
    p_ids: ids,
    p_slug: slug,
    p_add: add,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

// --- Moderator assignments ----------------------------------------------------

export interface AssignedBathroom {
  bathroom_id: string;
  name: string;
  address: string;
  deleted_at: string | null;
  assigned_at: string;
  review_count: number;
  removed_reviews: number;
  open_reports: number;
}

/** The signed-in moderator's worklist, hottest (most open reports) first. */
export async function myAssignedBathrooms(): Promise<AssignedBathroom[]> {
  const { data, error } = await supabase.rpc('my_assigned_bathrooms');
  if (error) throw error;
  return (data ?? []) as AssignedBathroom[];
}

/** Admin: assign or unassign a batch of bathrooms to one moderator. */
export async function assignBathrooms(
  moderatorId: string,
  bathroomIds: string[],
  add: boolean,
): Promise<number> {
  const { data, error } = await supabase.rpc('admin_assign_bathrooms', {
    p_moderator_id: moderatorId,
    p_bathroom_ids: bathroomIds,
    p_add: add,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}
