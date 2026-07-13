import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listLeaderboard } from '@/lib/api/profiles';
import { useAuth } from '@/auth/AuthProvider';
import { campaigns, rankFor, RANKS_TAGLINE } from '@/lib/ranks';
import { RankBadge } from '@/components/review/RankBadge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * The Hall of Marshals: public reviewer standings, ranked by campaigns
 * (live reviews). Reads the `leaderboard` view — public usernames and counts
 * only, nothing an anonymous visitor couldn't already tally from review cards.
 */
export function Leaderboard() {
  const { user } = useAuth();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => listLeaderboard(25),
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          The Grande Armée du Trône
        </p>
        <h1 className="font-display text-2xl font-bold text-app">
          Hall of Marshals
        </h1>
        <p className="mt-1 text-sm text-muted">
          The bravest soldiers of the porcelain front, ranked by campaigns
          served. {RANKS_TAGLINE}
        </p>
      </header>

      {isPending && (
        <div className="h-64 animate-pulse rounded-xl border border-app bg-raised" />
      )}

      {isError && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-red-500">Couldn’t load the leaderboard.</p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-xl border border-dashed border-app bg-raised px-6 py-10 text-center">
          <p className="font-medium text-app">No campaigns on record yet</p>
          <p className="mt-1 text-sm text-muted">
            The first review posted takes the top of this board.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <ol className="overflow-hidden rounded-xl border border-app bg-raised">
          {data.map((entry, i) => {
            const isMe = user?.id === entry.profile_id;
            const podium = i < 3;
            return (
              <li
                key={entry.profile_id}
                className={cn(
                  'flex items-center gap-3 border-b border-app px-4 py-3 last:border-b-0',
                  isMe && 'bg-flush-600/5',
                )}
              >
                <span
                  className={cn(
                    'w-8 shrink-0 text-center font-display text-sm font-bold',
                    podium ? 'text-star' : 'text-muted',
                  )}
                  aria-label={`Position ${i + 1}`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/u/${encodeURIComponent(entry.username)}`}
                      className="truncate font-medium text-app hover:underline"
                    >
                      @{entry.username}
                    </Link>
                    <RankBadge reviewCount={entry.review_count} />
                    {isMe && (
                      <span className="rounded-full bg-flush-600/10 px-2 py-0.5 text-xs font-medium text-flush-600">
                        You
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {campaigns(entry.review_count)} ·{' '}
                    {rankFor(entry.review_count).motto}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <Link
        to="/battalions"
        className="flex items-center justify-between gap-3 rounded-xl border border-app bg-raised px-4 py-3 hover:bg-sunken"
      >
        <div>
          <p className="font-display font-bold text-app">⚔️ Squads</p>
          <p className="text-xs text-muted">
            Solo glory too lonely? Muster a Squad and climb from six soldiers
            to a Field Army — team standings pool every member's campaigns.
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted">March →</span>
      </Link>

      <p className="text-xs text-muted">
        Want on the board?{' '}
        <Link to="/explore" className="font-medium text-flush-600 hover:underline">
          Find a bathroom and file your report
        </Link>
        . Removed reviews don’t count — the Armée has standards.
      </p>
    </div>
  );
}
