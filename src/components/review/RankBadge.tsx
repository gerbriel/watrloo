import { campaigns, rankFor } from '@/lib/ranks';
import { cn } from '@/lib/cn';

/**
 * The reviewer's rank in the Grande Armée du Trône, worn next to their name
 * like a service medal. Hover reveals the campaign count and the rank's motto.
 * Recruits (zero live reviews) get nothing — the badge is earned, and a rank
 * next to a review implies at least one campaign anyway.
 */
export function RankBadge({
  reviewCount,
  className,
}: {
  reviewCount: number;
  className?: string;
}) {
  const rank = rankFor(reviewCount);
  if (rank.min === 0) return null;

  return (
    <span
      title={`${campaigns(reviewCount)} — ${rank.motto}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        rank.tier === 'gold'
          ? 'bg-star/15 text-star'
          : 'bg-flush-600/10 text-flush-600',
        className,
      )}
    >
      {rank.tier === 'gold' && <span aria-hidden="true">⚜</span>}
      {rank.title}
    </span>
  );
}
