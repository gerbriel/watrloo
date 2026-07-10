import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  listReviewsForModeration,
  restoreReview,
  softDeleteReview,
} from '@/lib/api/moderation';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function AdminReviews() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminReviews(),
    queryFn: () => listReviewsForModeration(100),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminReviews() });
    // Averages and lists elsewhere depend on which reviews are live.
    void qc.invalidateQueries({ queryKey: ['bathrooms'] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => softDeleteReview(id),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreReview(id),
    onSuccess: invalidate,
  });

  if (isPending) return <p className="text-sm text-muted">Loading reviews…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load reviews.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {data.map((r) => {
        const removed = r.deleted_at != null;
        const busy =
          (remove.isPending && remove.variables === r.id) ||
          (restore.isPending && restore.variables === r.id);
        return (
          <li
            key={r.id}
            className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-app">
                <span className="font-medium">@{r.author?.username ?? 'unknown'}</span>{' '}
                <span className="text-muted">· {r.rating}/5 · {fmt(r.created_at)}</span>
              </p>
              {removed && (
                <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
                  Removed
                </span>
              )}
            </div>

            {r.bathroom && (
              <Link
                to={`/bathrooms/${r.bathroom.id}`}
                className="text-xs font-medium text-flush-600 hover:underline"
              >
                {r.bathroom.name} →
              </Link>
            )}

            {r.body && (
              <p className="line-clamp-3 whitespace-pre-line text-sm text-app">{r.body}</p>
            )}

            <div className="flex justify-end">
              {removed ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={restore.isPending && restore.variables === r.id}
                  disabled={busy}
                  onClick={() => restore.mutate(r.id)}
                >
                  Restore
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 hover:bg-red-500/10"
                  loading={remove.isPending && remove.variables === r.id}
                  disabled={busy}
                  onClick={() => remove.mutate(r.id)}
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
