import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listClaims, reviewClaim } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';
import type { ClaimWithContext } from '@/types/db';

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function AdminClaims() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminClaims(),
    queryFn: () => listClaims('pending'),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminClaims() });
  };

  const verify = useMutation({
    mutationFn: (id: string) => reviewClaim(id, true),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: (id: string) => reviewClaim(id, false),
    onSuccess: invalidate,
  });

  if (isPending) return <p className="text-sm text-muted">Loading claims…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load claims.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Verifying a claim gives the business control over that listing's facts and
        lets it respond to reviews. It never lets them edit or remove reviews.
      </p>

      {data.length === 0 ? (
        <p className="text-sm text-muted">No pending claims.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.map((claim: ClaimWithContext) => {
            const busy =
              (verify.isPending && verify.variables === claim.id) ||
              (reject.isPending && reject.variables === claim.id);
            return (
              <li
                key={claim.id}
                className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-app">
                    <span className="font-medium">
                      {claim.business?.name ?? 'Unknown business'}
                    </span>{' '}
                    <span className="text-muted">is claiming</span>
                  </p>
                  <span className="text-xs text-muted">{fmt(claim.created_at)}</span>
                </div>

                {claim.bathroom ? (
                  <Link
                    to={`/bathrooms/${claim.bathroom.id}`}
                    className="text-sm font-medium text-flush-600 hover:underline"
                  >
                    {claim.bathroom.name}
                    <span className="block text-xs font-normal text-muted">
                      {claim.bathroom.address}
                    </span>
                  </Link>
                ) : (
                  <p className="text-sm text-muted">Bathroom no longer exists.</p>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:bg-red-500/10"
                    loading={reject.isPending && reject.variables === claim.id}
                    disabled={busy}
                    onClick={() => reject.mutate(claim.id)}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={verify.isPending && verify.variables === claim.id}
                    disabled={busy}
                    onClick={() => verify.mutate(claim.id)}
                  >
                    Verify
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
