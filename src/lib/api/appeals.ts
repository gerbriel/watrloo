import { supabase } from '@/lib/supabase';
import { sanitizeText } from '@/lib/sanitize';
import { STORAGE_BUCKET } from '@/types/db';

/**
 * Appeals: the other half of moderation (migration 20260713020000). Owners see
 * WHY their content was removed and can appeal once per item; admins grant
 * (content restored in the same transaction) or deny with a note.
 */

export interface RemovedItemAppeal {
  status: 'open' | 'granted' | 'denied';
  decision_note: string | null;
  created_at: string;
}

export interface MyRemovedReview {
  id: string;
  body: string | null;
  rating: number;
  bathroom_id: string;
  bathroom_name: string;
  deleted_at: string;
  removal_reason: string | null;
  appeal: RemovedItemAppeal | null;
}

export interface MyRemovedBathroom {
  id: string;
  name: string;
  address: string;
  deleted_at: string;
  removal_reason: string | null;
  appeal: RemovedItemAppeal | null;
}

export interface MyRemovedContent {
  reviews: MyRemovedReview[];
  bathrooms: MyRemovedBathroom[];
}

export async function myRemovedContent(): Promise<MyRemovedContent> {
  const { data, error } = await supabase.rpc('my_removed_content');
  if (error) throw error;
  return data as MyRemovedContent;
}

export async function fileAppeal(
  target: { review_id: string } | { bathroom_id: string },
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('file_appeal', {
    p_review_id: 'review_id' in target ? target.review_id : null,
    p_bathroom_id: 'bathroom_id' in target ? target.bathroom_id : null,
    p_reason: sanitizeText(reason, 2000),
  });
  if (error) throw error;
}

// --- Admin side ---------------------------------------------------------------

export interface AppealRow {
  id: string;
  appellant_id: string;
  review_id: string | null;
  bathroom_id: string | null;
  reason: string;
  status: 'open' | 'granted' | 'denied';
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  appellant: { username: string } | null;
  review: { id: string; body: string | null; rating: number; bathroom_id: string } | null;
  bathroom: { id: string; name: string; address: string } | null;
}

export async function listAppeals(
  status: 'open' | 'granted' | 'denied' = 'open',
): Promise<AppealRow[]> {
  const { data, error } = await supabase
    .from('appeals')
    .select(
      `*,
       appellant:profiles!appeals_appellant_id_fkey(username),
       review:reviews(id, body, rating, bathroom_id),
       bathroom:bathrooms(id, name, address)`,
    )
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as AppealRow[];
}

export async function decideAppeal(
  appealId: string,
  grant: boolean,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_decide_appeal', {
    p_appeal_id: appealId,
    p_grant: grant,
    p_note: note ? sanitizeText(note, 2000) : null,
  });
  if (error) throw error;
}

/**
 * Permanent bathroom deletion (admin). Storage bytes FIRST, rows second —
 * the reverse order strands photo files at public URLs forever. Cascades take
 * the bathroom's reviews, photo rows, claims, placements, and any campaigns
 * pinned to it; the caller must warn about that before invoking.
 */
export async function hardDeleteBathroom(bathroomId: string, reason?: string): Promise<void> {
  const { data: paths, error: pathsError } = await supabase.rpc(
    'admin_bathroom_photo_paths',
    { p_bathroom_id: bathroomId },
  );
  if (pathsError) throw pathsError;

  const list = (paths ?? []) as string[];
  if (list.length > 0) {
    const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove(list);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.rpc('admin_hard_delete_bathroom', {
    p_bathroom_id: bathroomId,
    p_reason: reason ? sanitizeText(reason, 1000) : null,
  });
  if (error) throw error;
}
