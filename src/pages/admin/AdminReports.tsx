import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listReports } from '@/lib/api/reports';
import { resolveReport, softDeleteBathroom, softDeleteReview } from '@/lib/api/moderation';
import { queryKeys } from '@/lib/queryClient';
import type { ReportWithTarget } from '@/types/db';
import { Button } from '@/components/ui/Button';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** The content a report points at, plus where to go to see it in context. */
function Target({ report }: { report: ReportWithTarget }) {
  if (report.review) {
    return (
      <div className="rounded-lg border border-app bg-sunken p-3">
        <p className="text-xs font-medium text-muted">
          Review by @{report.review.author?.username ?? 'unknown'} · rated{' '}
          {report.review.rating}/5
          {report.review.deleted_at && ' · already removed'}
        </p>
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-app">
          {report.review.body || '(no written review)'}
        </p>
        <Link
          to={`/bathrooms/${report.review.bathroom_id}`}
          className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
        >
          Open in context →
        </Link>
      </div>
    );
  }
  if (report.bathroom) {
    return (
      <div className="rounded-lg border border-app bg-sunken p-3">
        <p className="text-xs font-medium text-muted">
          Bathroom{report.bathroom.deleted_at && ' · already removed'}
        </p>
        <p className="mt-1 text-sm font-medium text-app">{report.bathroom.name}</p>
        <p className="text-xs text-muted">{report.bathroom.address}</p>
        <Link
          to={`/bathrooms/${report.bathroom.id}`}
          className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
        >
          Open →
        </Link>
      </div>
    );
  }
  if (report.ad_campaign) {
    return (
      <div className="rounded-lg border border-app bg-sunken p-3">
        <p className="text-xs font-medium text-muted">
          Sponsored ad by {report.ad_campaign.business?.name ?? 'unknown business'} ·{' '}
          {report.ad_campaign.status}
        </p>
        <p className="mt-1 text-sm font-medium text-app">
          {report.ad_campaign.creative.title ?? '(untitled)'}
        </p>
        {report.ad_campaign.creative.body && (
          <p className="line-clamp-2 text-xs text-muted">{report.ad_campaign.creative.body}</p>
        )}
        <Link
          to="/admin/campaigns"
          className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
        >
          Open campaign review →
        </Link>
      </div>
    );
  }
  return <p className="text-sm text-muted">Target no longer exists.</p>;
}

export function AdminReports() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.reports('open'),
    queryFn: () => listReports('open'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.reports('open') });

  const removeContent = useMutation({
    mutationFn: async (r: ReportWithTarget) => {
      if (r.review) await softDeleteReview(r.review.id);
      else if (r.bathroom) await softDeleteBathroom(r.bathroom.id);
      await resolveReport(r.id, false);
    },
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: (r: ReportWithTarget) => resolveReport(r.id, true),
    onSuccess: invalidate,
  });

  if (isPending) {
    return <p className="text-sm text-muted">Loading reports…</p>;
  }
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load reports.'}
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
        <p className="font-medium text-app">No open reports</p>
        <p className="mt-1 text-sm text-muted">The queue is clear. Nice.</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {data.map((r) => {
        const targetGone = (r.review?.deleted_at ?? r.bathroom?.deleted_at) != null;
        const busy =
          (removeContent.isPending && removeContent.variables?.id === r.id) ||
          (dismiss.isPending && dismiss.variables?.id === r.id);
        return (
          <li
            key={r.id}
            className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-app">
                Reported by @{r.reporter?.username ?? 'unknown'}
              </p>
              <time className="text-xs text-muted" dateTime={r.created_at}>
                {fmt(r.created_at)}
              </time>
            </div>

            <p className="whitespace-pre-line rounded-lg bg-flush-600/5 p-3 text-sm text-app">
              “{r.reason}”
            </p>

            <Target report={r} />

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => dismiss.mutate(r)}
              >
                Dismiss (keep it)
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy || targetGone}
                loading={removeContent.isPending && removeContent.variables?.id === r.id}
                onClick={() => removeContent.mutate(r)}
              >
                {targetGone ? 'Already removed' : 'Remove content'}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
