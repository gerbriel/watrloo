import { supabase } from '@/lib/supabase';
import { STORAGE_BUCKET } from '@/types/db';
import type { Profile, ReviewerStats } from '@/types/db';

export async function getProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

/**
 * A profile's live review count, which is its rank in the Grande Armée du
 * Trône (src/lib/ranks.ts). `maybeSingle` because a brand-new profile can race
 * the view; zero campaigns is the honest answer either way.
 */
export async function getReviewerStats(profileId: string): Promise<ReviewerStats> {
  const { data, error } = await supabase
    .from('reviewer_stats')
    .select('*')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return (
    (data as ReviewerStats | null) ?? { profile_id: profileId, review_count: 0 }
  );
}

/** One row of the public leaderboard, from the `leaderboard` view. */
export interface LeaderboardEntry {
  profile_id: string;
  username: string;
  avatar_url: string | null;
  review_count: number;
}

/** Top reviewers by live review count — the Hall of Marshals. */
export async function listLeaderboard(limit = 25): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('*')
    .order('review_count', { ascending: false })
    .order('username', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LeaderboardEntry[];
}

/** Look up a profile by exact username. Used by the admin role-granting form. */
export async function getProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, 'username' | 'avatar_url'>>,
): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Profile;
}

/**
 * Permanently delete the signed-in user's account.
 *
 * Order matters. The `delete_my_account` RPC removes the auth user, which
 * cascades to the profile, the user's reviews, their `review_photos` rows, and
 * their roles — but the storage service owns the photo *bytes*, and SQL can't
 * touch them. So we delete the files from the user's own `<uid>/` prefix first
 * (storage RLS permits it), then delete the account. Bathrooms the user added
 * are kept but un-owned (`created_by` becomes null), so the directory survives.
 */
export async function deleteMyAccount(userId: string): Promise<void> {
  const { data: files, error: listError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(userId, { limit: 1000 });
  // A listing failure shouldn't strand the whole deletion — the worst case is
  // an orphaned file, not a blocked account removal. Only hard-fail the account
  // step below.
  if (!listError && files && files.length > 0) {
    await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(files.map((f) => `${userId}/${f.name}`));
  }

  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw error;
}
