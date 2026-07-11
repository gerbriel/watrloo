import { useQuery } from '@tanstack/react-query';
import { getReviewerStats } from '@/lib/api/profiles';
import { queryKeys } from '@/lib/queryClient';
import { campaigns, nextRankFor, rankFor, RANKS_TAGLINE } from '@/lib/ranks';

/**
 * The signed-in user's standing in the Grande Armée du Trône: current rank,
 * campaign (review) count, and a progress bar to the next promotion. Lives on
 * the profile page; the numbers come from `reviewer_stats`.
 */
export function ServiceRecord({ profileId }: { profileId: string }) {
  const { data: stats } = useQuery({
    queryKey: queryKeys.reviewerStats(profileId),
    queryFn: () => getReviewerStats(profileId),
  });

  if (!stats) {
    return <div className="h-36 animate-pulse rounded-xl border border-app bg-raised" />;
  }

  const count = stats.review_count;
  const rank = rankFor(count);
  const next = nextRankFor(count);
  // Progress runs from the floor of the held rank to the next threshold.
  const pct = next
    ? Math.round(((count - rank.min) / (next.min - rank.min)) * 100)
    : 100;

  return (
    <section
      aria-label="Service record"
      className="overflow-hidden rounded-xl border border-app bg-raised"
    >
      <div className="flex flex-col gap-1 px-5 pt-5">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          Service record
        </p>
        <p className="font-display text-xl font-bold text-app">
          {rank.tier === 'gold' && <span aria-hidden="true">⚜ </span>}
          {rank.title}
        </p>
        <p className="text-sm text-muted italic">“{rank.motto}”</p>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4">
        {next ? (
          <>
            <div
              role="progressbar"
              aria-valuenow={count}
              aria-valuemin={rank.min}
              aria-valuemax={next.min}
              aria-label={`Progress to ${next.title}`}
              className="h-2 overflow-hidden rounded-full bg-sunken"
            >
              <div
                className="h-full rounded-full bg-flush-500 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-sm text-app">
              <span className="font-medium">{campaigns(count)}</span>{' '}
              <span className="text-muted">
                served — {next.min - count} more to make{' '}
                <span className="font-medium text-app">{next.title}</span>.
              </span>
            </p>
          </>
        ) : (
          <p className="text-sm text-app">
            <span className="font-medium">{campaigns(count)}</span>{' '}
            <span className="text-muted">
              served. The ladder ends here — history will remember you.
            </span>
          </p>
        )}
      </div>

      <p className="border-t border-app bg-sunken px-5 py-3 text-xs text-muted">
        {RANKS_TAGLINE}
      </p>
    </section>
  );
}
