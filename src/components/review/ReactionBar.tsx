import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import {
  REACTION_EMOJI,
  reactionsForReviews,
  toggleReaction,
} from '@/lib/api/social';
import type { ReactionEmoji } from '@/lib/api/social';
import { cn } from '@/lib/cn';

/**
 * Emoji reactions under a review. Everyone sees the tallies; signed-in users
 * toggle their own. The vocabulary is fixed by a database CHECK, so there's
 * no free-text surface here.
 */
export function ReactionBar({ reviewId }: { reviewId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['reactions', reviewId, user?.id ?? 'anon'],
    queryFn: async () =>
      (await reactionsForReviews([reviewId], user?.id)).get(reviewId) ?? {
        review_id: reviewId,
        counts: {},
        mine: [],
      },
    staleTime: 30_000,
  });

  const toggle = useMutation({
    mutationFn: ({ emoji, on }: { emoji: ReactionEmoji; on: boolean }) =>
      toggleReaction(reviewId, user!.id, emoji, on),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reactions', reviewId] });
    },
  });

  const counts = data?.counts ?? {};
  const mine = data?.mine ?? [];

  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Reactions">
      {REACTION_EMOJI.map((emoji) => {
        const count = counts[emoji] ?? 0;
        const reacted = mine.includes(emoji);
        // Signed-out visitors only see emoji that have tallies.
        if (!user && count === 0) return null;
        return (
          <button
            key={emoji}
            type="button"
            disabled={!user || toggle.isPending}
            title={user ? undefined : 'Sign in to react'}
            aria-pressed={reacted}
            onClick={() => toggle.mutate({ emoji, on: !reacted })}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors',
              reacted
                ? 'border-flush-500/50 bg-flush-500/10'
                : 'border-app bg-surface hover:bg-sunken',
              !user && 'cursor-default opacity-70',
            )}
          >
            <span aria-hidden="true">{emoji}</span>
            {count > 0 && (
              <span className={cn('text-xs', reacted ? 'text-flush-600 font-medium' : 'text-muted')}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
