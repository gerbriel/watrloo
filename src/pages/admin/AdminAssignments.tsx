import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { myAssignedBathrooms, softDeleteReview } from '@/lib/api/moderation';
import type { AssignedBathroom } from '@/lib/api/moderation';
import { listReviewsForBathroom } from '@/lib/api/reviews';
import { getReviewResponse, respondToReview } from '@/lib/api/businesses';
import { queryKeys } from '@/lib/queryClient';
import { Stars } from '@/components/ui/Stars';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * The moderator's worklist: bathrooms an admin assigned to them (directly, or
 * through an org whose verified claims cover them), with the reviews and open
 * reports attached. Since scoped moderation (migration 20260714010000) this
 * list IS the moderator's jurisdiction — outside it the database refuses
 * their actions. Always audited.
 */

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * Reply to a review with the org's official voice. Moderators assigned to the
 * claiming org (and admins) are authorized server-side by
 * `business_respond_to_review`; if the bathroom has no verified claim, the
 * database refuses and we surface that plainly. One response per review —
 * posting again edits it.
 */
function OrgResponseComposer({ reviewId }: { reviewId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');

  const existing = useQuery({
    queryKey: queryKeys.reviewResponse(reviewId),
    queryFn: () => getReviewResponse(reviewId),
    enabled: open,
  });

  const post = useMutation({
    mutationFn: () => respondToReview(reviewId, body),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: queryKeys.reviewResponse(reviewId) });
    },
  });

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
          setBody('');
        }}
      >
        Respond as the business
      </Button>
    );
  }

  const current = existing.data?.body ?? '';
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-app bg-sunken p-3"
      onSubmit={(e) => {
        e.preventDefault();
        post.mutate();
      }}
    >
      {current && !body && (
        <p className="text-xs text-muted">
          There's already an official response — posting replaces it:{' '}
          <span className="italic">“{current}”</span>
        </p>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        rows={3}
        maxLength={2000}
        placeholder="Speak with the org's voice — this shows publicly under the review."
        className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
      />
      {post.isError && (
        <p className="text-xs text-red-500">
          {post.error instanceof Error
            ? post.error.message
            : 'Could not post the response.'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" loading={post.isPending}>
          {current ? 'Replace response' : 'Post response'}
        </Button>
      </div>
    </form>
  );
}

function AssignedCard({ b }: { b: AssignedBathroom }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const reviews = useQuery({
    queryKey: ['assigned', 'reviews', b.bathroom_id],
    queryFn: () => listReviewsForBathroom(b.bathroom_id),
    enabled: expanded,
  });

  const removeReview = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      softDeleteReview(id, reason || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assigned', 'reviews', b.bathroom_id] });
      void qc.invalidateQueries({ queryKey: ['assigned', 'bathrooms'] });
    },
  });

  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-raised p-4',
        b.open_reports > 0 ? 'border-flush-500/50' : 'border-app',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/bathrooms/${b.bathroom_id}`}
            className="font-medium text-app hover:underline"
          >
            {b.name}
          </Link>
          <p className="text-xs text-muted">{b.address}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {b.deleted_at && (
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
              Removed
            </span>
          )}
          {b.open_reports > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
              {b.open_reports} open report{b.open_reports === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        {b.review_count} live review{b.review_count === 1 ? '' : 's'}
        {b.removed_reviews > 0 && ` · ${b.removed_reviews} removed`} · assigned{' '}
        {fmt(b.assigned_at)}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Hide reviews' : 'Review the reviews'}
        </Button>
        {b.open_reports > 0 && (
          <Link to="/admin/reports">
            <Button variant="ghost" size="sm">
              Open reports queue
            </Button>
          </Link>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-app pt-3">
          {reviews.isPending && <p className="text-sm text-muted">Loading reviews…</p>}
          {reviews.isError && (
            <p className="text-sm text-red-500">
              {reviews.error instanceof Error
                ? reviews.error.message
                : 'Could not load reviews.'}
            </p>
          )}
          {reviews.data && reviews.data.length === 0 && (
            <p className="text-sm text-muted">No reviews yet.</p>
          )}
          {reviews.data?.map((r) => {
            const busy =
              removeReview.isPending && removeReview.variables?.id === r.id;
            return (
              <div
                key={r.id}
                className="flex flex-col gap-1.5 rounded-lg border border-app bg-surface p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm text-app">
                    <span className="font-medium">@{r.author.username}</span>
                    <Stars value={r.rating} size={12} />
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:bg-red-500/10"
                    loading={busy}
                    onClick={() => {
                      const reason = window.prompt(
                        'Reason shown to the author (they can appeal):',
                      );
                      if (reason === null) return;
                      removeReview.mutate({ id: r.id, reason: reason.trim() });
                    }}
                  >
                    Remove
                  </Button>
                </div>
                {r.body && (
                  <p className="line-clamp-3 whitespace-pre-line text-sm text-muted">
                    {r.body}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <OrgResponseComposer reviewId={r.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

export function AdminAssignments() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['assigned', 'bathrooms'],
    queryFn: myAssignedBathrooms,
  });

  if (isPending) return <p className="text-sm text-muted">Loading your bathrooms…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load assignments.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-app bg-raised p-8 text-center">
        <p className="font-medium text-app">No bathrooms assigned to you yet</p>
        <p className="mt-1 text-sm text-muted">
          Moderation is scoped: you can act only on bathrooms an admin assigns
          to you (directly, or via an org). Ask an admin to assign you from the
          Bathrooms or Orgs console — your beat will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {data.length} bathroom{data.length === 1 ? '' : 's'} assigned to you,
        sorted by open reports.
      </p>
      <ul className="flex flex-col gap-3">
        {data.map((b) => (
          <AssignedCard key={b.bathroom_id} b={b} />
        ))}
      </ul>
    </div>
  );
}
