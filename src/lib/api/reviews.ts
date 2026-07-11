import { supabase } from '@/lib/supabase';
import { STORAGE_BUCKET } from '@/types/db';
import type { NewReview, Review, ReviewerStats, ReviewWithAuthor } from '@/types/db';

/**
 * `reviewer_stats` is a VIEW with no foreign key PostgREST can embed through
 * (same story as `bathroom_stats`), so the authors' live review counts — which
 * drive the rank badge on each card — arrive in a second query, merged in JS.
 */
async function attachAuthorCounts(
  rows: ReviewWithAuthor[],
): Promise<ReviewWithAuthor[]> {
  if (rows.length === 0) return rows;
  const authorIds = [...new Set(rows.map((r) => r.author.id))];
  const { data, error } = await supabase
    .from('reviewer_stats')
    .select('*')
    .in('profile_id', authorIds);
  if (error) throw error;

  const counts = new Map(
    ((data ?? []) as ReviewerStats[]).map((s) => [s.profile_id, s.review_count]),
  );
  // The view emits a row per profile, so a miss shouldn't happen — but an
  // author visible here has at least the review we're rendering.
  return rows.map((r) => ({
    ...r,
    author: { ...r.author, review_count: counts.get(r.author.id) ?? 1 },
  }));
}

/**
 * Embeds the author profile (many reviews → one profile) as an OBJECT and the
 * photos (one review → many photos) as an ARRAY in a single round-trip, matching
 * `ReviewWithAuthor`.
 *
 * The `!reviews_author_id_fkey` hint is required: `reviews` has TWO foreign keys
 * to `profiles` (`author_id` and moderation's `deleted_by`), so a bare
 * `profiles(...)` embed is ambiguous and PostgREST rejects it with PGRST201.
 */
export async function listReviewsForBathroom(
  bathroomId: string,
): Promise<ReviewWithAuthor[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select(
      '*, author:profiles!reviews_author_id_fkey(id, username, avatar_url), photos:review_photos(*)',
    )
    .eq('bathroom_id', bathroomId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachAuthorCounts((data ?? []) as unknown as ReviewWithAuthor[]);
}

export async function getMyReview(
  bathroomId: string,
  userId: string,
): Promise<Review | null> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('bathroom_id', bathroomId)
    .eq('author_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Review | null) ?? null;
}

export async function upsertReview(
  input: NewReview,
  userId: string,
): Promise<Review> {
  // `author_id` must equal the caller's uid (RLS), and we upsert on the
  // (bathroom_id, author_id) unique constraint so editing updates in place.
  const { data, error } = await supabase
    .from('reviews')
    .upsert(
      { ...input, author_id: userId },
      { onConflict: 'bathroom_id,author_id' },
    )
    .select('*')
    .single();
  if (error) throw error;
  return data as Review;
}

/**
 * Delete a review and the storage objects behind its photos.
 *
 * `review_photos` rows cascade when the review goes, but the objects in the
 * bucket do not — the database knows nothing about storage. Deleting the review
 * first would therefore strand those bytes with no row left pointing at them:
 * invisible, permanent, and counted against the storage quota.
 *
 * So remove the objects first. If that fails we abort with the review intact,
 * and the user can retry. The opposite order has no recovery path.
 *
 * (Storage RLS confines deletes to the caller's own `<uid>/` prefix, which the
 * review's author always owns. A moderator deleting someone else's review would
 * fail here — that path doesn't exist yet; see docs/ops/USERS_AND_ROLES.md.)
 */
export async function deleteReview(reviewId: string): Promise<void> {
  const { data: photos, error: photosError } = await supabase
    .from('review_photos')
    .select('storage_path')
    .eq('review_id', reviewId);
  if (photosError) throw photosError;

  const paths = (photos ?? []).map((p) => p.storage_path);
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(paths);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.from('reviews').delete().eq('id', reviewId);
  if (error) throw error;
}
