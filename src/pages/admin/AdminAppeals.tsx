import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { decideAppeal, listAppeals, type AppealRow } from '@/lib/api/appeals';
import { Button } from '@/components/ui/Button';

type AppealStatus = 'open' | 'granted' | 'denied';

const STATUSES: AppealStatus[] = ['open', 'granted', 'denied'];

const EMPTY_COPY: Record<AppealStatus, string> = {
  open: 'Nobody is waiting on a decision. Nice.',
  granted: 'No appeals have been granted yet.',
  denied: 'No appeals have been denied yet.',
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** The removed content the appeal is about, plus where to see it in context. */
function AppealedItem({ appeal }: { appeal: AppealRow }) {
  if (appeal.review) {
    return (
      <div className="rounded-lg border border-app bg-sunken p-3">
        <p className="text-xs font-medium text-muted">
          Removed review · rated {appeal.review.rating}/5
        </p>
        <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-app">
          {appeal.review.body || '(no written review)'}
        </p>
        <Link
          to={`/bathrooms/${appeal.review.bathroom_id}`}
          className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
        >
          Open in context →
        </Link>
      </div>
    );
  }
  if (appeal.bathroom) {
    return (
      <div className="rounded-lg border border-app bg-sunken p-3">
        <p className="text-xs font-medium text-muted">Removed bathroom</p>
        <p className="mt-1 text-sm font-medium text-app">{appeal.bathroom.name}</p>
        <p className="text-xs text-muted">{appeal.bathroom.address}</p>
        <Link
          to={`/bathrooms/${appeal.bathroom.id}`}
          className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
        >
          Open →
        </Link>
      </div>
    );
  }
  return <p className="text-sm text-muted">The appealed content no longer exists.</p>;
}

export function AdminAppeals() {
  const [status, setStatus] = useState<AppealStatus>('open');
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'appeals', status] as const,
    queryFn: () => listAppeals(status),
  });

  const decide = useMutation({
    mutationFn: ({ id, grant, note }: { id: string; grant: boolean; note?: string }) =>
      decideAppeal(id, grant, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'appeals'] }),
  });

  const grant = (a: AppealRow) => {
    // One dialog is both the confirmation and the (optional) note: Cancel aborts.
    const note = window.prompt(
      'Grant this appeal? The removed content is restored immediately.\n\nOptional note shown to the appellant (leave blank for none):',
    );
    if (note === null) return;
    decide.mutate({ id: a.id, grant: true, note: note.trim() || undefined });
  };

  const deny = (a: AppealRow) => {
    const note = window.prompt(
      'Reason for denying — required, it is shown to the person who appealed:',
    );
    if (note === null) return;
    if (!note.trim()) {
      window.alert('A note is required to deny an appeal.');
      return;
    }
    decide.mutate({ id: a.id, grant: false, note: note.trim() });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Granting an appeal restores the content immediately. Both outcomes are audited and
        the note is shown to the person who appealed.
      </p>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter appeals by status">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={
              status === s
                ? 'rounded-full bg-flush-600 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-app bg-raised px-3 py-1 text-xs font-medium text-muted hover:border-strong hover:text-app'
            }
          >
            {s}
          </button>
        ))}
      </div>

      {isPending ? (
        <p className="text-sm text-muted">Loading appeals…</p>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-red-500">
            {error instanceof Error ? error.message : 'Could not load appeals.'}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-app bg-raised p-8 text-center">
          <p className="font-medium text-app">No {status} appeals</p>
          <p className="mt-1 text-sm text-muted">{EMPTY_COPY[status]}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.map((a) => {
            const rowPending = decide.isPending && decide.variables?.id === a.id;
            return (
              <li
                key={a.id}
                className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-app">
                    Appeal by @{a.appellant?.username ?? 'unknown'}
                  </p>
                  <time className="text-xs text-muted" dateTime={a.created_at}>
                    Filed {fmt(a.created_at)}
                  </time>
                </div>

                <AppealedItem appeal={a} />

                <p className="whitespace-pre-line rounded-lg bg-flush-600/5 p-3 text-sm text-app">
                  “{a.reason}”
                </p>

                {a.status === 'open' ? (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:bg-red-500/10"
                      disabled={rowPending}
                      loading={rowPending && decide.variables?.grant === false}
                      onClick={() => deny(a)}
                    >
                      Deny
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={rowPending}
                      loading={rowPending && decide.variables?.grant === true}
                      onClick={() => grant(a)}
                    >
                      Grant & restore
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-app bg-sunken p-3">
                    <p className="text-xs font-medium text-muted">
                      {a.status === 'granted' ? 'Granted' : 'Denied'}
                      {a.decided_at && ` · ${fmt(a.decided_at)}`}
                    </p>
                    {a.decision_note ? (
                      <p className="mt-1 whitespace-pre-line text-sm text-app">
                        {a.decision_note}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-muted">No note was left.</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
