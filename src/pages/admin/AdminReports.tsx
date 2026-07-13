import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listReports } from '@/lib/api/reports';
import { resolveReport, softDeleteBathroom, softDeleteReview } from '@/lib/api/moderation';
import { adminListBanRequests, resolveUnitDiscipline } from '@/lib/api/social';
import { queryKeys } from '@/lib/queryClient';
import type { ReportWithTarget } from '@/types/db';
import { Button } from '@/components/ui/Button';

/**
 * Ban requests escalated by unit commanders through the chain of command.
 * Deciding one here speaks as @watrloo. A "resolve" today documents the
 * outcome (warning, role removal, content purge) — hard auth bans still need
 * the service_role Edge Function on the backlog.
 */
function BanRequestQueue() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'banRequests'],
    queryFn: adminListBanRequests,
  });
  const decide = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: 'resolved' | 'dismissed'; note?: string }) =>
      resolveUnitDiscipline(id, status, note),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'banRequests'] }),
  });

  if (!data || data.length === 0) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-red-500/40 bg-raised p-4">
      <p className="text-sm font-medium text-app">
        ⚠️ {data.length} ban request{data.length === 1 ? '' : 's'} from unit
        commanders
      </p>
      <ul className="flex flex-col gap-2">
        {data.map((b) => (
          <li
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app bg-surface px-3 py-2"
          >
            <p className="min-w-0 text-sm text-app">
              <Link
                to={`/u/${encodeURIComponent(b.subject_username)}`}
                className="font-medium hover:underline"
              >
                @{b.subject_username}
              </Link>{' '}
              <span className="text-muted">
                — requested by @{b.raised_by_username} (⚔️ {b.battalion_name}):
                “{b.reason}” · {fmt(b.created_at)}
              </span>
            </p>
            <span className="flex gap-1.5">
              <Button
                variant="danger"
                size="sm"
                loading={decide.isPending && decide.variables?.id === b.id}
                onClick={() => {
                  const note = window.prompt(
                    'Action taken (kept on the record, shown to the commander):',
                  );
                  if (note === null) return;
                  decide.mutate({ id: b.id, status: 'resolved', note: note.trim() || undefined });
                }}
              >
                Act on it
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const note = window.prompt('Why is this dismissed? (optional)');
                  if (note === null) return;
                  decide.mutate({ id: b.id, status: 'dismissed', note: note.trim() || undefined });
                }}
              >
                Dismiss
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
    // The reason travels to the owner's "removed content" view, where they can
    // appeal — so removals from this queue always carry one.
    mutationFn: async ({ r, reason }: { r: ReportWithTarget; reason: string }) => {
      if (r.review) await softDeleteReview(r.review.id, reason || undefined);
      else if (r.bathroom) await softDeleteBathroom(r.bathroom.id, reason || undefined);
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
      <div className="flex flex-col gap-4">
        <BanRequestQueue />
        <div className="rounded-xl border border-app bg-raised p-8 text-center">
          <p className="font-medium text-app">No open reports</p>
          <p className="mt-1 text-sm text-muted">The queue is clear. Nice.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BanRequestQueue />
      <ul className="flex flex-col gap-4">
      {data.map((r) => {
        const targetGone = (r.review?.deleted_at ?? r.bathroom?.deleted_at) != null;
        const busy =
          (removeContent.isPending && removeContent.variables?.r.id === r.id) ||
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
                loading={removeContent.isPending && removeContent.variables?.r.id === r.id}
                onClick={() => {
                  const reason = window.prompt(
                    'Reason shown to the owner (they can appeal):',
                  );
                  if (reason === null) return;
                  removeContent.mutate({ r, reason: reason.trim() });
                }}
              >
                {targetGone ? 'Already removed' : 'Remove content'}
              </Button>
            </div>
          </li>
        );
      })}
      </ul>
    </div>
  );
}
