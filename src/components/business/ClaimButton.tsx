import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { fileClaim, listMyBusinesses } from '@/lib/api';
import type { MyBusiness } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { queryKeys } from '@/lib/queryClient';
import { cn } from '@/lib/cn';

/** Turn a PostgREST failure into a message a business owner can act on. */
function claimErrorMessage(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  const msg = err instanceof Error ? err.message : '';
  if (code === '23505' || /duplicate|already/i.test(msg)) {
    return 'This listing already has a claim on it. If that looks wrong, contact an admin.';
  }
  return msg || 'Could not file the claim. Please try again.';
}

/**
 * A small CTA on a bathroom page. If the viewer is a business member who owns or
 * manages at least one business, offer to claim this listing for one of them.
 * Everyone else sees a quiet nudge toward the "get verified" flow. Every claim
 * is re-checked in the database and lands in the admin queue as `pending`.
 */
export function ClaimButton({ bathroomId }: { bathroomId: string }) {
  const { user, businessMemberships } = useAuth();

  // Gating is cheap: the roles ride along on the session, so ordinary visitors
  // never trigger the business-name fetch below.
  const eligibleIds = businessMemberships
    .filter((m) => m.role === 'owner' || m.role === 'manager')
    .map((m) => m.business_id);

  if (!user || eligibleIds.length === 0) {
    return (
      <Link
        to="/business/request"
        className="w-fit text-xs text-muted underline-offset-2 hover:text-app hover:underline"
      >
        Own this place? Get it verified →
      </Link>
    );
  }

  return <ClaimPanel bathroomId={bathroomId} userId={user.id} eligibleIds={eligibleIds} />;
}

function ClaimPanel({
  bathroomId,
  userId,
  eligibleIds,
}: {
  bathroomId: string;
  userId: string;
  eligibleIds: string[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const single = eligibleIds.length === 1;

  const claim = useMutation({
    mutationFn: (businessId: string) => fileClaim(bathroomId, businessId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.claimForBathroom(bathroomId) });
    },
  });

  // Only fetch names once the picker is open — the single-business case claims
  // straight from the membership id and never needs them.
  const businesses = useQuery<MyBusiness[]>({
    queryKey: queryKeys.myBusinesses(userId),
    queryFn: () => listMyBusinesses(userId),
    enabled: open && !single,
  });

  if (claim.isSuccess) {
    return (
      <p className="text-xs font-medium text-flush-600">
        Claim requested — pending admin review.
      </p>
    );
  }

  const eligibleBusinesses = (businesses.data ?? []).filter(
    (b) => b.role === 'owner' || b.role === 'manager',
  );

  return (
    <div className="flex w-fit flex-col gap-2">
      <Button
        variant="secondary"
        size="sm"
        loading={single && claim.isPending}
        onClick={() => (single ? claim.mutate(eligibleIds[0]) : setOpen((o) => !o))}
      >
        Claim this listing
      </Button>

      {claim.isError && (
        <p className="text-xs text-red-500">{claimErrorMessage(claim.error)}</p>
      )}

      {open && !single && (
        <div className="flex min-w-56 flex-col gap-2 rounded-lg border border-app bg-raised p-3">
          <p className="text-xs font-medium text-muted">Claim for which business?</p>

          {businesses.isPending ? (
            <p className="text-sm text-muted">Loading your businesses…</p>
          ) : businesses.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-500">Could not load your businesses.</p>
              <Button variant="ghost" size="sm" onClick={() => void businesses.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {eligibleBusinesses.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedId(b.id)}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    selectedId === b.id
                      ? 'border-flush-500 bg-flush-500/10 text-app'
                      : 'border-app text-app hover:bg-sunken',
                  )}
                >
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs capitalize text-muted">{b.role}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setSelectedId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={claim.isPending}
              disabled={selectedId === null}
              onClick={() => selectedId !== null && claim.mutate(selectedId)}
            >
              Confirm claim
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
