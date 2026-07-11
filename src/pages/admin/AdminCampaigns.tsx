import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listManageableCampaigns,
  listPendingCampaigns,
  reviewCampaign,
  setCampaignStatus,
  suspendBusiness,
} from '@/lib/api/growth';
import type { ManageableCampaign } from '@/lib/api/growth';
import { listAuditLog } from '@/lib/api/adminOps';
import type { AuditRow } from '@/lib/api/adminOps';
import type { AdOfferItem } from '@/lib/api/adserving';
import { FeaturedCard } from '@/components/growth/FeaturedCard';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

/**
 * Admin control room for advertiser campaigns. Two jobs:
 *   1. Approve or reject campaigns before they ever reach users — with a
 *      structured rejection taxonomy, a policy checklist, a live FeaturedCard
 *      preview, repeat-offender flags from the audit log, and bulk actions.
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

type PendingCampaign = Awaited<ReturnType<typeof listPendingCampaigns>>[number];

// Audit-log query keys, shared between the queue (repeat-rejection flags) and
// the per-campaign History disclosures. Kept local: no other page reads these.
const AUDIT_LOG_KEY = ['admin', 'auditLog', 'recent'] as const;
const REJECTIONS_KEY = ['admin', 'auditLog', 'rejections'] as const;

// --- Structured rejection reasons -------------------------------------------

const REJECT_REASONS = [
  { code: 'misleading_claims', label: 'Misleading claims' },
  { code: 'prohibited_content', label: 'Prohibited content' },
  { code: 'review_mimicry', label: 'Review mimicry' },
  { code: 'broken_link', label: 'Broken link' },
  { code: 'image_quality', label: 'Image quality' },
  { code: 'targeting_abuse', label: 'Targeting abuse' },
  { code: 'other', label: 'Other' },
] as const;
type RejectCode = (typeof REJECT_REASONS)[number]['code'];

/** Serialize to the wire format the free-text `reject_reason` column stores. */
function composeReason(code: RejectCode, note: string): string {
  const trimmed = note.trim();
  return trimmed ? `${code}: ${trimmed}` : code;
}

/** Parse a stored reason back into code + note; legacy free text has no code. */
function splitRejectReason(reason: string): { code: RejectCode | null; note: string } {
  const idx = reason.indexOf(': ');
  const head = idx === -1 ? reason : reason.slice(0, idx);
  const match = REJECT_REASONS.find((r) => r.code === head);
  if (match) return { code: match.code, note: idx === -1 ? '' : reason.slice(idx + 2) };
  return { code: null, note: reason };
}

function ReasonChip({ reason }: { reason: string }) {
  const { code, note } = splitRejectReason(reason);
  const label = code ? REJECT_REASONS.find((r) => r.code === code)?.label : null;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 text-xs">
      {label && (
        <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-500">
          {label}
        </span>
      )}
      {note && <span className="text-muted">{note}</span>}
    </span>
  );
}

/** Reason-code select + optional note, shared by single and bulk reject. */
function RejectReasonFields({
  code,
  note,
  onCode,
  onNote,
}: {
  code: RejectCode | '';
  note: string;
  onCode: (code: RejectCode | '') => void;
  onNote: (note: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <select
        value={code}
        onChange={(e) => onCode(e.target.value as RejectCode | '')}
        aria-label="Rejection reason"
        className="rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
      >
        <option value="">Pick a reason…</option>
        {REJECT_REASONS.map((r) => (
          <option key={r.code} value={r.code}>
            {r.label}
          </option>
        ))}
      </select>
      <input
        value={note}
        onChange={(e) => onNote(e.target.value)}
        placeholder="Optional note (shown to the advertiser)"
        className="min-w-0 flex-1 rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app"
      />
    </div>
  );
}

// --- Review aids --------------------------------------------------------------

const POLICY_CHECKS = [
  'Claims are honest and specific — nothing unverifiable',
  'Doesn’t read like a user review (no review mimicry)',
  'Link resolves and matches the advertised offer',
  'Title is disclosure-safe — reads as an ad, not editorial',
];

/** Static, read-only reviewer reminders. Purely presentational. */
function PolicyChecklist() {
  return (
    <div className="rounded-lg border border-app bg-surface p-3">
      <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted">
        Policy checklist
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {POLICY_CHECKS.map((check) => (
          <li key={check} className="flex items-start gap-2 text-xs text-muted">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-block size-3 shrink-0 rounded-sm border border-strong"
            />
            {check}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The real FeaturedCard, fed a synthetic offer. offer_id '' is falsy, so
 * useAdOffer skips all impression/click/dwell accounting; the inert wrapper
 * additionally makes the card (and its link/report button) non-interactive.
 */
function LivePreview({ c }: { c: PendingCampaign }) {
  const item: AdOfferItem = {
    offer_id: '',
    placement_id: '',
    campaign_id: c.id,
    business_id: c.business_id,
    business_name: c.business?.name ?? 'Unknown business',
    bathroom_id: c.bathroom_id,
    creative: c.creative,
    region: c.target_region,
  };
  return (
    <div className="rounded-lg border border-dashed border-app bg-surface p-3">
      <p className="mb-2 text-[0.65rem] font-medium uppercase tracking-wide text-muted">
        Live preview — as users would see it
      </p>
      <div inert className="pointer-events-none select-none">
        <FeaturedCard item={item} />
      </div>
    </div>
  );
}

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

// --- Audit timeline -------------------------------------------------------------

function detailReason(row: AuditRow): string | null {
  const reason = row.detail?.['reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/** Expandable audit history for one campaign, filtered from the shared log. */
function CampaignHistory({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isPending } = useQuery({
    queryKey: AUDIT_LOG_KEY,
    queryFn: () => listAuditLog({ limit: 200 }),
    enabled: open,
    staleTime: 60_000,
  });
  const rows = open ? (data ?? []).filter((r) => r.target_id === campaignId) : [];

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="self-start text-xs font-medium text-muted transition-colors hover:text-app"
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && isPending && <div className="h-8 animate-pulse rounded-lg bg-surface" />}
      {open && !isPending && rows.length === 0 && (
        <p className="text-xs text-muted">
          No audit entries for this campaign in the last 200 actions.
        </p>
      )}
      {open && rows.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-app bg-surface p-2">
          {rows.map((r) => {
            const reason = detailReason(r);
            return (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span className="font-medium text-app">{r.action.replaceAll('_', ' ')}</span>
                <span className="text-muted">{r.actor?.username ?? 'unknown'}</span>
                <span className="text-muted">{new Date(r.created_at).toLocaleString()}</span>
                {reason && <ReasonChip reason={reason} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- Approval queue ---------------------------------------------------------------

type RowResult =
  | { state: 'working' }
  | { state: 'done' }
  | { state: 'error'; message: string };

function RowResultChip({ result }: { result: RowResult | undefined }) {
  if (!result) return null;
  if (result.state === 'working') {
    return (
      <span className="rounded-full bg-flush-500/15 px-2 py-0.5 text-xs font-medium text-flush-500">
        Working…
      </span>
    );
  }
  if (result.state === 'done') {
    return (
      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-500">
        Done
      </span>
    );
  }
  return (
    <span
      title={result.message}
      className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500"
    >
      Failed{result.message ? `: ${result.message}` : ''}
    </span>
  );
}

/** The approval queue for campaigns still waiting on a decision. */
function ApprovalQueue() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectCode, setRejectCode] = useState<RejectCode | ''>('');
  const [rejectNote, setRejectNote] = useState('');

  // Bulk selection + shared-reason reject.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<'approve' | 'reject' | null>(null);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkCode, setBulkCode] = useState<RejectCode | ''>('');
  const [bulkNote, setBulkNote] = useState('');
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const bulkRunning = bulkMode !== null;

  const { data: campaigns, isPending } = useQuery({
    queryKey: queryKeys.pendingCampaigns(),
    queryFn: listPendingCampaigns,
  });

  // Fetched once; every pending row checks its advertiser against this log.
  const { data: rejectionLog } = useQuery({
    queryKey: REJECTIONS_KEY,
    queryFn: () => listAuditLog({ action: 'reject_campaign', limit: 200 }),
    staleTime: 60_000,
  });

  // Prior rejections per pending campaign: match on detail.business_id when the
  // audit row carries one, otherwise fall back to the campaign id itself.
  const priorRejections = useMemo(() => {
    const counts = new Map<string, number>();
    if (!rejectionLog || !campaigns) return counts;
    for (const c of campaigns) {
      let n = 0;
      for (const row of rejectionLog) {
        const bid = row.detail?.['business_id'];
        const matches =
          typeof bid === 'string'
            ? bid === c.business_id || row.target_id === c.id
            : row.target_id === c.id;
        if (matches) n += 1;
      }
      counts.set(c.id, n);
    }
    return counts;
  }, [rejectionLog, campaigns]);

  async function refreshAfterReview() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.pendingCampaigns() });
    // An approval creates a live placement — refresh the manage list too.
    await queryClient.invalidateQueries({ queryKey: queryKeys.manageableCampaigns() });
    // Every review writes an audit row; keep flags and timelines honest.
    await queryClient.invalidateQueries({ queryKey: REJECTIONS_KEY });
    await queryClient.invalidateQueries({ queryKey: AUDIT_LOG_KEY });
  }

  async function decide(id: string, approve: boolean, why?: string) {
    setBusy(id);
    try {
      await reviewCampaign(id, approve, why);
      await refreshAfterReview();
      setRejecting(null);
      setRejectCode('');
      setRejectNote('');
    } finally {
      setBusy(null);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected =
    !!campaigns && campaigns.length > 0 && campaigns.every((c) => selected.has(c.id));

  function toggleAll() {
    if (!campaigns) return;
    setSelected(allSelected ? new Set() : new Set(campaigns.map((c) => c.id)));
  }

  /** Sequentially review every selected campaign, recording per-row outcomes. */
  async function runBulk(approve: boolean, why?: string) {
    const ids = campaigns?.filter((c) => selected.has(c.id)).map((c) => c.id) ?? [];
    if (ids.length === 0) return;
    setBulkMode(approve ? 'approve' : 'reject');
    try {
      for (const id of ids) {
        setRowResults((prev) => ({ ...prev, [id]: { state: 'working' } }));
        try {
          await reviewCampaign(id, approve, why);
          setRowResults((prev) => ({ ...prev, [id]: { state: 'done' } }));
        } catch (err) {
          setRowResults((prev) => ({
            ...prev,
            [id]: {
              state: 'error',
              message: err instanceof Error ? err.message : 'request failed',
            },
          }));
        }
      }
      setSelected(new Set());
      setBulkRejectOpen(false);
      setBulkCode('');
      setBulkNote('');
      await refreshAfterReview();
    } finally {
      setBulkMode(null);
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

      {campaigns && campaigns.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-medium text-app">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={bulkRunning}
                aria-label="Select all pending campaigns"
                className="size-4 accent-flush-500"
              />
              Select all
            </label>
            <span className="text-xs text-muted">
              {selected.size} of {campaigns.length} selected
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={selected.size === 0 || bulkRunning}
                loading={bulkMode === 'approve'}
                onClick={() => void runBulk(true)}
              >
                Approve selected
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={selected.size === 0 || bulkRunning}
                onClick={() => setBulkRejectOpen((v) => !v)}
              >
                Reject selected…
              </Button>
            </div>
          </div>
          {bulkRejectOpen && (
            <div className="flex flex-col gap-2 border-t border-app pt-2">
              <p className="text-xs text-muted">
                One shared reason applies to every selected campaign.
              </p>
              <RejectReasonFields
                code={bulkCode}
                note={bulkNote}
                onCode={setBulkCode}
                onNote={setBulkNote}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!bulkCode || selected.size === 0 || bulkMode === 'approve'}
                  loading={bulkMode === 'reject'}
                  onClick={() => {
                    if (bulkCode) void runBulk(false, composeReason(bulkCode, bulkNote));
                  }}
                >
                  Reject {selected.size} selected
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={bulkRunning}
                  onClick={() => setBulkRejectOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {campaigns?.map((c) => {
        const priorCount = priorRejections.get(c.id) ?? 0;
        return (
          <div
            key={c.id}
            className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4"
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggleSelected(c.id)}
                disabled={bulkRunning}
                aria-label={`Select campaign from ${c.business?.name ?? 'unknown business'}`}
                className="mt-0.5 size-4 shrink-0 accent-flush-500"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-app">
                  {c.business?.name ?? 'Unknown business'}
                </p>
                <p className="text-xs text-muted">
                  {c.type === 'in_app_blast' ? 'Message (legacy)' : 'Sponsored placement'}
                  {c.target_region ? ` · ${c.target_region}` : ' · all areas'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {priorCount > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                    rejected {priorCount}× before
                  </span>
                )}
                <RowResultChip result={rowResults[c.id]} />
              </div>
            </div>

            {c.reject_reason && (
              <div className="flex flex-wrap items-baseline gap-1.5 text-xs text-muted">
                <span>Last rejection:</span>
                <ReasonChip reason={c.reject_reason} />
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <CreativePreview creative={c.creative} />
                <PolicyChecklist />
              </div>
              <LivePreview c={c} />
            </div>

            <CampaignHistory campaignId={c.id} />

            {rejecting === c.id ? (
              <div className="flex flex-col gap-2">
                <RejectReasonFields
                  code={rejectCode}
                  note={rejectNote}
                  onCode={setRejectCode}
                  onNote={setRejectNote}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!rejectCode}
                    loading={busy === c.id}
                    onClick={() => {
                      if (rejectCode)
                        void decide(c.id, false, composeReason(rejectCode, rejectNote));
                    }}
                  >
                    Confirm reject
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRejecting(null);
                      setRejectCode('');
                      setRejectNote('');
                    }}
                  >
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
                  disabled={bulkRunning}
                  onClick={() => void decide(c.id, true)}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulkRunning}
                  onClick={() => {
                    setRejecting(c.id);
                    setRejectCode('');
                    setRejectNote('');
                  }}
                >
                  Reject
                </Button>
              </div>
            )}
          </div>
        );
      })}
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

      <CampaignHistory campaignId={c.id} />

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
    // Kill-switch actions write audit rows too — keep History fresh.
    await queryClient.invalidateQueries({ queryKey: AUDIT_LOG_KEY });
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
