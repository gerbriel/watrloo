import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ReviewPhoto } from '@/types/db';
import {
  listReviewsForModeration,
  moderatorDeleteReviewPhoto,
  restoreReview,
  softDeleteReview,
} from '@/lib/api/moderation';
import { publicPhotoUrl } from '@/lib/api/photos';
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
  // Destroys the bytes; there is no restore. Hence the confirm below.
  const removePhoto = useMutation({
    mutationFn: (photo: ReviewPhoto) => moderatorDeleteReviewPhoto(photo),
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

            {r.photos.length > 0 && (
              <ul className="flex flex-wrap gap-2 pt-1">
                {r.photos.map((photo) => {
                  const deletingPhoto =
                    removePhoto.isPending && removePhoto.variables?.id === photo.id;
                  return (
                    <li key={photo.id} className="relative">
                      <a
                        href={publicPhotoUrl(photo.storage_path)}
                        target="_blank"
                        rel="noreferrer"
                        className="block size-20 overflow-hidden rounded-lg border border-app"
                      >
                        <img
                          src={publicPhotoUrl(photo.storage_path)}
                          alt={`Photo on @${r.author?.username ?? 'unknown'}’s review`}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      </a>
                      <button
                        type="button"
                        aria-label="Permanently delete this photo"
                        title="Permanently delete this photo"
                        disabled={removePhoto.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Permanently delete this photo? The image file is destroyed — this cannot be undone.',
                            )
                          ) {
                            removePhoto.mutate(photo);
                          }
                        }}
                        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white shadow hover:bg-red-600 disabled:opacity-50"
                      >
                        {deletingPhoto ? '…' : '×'}
                      </button>
                    </li>
                  );
                })}
              </ul>
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
