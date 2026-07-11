import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listManageableCampaigns,
  listPendingCampaigns,
  reviewCampaign,
  setCampaignStatus,
  suspendBusiness,
} from '@/lib/api/growth';
import type { ManageableCampaign } from '@/lib/api/growth';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

/**
 * Admin control room for advertiser campaigns. Two jobs:
 *   1. Approve or reject campaigns before they ever reach users.
 *   2. Reach in and stop anything already live — pause/stop a single ad, or
 *      suspend an entire advertiser — which drops it from the public feed at
 *      once. This is the safety net behind the global promotions switch.
 * No campaign runs without an explicit approve (docs/growth/ADMIN_CRM.md), and
 * creative is frozen at approval, so what you see is what runs.
 */

const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved · scheduled',
  running: 'Running',
  paused: 'Paused',
};
const STATUS_STYLE: Record<string, string> = {
  approved: 'text-flush-500',
  running: 'text-green-500',
  paused: 'text-amber-500',
};

function CreativePreview({
  creative,
}: {
  creative: { title?: string; body?: string; link?: string };
}) {
  return (
    <div className="rounded-lg border border-app bg-surface p-3">
      <p className="text-sm font-semibold text-app">{creative.title ?? '(untitled)'}</p>
      {creative.body && (
        <p className="mt-1 whitespace-pre-line text-sm text-muted">{creative.body}</p>
      )}
      {creative.link && (
        <p className="mt-1 truncate text-xs text-flush-500">{creative.link}</p>
      )}
    </div>
  );
}

/** The approval queue for campaigns still waiting on a decision. */
function ApprovalQueue() {
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
      // An approval creates a live placement — refresh the manage list too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.manageableCampaigns() });
      setRejecting(null);
      setReason('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
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
          <div>
            <p className="text-sm font-semibold text-app">
              {c.business?.name ?? 'Unknown business'}
            </p>
            <p className="text-xs text-muted">
              {c.type === 'in_app_blast' ? 'Message (legacy)' : 'Sponsored placement'}
              {c.target_region ? ` · ${c.target_region}` : ' · all areas'}
            </p>
          </div>

          <CreativePreview creative={c.creative} />

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
    </section>
  );
}

/** One live/approved/paused ad, with pause/resume/stop + suspend-advertiser. */
function LiveAdRow({
  c,
  busy,
  onCampaign,
  onSuspend,
}: {
  c: ManageableCampaign;
  busy: boolean;
  onCampaign: (status: 'paused' | 'running' | 'done') => void;
  onSuspend: (suspend: boolean) => void;
}) {
  const suspended = !!c.business?.suspended_at;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-app">
            {c.business?.name ?? 'Unknown business'}
          </p>
          <p className="text-xs text-muted">
            <span className={STATUS_STYLE[c.status] ?? 'text-muted'}>
              {STATUS_LABEL[c.status] ?? c.status}
            </span>
            {c.target_region ? ` · ${c.target_region}` : ' · all areas'}
          </p>
        </div>
        {suspended && (
          <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500">
            Advertiser suspended
          </span>
        )}
      </div>

      <CreativePreview creative={c.creative} />

      <div className="flex flex-wrap gap-2">
        {c.status !== 'paused' && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onCampaign('paused')}>
            Pause
          </Button>
        )}
        {c.status === 'paused' && !suspended && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => onCampaign('running')}>
            Resume
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          loading={busy}
          onClick={() => {
            if (window.confirm('Stop this ad for good? It can’t be resumed — the advertiser would resubmit.'))
              onCampaign('done');
          }}
        >
          Stop
        </Button>
        <span className="mx-1 w-px self-stretch bg-[var(--border)]" aria-hidden="true" />
        {suspended ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onSuspend(false)}>
            Reinstate advertiser
          </Button>
        ) : (
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Suspend ${c.business?.name ?? 'this advertiser'}? This pauses ALL of their live ads immediately.`,
                )
              )
                onSuspend(true);
            }}
          >
            Suspend advertiser
          </Button>
        )}
      </div>
    </div>
  );
}

/** Management list for everything already past review. */
function LiveAds() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data: campaigns, isPending } = useQuery({
    queryKey: queryKeys.manageableCampaigns(),
    queryFn: listManageableCampaigns,
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.manageableCampaigns() });
  }

  async function onCampaign(id: string, status: 'paused' | 'running' | 'done') {
    setBusy(id);
    try {
      await setCampaignStatus(id, status);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onSuspend(businessId: string, key: string, suspend: boolean) {
    setBusy(key);
    try {
      await suspendBusiness(businessId, suspend);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-app">Live ads</h2>
        <p className="text-sm text-muted">
          Everything past review. Pause or stop a single ad, or suspend an
          advertiser to pull all of theirs at once — each takes effect
          immediately.
        </p>
      </div>

      {isPending && <div className="h-24 animate-pulse rounded-xl border border-app bg-raised" />}
      {campaigns && campaigns.length === 0 && (
        <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-10 text-center text-sm text-muted">
          No approved or running ads yet.
        </p>
      )}

      {campaigns?.map((c) => (
        <LiveAdRow
          key={c.id}
          c={c}
          busy={busy === c.id || busy === `b:${c.business_id}`}
          onCampaign={(status) => void onCampaign(c.id, status)}
          onSuspend={(suspend) => void onSuspend(c.business_id, `b:${c.business_id}`, suspend)}
        />
      ))}
    </section>
  );
}

export function AdminCampaigns() {
  return (
    <div className="flex flex-col gap-10">
      <ApprovalQueue />
      <LiveAds />
    </div>
  );
}
