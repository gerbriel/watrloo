import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';
import type { BusinessAccessRequest } from '@/types/db';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function AdminAccessRequests() {
  const qc = useQueryClient();
  const [approvedNote, setApprovedNote] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminAccessRequests(),
    queryFn: () => listAccessRequests('open'),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminAccessRequests() });
  };

  const approve = useMutation({
    mutationFn: (id: string) => approveAccessRequest(id),
    onSuccess: () => {
      setApprovedNote('Approved — business created');
      invalidate();
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => rejectAccessRequest(id),
    onSuccess: () => {
      setApprovedNote(null);
      invalidate();
    },
  });

  if (isPending) return <p className="text-sm text-muted">Loading requests…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load requests.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {approvedNote && (
          <p className="text-sm font-medium text-flush-600">{approvedNote}</p>
        )}
        <p className="text-sm text-muted">No open business requests.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {approvedNote && (
        <p className="text-sm font-medium text-flush-600">{approvedNote}</p>
      )}
      <ul className="flex flex-col gap-3">
        {data.map((r: BusinessAccessRequest) => {
          const busy =
            (approve.isPending && approve.variables === r.id) ||
            (reject.isPending && reject.variables === r.id);
          return (
            <li
              key={r.id}
              className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-bold text-app">{r.business_name}</p>
                <span className="text-xs text-muted">{fmt(r.created_at)}</span>
              </div>

              {r.website && (
                <a
                  href={r.website}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-flush-600 hover:underline"
                >
                  {r.website}
                </a>
              )}

              {r.contact_email && (
                <p className="text-sm text-app">{r.contact_email}</p>
              )}

              {r.message && (
                <p className="whitespace-pre-line text-sm text-app">{r.message}</p>
              )}

              {r.locations_note && (
                <p className="whitespace-pre-line text-sm text-muted">
                  {r.locations_note}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 hover:bg-red-500/10"
                  loading={reject.isPending && reject.variables === r.id}
                  disabled={busy}
                  onClick={() => reject.mutate(r.id)}
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={approve.isPending && approve.variables === r.id}
                  disabled={busy}
                  onClick={() => approve.mutate(r.id)}
                >
                  Approve
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
