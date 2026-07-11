import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listPendingCampaigns, reviewCampaign } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

/**
 * Admin approval queue for advertiser campaigns. No campaign runs without an
 * explicit approve here (docs/growth/ADMIN_CRM.md). Creative is frozen at
 * approval, so what you see is what sends.
 */
export function AdminCampaigns() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data: campaigns, isPending } = useQuery({
    queryKey: queryKeys.pendingCampaigns(),
    queryFn: listPendingCampaigns,
  });

  async function decide(id: string, approve: boolean, why?: string) {
    setBusy(id);
    try {
      await reviewCampaign(id, approve, why);
      await queryClient.invalidateQueries({ queryKey: queryKeys.pendingCampaigns() });
      setRejecting(null);
      setReason('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-app">Campaign approvals</h2>
        <p className="text-sm text-muted">
          Review advertiser campaigns before they reach users. Check for
          deceptive, illegal, or misleading offers.
        </p>
      </div>

      {isPending && <div className="h-24 animate-pulse rounded-xl border border-app bg-raised" />}
      {campaigns && campaigns.length === 0 && (
        <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-10 text-center text-sm text-muted">
          Nothing waiting for review.
        </p>
      )}

      {campaigns?.map((c) => (
        <div key={c.id} className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-app">
                {c.business?.name ?? 'Unknown business'}
              </p>
              <p className="text-xs text-muted">
                {c.type === 'in_app_blast' ? 'Message (legacy)' : 'Sponsored placement'}
                {c.target_region ? ` · ${c.target_region}` : ' · all areas'}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-app bg-surface p-3">
            <p className="text-sm font-semibold text-app">{c.creative.title}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-muted">{c.creative.body}</p>
            {c.creative.link && (
              <p className="mt-1 truncate text-xs text-flush-500">{c.creative.link}</p>
            )}
          </div>

          {rejecting === c.id ? (
            <div className="flex flex-col gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejection (shown to the advertiser)"
                className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === c.id}
                  onClick={() => void decide(c.id, false, reason || undefined)}
                >
                  Confirm reject
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={busy === c.id}
                onClick={() => void decide(c.id, true)}
              >
                Approve
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setRejecting(c.id)}>
                Reject
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
