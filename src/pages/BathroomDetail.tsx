import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { BathroomWithStats, ReviewWithAuthor } from '@/types/db';
import { getBathroom } from '@/lib/api/bathrooms';
import { deleteReview, listReviewsForBathroom } from '@/lib/api/reviews';
import { useAuth } from '@/auth/AuthProvider';
import { Stars } from '@/components/ui/Stars';
import { Button } from '@/components/ui/Button';
import { AmenityBadges } from '@/components/bathroom/AmenityBadges';
import { AttributeBadges } from '@/components/bathroom/AttributeBadges';
import { AttributeEditor } from '@/components/bathroom/AttributeEditor';
import { ReviewForm } from '@/components/review/ReviewForm';
import { ReviewList } from '@/components/review/ReviewList';
import { ReportButton } from '@/components/moderation/ReportButton';
import { VerifiedBadge } from '@/components/business/VerifiedBadge';
import { ClaimButton } from '@/components/business/ClaimButton';

type Status = 'loading' | 'ready' | 'notfound' | 'error';

function SubScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-app bg-raised p-3">
      <span className="text-xs font-medium text-muted">{label}</span>
      {value == null ? (
        <span className="text-sm text-muted">Not yet rated</span>
      ) : (
        <div className="flex items-center gap-2">
          <Stars value={value} size={14} />
          <span className="text-sm font-medium text-app">{value.toFixed(1)}</span>
        </div>
      )}
    </div>
  );
}

export function BathroomDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<Status>('loading');
  const [bathroom, setBathroom] = useState<BathroomWithStats | null>(null);
  const [reviews, setReviews] = useState<ReviewWithAuthor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setStatus('notfound');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const found = await getBathroom(id);
      if (!found) {
        setStatus('notfound');
        return;
      }
      const list = await listReviewsForBathroom(id);
      setBathroom(found);
      setReviews(list);
      setStatus('ready');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Reload this page AND drop the cached bathroom lists. Writing a review moves
   * the averages that Home and the map render from `bathroom_stats`; without the
   * invalidation those views keep serving pre-review numbers until the query
   * goes stale on its own.
   */
  const refresh = useCallback(async () => {
    await load();
    await queryClient.invalidateQueries({ queryKey: ['bathrooms'] });
  }, [load, queryClient]);

  async function handleDelete(review: ReviewWithAuthor) {
    setDeletingId(review.id);
    try {
      await deleteReview(review.id);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the review.');
    } finally {
      setDeletingId(null);
    }
  }

  if (status === 'loading') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="h-40 animate-pulse rounded-xl border border-app bg-raised" />
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 py-20 text-center">
        <p className="text-lg font-semibold text-app">Bathroom not found</p>
        <p className="max-w-md text-sm text-muted">
          This bathroom may have been removed, or the link is wrong.
        </p>
        <Link to="/browse">
          <Button variant="secondary">Back to all bathrooms</Button>
        </Link>
      </div>
    );
  }

  if (status === 'error' || !bathroom) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 py-20 text-center">
        <p className="text-lg font-semibold text-app">Couldn’t load this bathroom</p>
        <p className="max-w-md text-sm text-muted">{error}</p>
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  const { stats } = bathroom;
  const rated = stats.review_count > 0 && stats.avg_rating != null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold text-app">{bathroom.name}</h1>
          <p className="mt-1 text-sm text-muted">{bathroom.address}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Stars value={stats.avg_rating ?? 0} size={20} />
          {rated ? (
            <span className="text-sm text-app">
              <span className="font-semibold">
                {(stats.avg_rating as number).toFixed(1)}
              </span>{' '}
              <span className="text-muted">
                · {stats.review_count} review{stats.review_count === 1 ? '' : 's'}
              </span>
            </span>
          ) : (
            <span className="text-sm text-muted">No reviews yet</span>
          )}
        </div>

        {bathroom.description && (
          <p className="whitespace-pre-line text-sm text-app">{bathroom.description}</p>
        )}

        <VerifiedBadge bathroomId={bathroom.id} />

        <AmenityBadges amenities={bathroom} />
        <AttributeBadges bathroomId={bathroom.id} />
        <AttributeEditor bathroomId={bathroom.id} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <ReportButton target={{ bathroom_id: bathroom.id }} />
          <ClaimButton bathroomId={bathroom.id} />
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-app">Ratings breakdown</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SubScoreBar label="Cleanliness" value={stats.avg_cleanliness} />
          <SubScoreBar label="Privacy" value={stats.avg_privacy} />
          <SubScoreBar label="Accessibility" value={stats.avg_accessibility} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-app">
          Reviews{stats.review_count > 0 ? ` (${stats.review_count})` : ''}
        </h2>

        {user ? (
          <ReviewForm bathroomId={bathroom.id} userId={user.id} onSaved={() => void refresh()} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app bg-raised p-4">
            <p className="text-sm text-app">Been here? Share your experience.</p>
            <Link to="/signin">
              <Button variant="primary" size="sm">
                Sign in to review
              </Button>
            </Link>
          </div>
        )}

        <ReviewList
          reviews={reviews}
          currentUserId={user?.id ?? null}
          onDelete={handleDelete}
          deletingId={deletingId}
        />
      </section>
    </div>
  );
}
