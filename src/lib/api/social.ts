import { supabase } from '@/lib/supabase';
import { sanitizeLine } from '@/lib/sanitize';
import type { Profile } from '@/types/db';

/**
 * The social layer (migration 20260714020000): emoji reactions on reviews,
 * follows, public profiles, and battalions — team standings for the Grande
 * Armée du Trône. All reads are public data; all writes are self-scoped RLS
 * or invariant-holding RPCs.
 */

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '💩', '🧻'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export interface ReviewReactionSummary {
  review_id: string;
  /** emoji -> total count */
  counts: Partial<Record<ReactionEmoji, number>>;
  /** emoji the current user has placed (empty when signed out) */
  mine: ReactionEmoji[];
}

/** One round trip for a whole review list. */
export async function reactionsForReviews(
  reviewIds: string[],
  userId?: string | null,
): Promise<Map<string, ReviewReactionSummary>> {
  const map = new Map<string, ReviewReactionSummary>();
  if (reviewIds.length === 0) return map;
  const { data, error } = await supabase
    .from('review_reactions')
    .select('review_id, user_id, emoji')
    .in('review_id', reviewIds);
  if (error) throw error;
  for (const row of (data ?? []) as {
    review_id: string;
    user_id: string;
    emoji: ReactionEmoji;
  }[]) {
    let s = map.get(row.review_id);
    if (!s) {
      s = { review_id: row.review_id, counts: {}, mine: [] };
      map.set(row.review_id, s);
    }
    s.counts[row.emoji] = (s.counts[row.emoji] ?? 0) + 1;
    if (userId && row.user_id === userId) s.mine.push(row.emoji);
  }
  return map;
}

export async function toggleReaction(
  reviewId: string,
  userId: string,
  emoji: ReactionEmoji,
  on: boolean,
): Promise<void> {
  if (on) {
    const { error } = await supabase
      .from('review_reactions')
      .insert({ review_id: reviewId, user_id: userId, emoji });
    if (error && error.code !== '23505') throw error; // already reacted = fine
  } else {
    const { error } = await supabase
      .from('review_reactions')
      .delete()
      .eq('review_id', reviewId)
      .eq('user_id', userId)
      .eq('emoji', emoji);
    if (error) throw error;
  }
}

// --- Follows -----------------------------------------------------------------

export interface FollowStats {
  followers: number;
  following: number;
  /** whether the current viewer follows this profile */
  viewerFollows: boolean;
}

export async function followStats(
  profileId: string,
  viewerId?: string | null,
): Promise<FollowStats> {
  const [followers, following, mine] = await Promise.all([
    supabase
      .from('follows')
      .select('follower_id', { count: 'exact', head: true })
      .eq('followee_id', profileId),
    supabase
      .from('follows')
      .select('followee_id', { count: 'exact', head: true })
      .eq('follower_id', profileId),
    viewerId
      ? supabase
          .from('follows')
          .select('followee_id')
          .eq('follower_id', viewerId)
          .eq('followee_id', profileId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (followers.error) throw followers.error;
  if (following.error) throw following.error;
  return {
    followers: followers.count ?? 0,
    following: following.count ?? 0,
    viewerFollows: mine.data != null,
  };
}

export async function setFollow(
  viewerId: string,
  profileId: string,
  follow: boolean,
): Promise<void> {
  if (follow) {
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: viewerId, followee_id: profileId });
    if (error && error.code !== '23505') throw error;
  } else {
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', viewerId)
      .eq('followee_id', profileId);
    if (error) throw error;
  }
}

// --- Public profiles ------------------------------------------------------------

export async function profileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export interface PublicReview {
  id: string;
  bathroom_id: string;
  rating: number;
  body: string | null;
  created_at: string;
  bathroom: { id: string; name: string } | null;
}

export async function reviewsByAuthor(profileId: string): Promise<PublicReview[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('id, bathroom_id, rating, body, created_at, bathroom:bathrooms(id, name)')
    .eq('author_id', profileId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as PublicReview[];
}

// --- Battalions / the Order of Battle -----------------------------------------------

export type UnitRole = 'commander' | 'officer' | 'member';

export interface BattalionStanding {
  id: string;
  name: string;
  motto: string | null;
  created_at: string;
  echelon: number;
  echelon_name: string;
  member_cap: number;
  member_count: number;
  review_count: number;
}

export async function battalionLeaderboard(): Promise<BattalionStanding[]> {
  const { data, error } = await supabase
    .from('battalion_leaderboard')
    .select('*')
    .order('echelon', { ascending: false })
    .order('review_count', { ascending: false })
    .order('member_count', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as BattalionStanding[];
}

/** The ladder itself (caps + promotion requirements), straight from the DB
 *  so the client can never drift from what the server enforces. */
export interface EchelonRow {
  level: number;
  name: string;
  member_cap: number;
  min_members: number;
  min_campaigns: number;
}

export async function listEchelons(): Promise<EchelonRow[]> {
  const { data, error } = await supabase
    .from('battalion_echelons')
    .select('*')
    .order('level');
  if (error) throw error;
  return (data ?? []) as EchelonRow[];
}

export interface UnitDispatch {
  id: string;
  kind: 'founded' | 'promotion';
  level: number;
  note: string;
  created_at: string;
  battalion: { id: string; name: string } | null;
}

/** Recent unit achievements, army-wide — the "dispatches" feed. */
export async function listDispatches(limit = 15): Promise<UnitDispatch[]> {
  const { data, error } = await supabase
    .from('battalion_achievements')
    .select('id, kind, level, note, created_at, battalion:battalions(id, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as UnitDispatch[];
}

export interface BattalionMembership {
  battalion_id: string;
  role: UnitRole;
  battalion: { id: string; name: string; motto: string | null; echelon: number } | null;
}

export async function myBattalion(userId: string): Promise<BattalionMembership | null> {
  const { data, error } = await supabase
    .from('battalion_members')
    .select('battalion_id, role, battalion:battalions(id, name, motto, echelon)')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as BattalionMembership | null) ?? null;
}

export async function battalionOf(userId: string): Promise<BattalionMembership | null> {
  return myBattalion(userId);
}

export interface BattalionMember {
  user_id: string;
  role: UnitRole;
  joined_at: string;
  profile: { id: string; username: string; avatar_url: string | null } | null;
}

export async function battalionRoster(battalionId: string): Promise<BattalionMember[]> {
  const { data, error } = await supabase
    .from('battalion_members')
    .select('user_id, role, joined_at, profile:profiles(id, username, avatar_url)')
    .eq('battalion_id', battalionId)
    .order('joined_at');
  if (error) throw error;
  return (data ?? []) as unknown as BattalionMember[];
}

export async function createBattalion(name: string, motto?: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_battalion', {
    p_name: sanitizeLine(name, 40),
    p_motto: motto ? sanitizeLine(motto, 120) : null,
  });
  if (error) throw error;
  return data as string;
}

export async function joinBattalion(battalionId: string): Promise<void> {
  const { error } = await supabase.rpc('join_battalion', { p_battalion_id: battalionId });
  if (error) throw error;
}

export async function leaveBattalion(): Promise<void> {
  const { error } = await supabase.rpc('leave_battalion');
  if (error) throw error;
}

/** Commander only: appoint or dismiss an officer (posts grow with echelon). */
export async function setBattalionOfficer(
  userId: string,
  officer: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('set_battalion_officer', {
    p_user_id: userId,
    p_officer: officer,
  });
  if (error) throw error;
}

/** Commander only: hand off command; the old commander becomes an officer. */
export async function transferBattalionCommand(userId: string): Promise<void> {
  const { error } = await supabase.rpc('transfer_battalion_command', {
    p_user_id: userId,
  });
  if (error) throw error;
}
