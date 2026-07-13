import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  decideJoinRequest,
  fileUnitDiscipline,
  listUnitDiscipline,
  listUnitJoinRequests,
  resolveUnitDiscipline,
  unitFlaggedReviews,
  unitRemoveReview,
} from '@/lib/api/social';
import { RankBadge } from '@/components/review/RankBadge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Unit operations for the brass: the recruiting desk (join applications) and
 * the discipline desk (reports on subordinates' reviews, unit flags, and the
 * commander's escalation to an admin ban request). Authority is enforced by
 * the database RPCs; these panels only render what the caller may act on.
 */

function errMsg(e: unknown): string {
  const msg =
    typeof e === 'object' && e != null && 'message' in e
      ? String((e as { message: unknown }).message)
      : '';
  return msg || 'Something went wrong.';
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function ApplicationsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['unitJoinRequests'],
    queryFn: listUnitJoinRequests,
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      decideJoinRequest(id, approve),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['unitJoinRequests'] });
      void qc.invalidateQueries({ queryKey: ['battalionLeaderboard'] });
      void qc.invalidateQueries({ queryKey: ['battalionRoster'] });
    },
  });

  if (!data || data.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-app pt-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        Recruiting desk — {data.length} application{data.length === 1 ? '' : 's'}
      </p>
      <ul className="flex flex-col gap-1.5">
        {data.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app bg-surface px-3 py-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/u/${encodeURIComponent(r.username)}`}
                  className="text-sm font-medium text-app hover:underline"
                >
                  @{r.username}
                </Link>
                <RankBadge reviewCount={r.campaigns} />
                <span className="text-xs text-muted">
                  {r.campaigns} campaign{r.campaigns === 1 ? '' : 's'} · applied{' '}
                  {fmt(r.created_at)}
                </span>
              </span>
              {r.message && (
                <span className="text-xs text-muted italic">“{r.message}”</span>
              )}
            </span>
            <span className="flex gap-1.5">
              <Button
                size="sm"
                loading={decide.isPending && decide.variables?.id === r.id}
                onClick={() => decide.mutate({ id: r.id, approve: true })}
              >
                Enlist them
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:bg-red-500/10"
                onClick={() => decide.mutate({ id: r.id, approve: false })}
              >
                Deny
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {decide.isError && <p className="text-xs text-red-500">{errMsg(decide.error)}</p>}
    </section>
  );
}

export function DisciplinePanel({ isCommander }: { isCommander: boolean }) {
  const qc = useQueryClient();
  const flagged = useQuery({
    queryKey: ['unitFlagged'],
    queryFn: unitFlaggedReviews,
  });
  const record = useQuery({
    queryKey: ['unitDiscipline'],
    queryFn: listUnitDiscipline,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['unitFlagged'] });
    void qc.invalidateQueries({ queryKey: ['unitDiscipline'] });
  };
  const remove = useMutation({
    mutationFn: ({ reviewId, reason }: { reviewId: string; reason: string }) =>
      unitRemoveReview(reviewId, reason || undefined),
    onSuccess: refresh,
  });
  const file = useMutation({
    mutationFn: (args: {
      subjectId: string;
      kind: 'flag' | 'ban_request';
      reason: string;
      reviewId?: string;
    }) => fileUnitDiscipline(args.subjectId, args.kind, args.reason, args.reviewId),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: 'resolved' | 'dismissed'; note?: string }) =>
      resolveUnitDiscipline(id, status, note),
    onSuccess: refresh,
  });

  const openRecord = (record.data ?? []).filter((d) => d.status === 'open');
  const closedRecord = (record.data ?? []).filter((d) => d.status !== 'open').slice(0, 5);
  const anyError = remove.error ?? file.error ?? resolve.error;

  if ((flagged.data?.length ?? 0) === 0 && (record.data?.length ?? 0) === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2 border-t border-app pt-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        Discipline desk
        {(flagged.data?.length ?? 0) > 0 && (
          <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 font-bold text-amber-600 normal-case">
            {flagged.data?.length} flagged
          </span>
        )}
      </p>

      {flagged.data?.map((f) => (
        <div
          key={f.report_id}
          className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-surface px-3 py-2"
        >
          <p className="text-sm text-app">
            Report on{' '}
            <Link
              to={`/u/${encodeURIComponent(f.author_username)}`}
              className="font-medium hover:underline"
            >
              @{f.author_username}
            </Link>
            ’s review of{' '}
            <Link to={`/bathrooms/${f.bathroom_id}`} className="font-medium hover:underline">
              {f.bathroom_name}
            </Link>
            : <span className="text-muted italic">“{f.reason}”</span>
          </p>
          {f.review_body && (
            <p className="line-clamp-2 text-xs whitespace-pre-line text-muted">
              {f.review_body}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="text-red-500 hover:bg-red-500/10"
              loading={remove.isPending && remove.variables?.reviewId === f.review_id}
              onClick={() => {
                const reason = window.prompt(
                  'Reason shown to the author (they can appeal):',
                  f.reason,
                );
                if (reason === null) return;
                remove.mutate({ reviewId: f.review_id, reason: reason.trim() });
              }}
            >
              Remove review
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const reason = window.prompt(
                  `Flag @${f.author_username} on the unit's record — why?`,
                );
                if (!reason?.trim()) return;
                file.mutate({
                  subjectId: f.author_id,
                  kind: 'flag',
                  reason: reason.trim(),
                  reviewId: f.review_id,
                });
              }}
            >
              Flag soldier
            </Button>
            {isCommander && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:bg-red-500/10"
                onClick={() => {
                  const reason = window.prompt(
                    `Request an admin ban for @${f.author_username} — give the full reason:`,
                  );
                  if (!reason?.trim()) return;
                  file.mutate({
                    subjectId: f.author_id,
                    kind: 'ban_request',
                    reason: reason.trim(),
                    reviewId: f.review_id,
                  });
                }}
              >
                Request admin ban
              </Button>
            )}
          </div>
        </div>
      ))}

      {openRecord.map((d) => (
        <div
          key={d.id}
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2',
            d.kind === 'ban_request' ? 'border-red-500/40' : 'border-app',
          )}
        >
          <p className="min-w-0 text-sm text-app">
            <span
              className={cn(
                'mr-2 rounded-full px-2 py-0.5 text-xs font-medium',
                d.kind === 'ban_request'
                  ? 'bg-red-500/10 text-red-500'
                  : 'bg-amber-500/15 text-amber-600',
              )}
            >
              {d.kind === 'ban_request' ? 'Ban requested' : 'Flagged'}
            </span>
            @{d.subject_username}{' '}
            <span className="text-muted">
              by @{d.raised_by_username} · “{d.reason}” · {fmt(d.created_at)}
            </span>
          </p>
          {d.kind === 'flag' && isCommander && (
            <span className="flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                loading={resolve.isPending && resolve.variables?.id === d.id}
                onClick={() => {
                  const note = window.prompt('Resolution note (kept on the record):');
                  if (note === null) return;
                  resolve.mutate({ id: d.id, status: 'resolved', note: note.trim() || undefined });
                }}
              >
                Resolve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => resolve.mutate({ id: d.id, status: 'dismissed' })}
              >
                Dismiss
              </Button>
            </span>
          )}
          {d.kind === 'ban_request' && (
            <span className="text-xs text-muted">Awaiting admin review</span>
          )}
        </div>
      ))}

      {closedRecord.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Past discipline ({closedRecord.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {closedRecord.map((d) => (
              <li key={d.id}>
                {d.status === 'resolved' ? '✔' : '✖'} {d.kind === 'ban_request' ? 'Ban request' : 'Flag'} on
                @{d.subject_username} — “{d.reason}”
                {d.resolution && <> → {d.resolution}</>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {anyError != null && <p className="text-xs text-red-500">{errMsg(anyError)}</p>}
      <p className="text-xs text-muted">
        The chain of command polices itself: superiors see reports on their
        soldiers’ reviews and act first; if they don’t, the commander sees the
        same queue, can discipline the soldier, and can escalate to an admin
        ban request.
      </p>
    </section>
  );
}
