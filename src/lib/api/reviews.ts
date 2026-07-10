import { supabase } from '@/lib/supabase';
import type { NewReview, Review, ReviewWithAuthor } from '@/types/db';

/**
 * Embeds the author profile (many reviews → one profile) as an OBJECT and the
 * photos (one review → many photos) as an ARRAY in a single round-trip, matching
 * `ReviewWithAuthor`.
 */
export async function listReviewsForBathroom(
  bathroomId: string,
): Promise<ReviewWithAuthor[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select(
      '*, author:profiles(id, username, avatar_url), photos:review_photos(*)',
    )
    .eq('bathroom_id', bathroomId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ReviewWithAuthor[];
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

export async function deleteReview(reviewId: string): Promise<void> {
  const { error } = await supabase.from('reviews').delete().eq('id', reviewId);
  if (error) throw error;
}
