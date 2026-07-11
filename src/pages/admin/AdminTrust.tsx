import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adOverview, ivtBreakdown } from '@/lib/api/adminOps';
import type { AdminAdRow, IvtRow } from '@/lib/api/adminOps';
import { listManageableCampaigns, suspendBusiness } from '@/lib/api/growth';
import { listReports } from '@/lib/api/reports';
import type { ReportWithTarget } from '@/types/db';
import { queryKeys } from '@/lib/queryClient';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';

/**
 * Trust & Safety console. Three lenses on ad abuse, aggregate-first:
 *   1. Invalid traffic (IVT) flagged by the DB filters (docs/growth/oss-research/6-ivt.md)
 *      — totals by reason plus the worst campaigns.
 *   2. User reports filed against ads.
 *   3. Per-advertiser strike sheet, ranked by invalid share, with the suspend lever.
 * Everything shown here is an aggregate — no session hashes or per-user rows
 * ever render. Every destructive action is confirmed and audit-logged server-side.
 */

const IVT_DAYS = 14;
const STRIKE_DAYS = 28;

const REASON_LABEL: Record<string, string> = {
  bot_ua: 'Bot user-agent',
  self_view: 'Self-view',
  self_click: 'Self-click',
  click_velocity: 'Click velocity',
  daily_volume: 'Daily volume cap',
};
const CANONICAL_REASONS = ['bot_ua', 'self_view', 'self_click', 'click_velocity', 'daily_volume'];

function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

// queryKeys has no trust entries; these are local to this console. The ivt key
// is shared between the two sections below so react-query fetches it once.
const ivtKey = (since: string) => ['admin', 'trust', 'ivt', since] as const;
const adsKey = (since: string) => ['admin', 'trust', 'ads', since] as const;

// --- Shared section chrome ----------------------------------------------------

function SectionHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-app">{title}</h2>
      <p className="text-sm text-muted">{blurb}</p>
    </div>
  );
}

function Skeleton() {
  return <div className="h-24 animate-pulse rounded-xl border border-app bg-raised" />;
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-red-500">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-10 text-center text-sm text-muted">
      {text}
    </p>
  );
}

// --- 1. Invalid traffic -------------------------------------------------------

interface CampaignIvt {
  id: string;
  title: string;
  business: string;
  total: number;
  topReason: string;
}

/** Fold the day×campaign×reason rows into reason totals and a per-campaign table. */
function foldIvt(rows: IvtRow[]): { totals: Map<string, number>; campaigns: CampaignIvt[] } {
  const totals = new Map<string, number>();
  const byCampaign = new Map<
    string,
    { title: string; business: string; total: number; reasons: Map<string, number> }
  >();
  for (const r of rows) {
    const reason = r.flag_reason ?? 'unspecified';
    totals.set(reason, (totals.get(reason) ?? 0) + r.events);
    const agg = byCampaign.get(r.campaign_id) ?? {
      title: r.campaign_title,
      business: r.business_name,
      total: 0,
      reasons: new Map<string, number>(),
    };
    agg.total += r.events;
    agg.reasons.set(reason, (agg.reasons.get(reason) ?? 0) + r.events);
    byCampaign.set(r.campaign_id, agg);
  }
  const campaigns = [...byCampaign.entries()]
    .map(([id, a]) => {
      let topReason = 'unspecified';
      let best = -1;
      for (const [k, n] of a.reasons) {
        if (n > best) {
          topReason = k;
          best = n;
        }
      }
      return { id, title: a.title, business: a.business, total: a.total, topReason };
    })
    .sort((a, b) => b.total - a.total);
  return { totals, campaigns };
}

function IvtSection() {
  const since = dayAgo(IVT_DAYS);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ivtKey(since),
    queryFn: () => ivtBreakdown(since),
  });

  const { totals, campaigns } = foldIvt(data ?? []);
  // The five known filters always show (a zero is a signal too); anything the
  // DB adds later still surfaces rather than silently disappearing.
  const chipReasons = [
    ...CANONICAL_REASONS,
    ...[...totals.keys()].filter((k) => !CANONICAL_REASONS.includes(k)),
  ];

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Invalid traffic"
        blurb={`Events the serving filters flagged in the last ${IVT_DAYS} days, by reason. Aggregates only — no per-session data.`}
      />

      {isPending && <Skeleton />}
      {isError && (
        <LoadError
          message={errMsg(error, 'Could not load the IVT breakdown.')}
          onRetry={() => void refetch()}
        />
      )}
      {data && data.length === 0 && (
        <Empty text={`No invalid traffic flagged in the last ${IVT_DAYS} days.`} />
      )}

      {data && data.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {chipReasons.map((r) => {
              const n = totals.get(r) ?? 0;
              return (
                <span
                  key={r}
                  className="inline-flex items-center gap-1.5 rounded-full border border-app bg-raised px-3 py-1 text-xs font-medium text-app"
                >
                  {reasonLabel(r)}
                  <span className={cn('tabular-nums', n > 0 ? 'text-red-500' : 'text-muted')}>
                    {n.toLocaleString()}
                  </span>
                </span>
              );
            })}
          </div>

          <div className="overflow-x-auto rounded-xl border border-app bg-raised">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 text-right font-medium">Flagged events</th>
                  <th className="px-4 py-2 font-medium">Top reason</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-app last:border-b-0">
                    <td className="px-4 py-2">
                      <p className="font-medium text-app">{c.title}</p>
                      <p className="text-xs text-muted">{c.business}</p>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-app">
                      {c.total.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-muted">{reasonLabel(c.topReason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// --- 2. Ad reports --------------------------------------------------------------

type AdReport = ReportWithTarget & { ad_campaign: NonNullable<ReportWithTarget['ad_campaign']> };

function AdReportsSection() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.reports('open'),
    queryFn: () => listReports('open'),
  });

  const adReports = (data ?? []).filter((r): r is AdReport => r.ad_campaign != null);

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Ad reports"
        blurb="Open user reports filed against sponsored ads. Resolve them from the Reports tab; act on the campaign from Campaigns."
      />

      {isPending && <Skeleton />}
      {isError && (
        <LoadError
          message={errMsg(error, 'Could not load reports.')}
          onRetry={() => void refetch()}
        />
      )}
      {data && adReports.length === 0 && <Empty text="No open ad reports." />}

      {adReports.map((r) => (
        <div key={r.id} className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4">
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
          <div className="rounded-lg border border-app bg-sunken p-3">
            <p className="text-sm font-medium text-app">
              {r.ad_campaign.creative.title ?? '(untitled)'}
            </p>
            <p className="text-xs text-muted">
              {r.ad_campaign.business?.name ?? 'unknown business'} · {r.ad_campaign.status}
            </p>
            <Link
              to="/admin/campaigns"
              className="mt-1 inline-block text-xs font-medium text-flush-600 hover:underline"
            >
              Open campaign review →
            </Link>
          </div>
        </div>
      ))}
    </section>
  );
}

// --- 3. Business strikes ----------------------------------------------------------

interface BusinessStrike {
  id: string;
  name: string;
  impressions: number;
  clicks: number;
  invalid: number;
  flaggedCampaigns: number;
}

function invalidShare(b: BusinessStrike): number {
  const total = b.impressions + b.clicks + b.invalid;
  return total === 0 ? 0 : b.invalid / total;
}

/** Per-business totals from the ad overview, joined to IVT via campaign_id. */
function buildStrikes(ads: AdminAdRow[], ivt: IvtRow[]): BusinessStrike[] {
  const byBiz = new Map<string, BusinessStrike>();
  const campaignBiz = new Map<string, string>();
  for (const r of ads) {
    campaignBiz.set(r.campaign_id, r.business_id);
    const b = byBiz.get(r.business_id) ?? {
      id: r.business_id,
      name: r.business_name,
      impressions: 0,
      clicks: 0,
      invalid: 0,
      flaggedCampaigns: 0,
    };
    b.impressions += r.impressions;
    b.clicks += r.clicks;
    b.invalid += r.invalid_events;
    byBiz.set(r.business_id, b);
  }
  const flagged = new Map<string, Set<string>>();
  for (const r of ivt) {
    if (r.events <= 0) continue;
    const bizId = campaignBiz.get(r.campaign_id);
    if (!bizId) continue; // campaign outside the overview window — can't attribute
    const set = flagged.get(bizId) ?? new Set<string>();
    set.add(r.campaign_id);
    flagged.set(bizId, set);
  }
  for (const [bizId, set] of flagged) {
    const b = byBiz.get(bizId);
    if (b) b.flaggedCampaigns = set.size;
  }
  return [...byBiz.values()].sort(
    (a, b) => invalidShare(b) - invalidShare(a) || b.invalid - a.invalid,
  );
}

function StrikesSection() {
  const qc = useQueryClient();
  const sinceAds = dayAgo(STRIKE_DAYS);
  const sinceIvt = dayAgo(IVT_DAYS);

  const ads = useQuery({ queryKey: adsKey(sinceAds), queryFn: () => adOverview(sinceAds) });
  const ivt = useQuery({ queryKey: ivtKey(sinceIvt), queryFn: () => ivtBreakdown(sinceIvt) });
  // Best-effort suspended state (businesses.suspended_at rides along on the
  // manageable-campaigns read). If a business has no live campaign, its state
  // is unknown here — we still offer the levers, without claiming a state.
  const manageable = useQuery({
    queryKey: queryKeys.manageableCampaigns(),
    queryFn: listManageableCampaigns,
  });

  const toggle = useMutation({
    mutationFn: ({ businessId, suspend, why }: { businessId: string; suspend: boolean; why?: string }) =>
      suspendBusiness(businessId, suspend, why),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.manageableCampaigns() });
    },
  });

  function ask(b: BusinessStrike, suspend: boolean) {
    const question = suspend
      ? `Suspend ${b.name}? This pauses ALL of their live ads immediately.`
      : `Reinstate ${b.name}? They will be able to run ads again.`;
    if (!window.confirm(question)) return;
    const why = window.prompt('Reason (written to the audit log):', '');
    if (why === null) return; // cancelled
    toggle.mutate({ businessId: b.id, suspend, why: why.trim() || undefined });
  }

  const suspendedById = new Map<string, boolean>();
  for (const c of manageable.data ?? []) {
    if (c.business) suspendedById.set(c.business_id, c.business.suspended_at != null);
  }

  const isPending = ads.isPending || ivt.isPending;
  const isError = ads.isError || ivt.isError;
  const strikes = ads.data && ivt.data ? buildStrikes(ads.data, ivt.data) : [];

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Business strikes"
        blurb={`Advertisers ranked by invalid share of their traffic (last ${STRIKE_DAYS} days; flagged campaigns over ${IVT_DAYS}). Suspending pauses all of a business's live ads at once.`}
      />

      {isPending && <Skeleton />}
      {!isPending && isError && (
        <LoadError
          message={errMsg(ads.error ?? ivt.error, 'Could not load the strike sheet.')}
          onRetry={() => {
            void ads.refetch();
            void ivt.refetch();
          }}
        />
      )}
      {ads.data && ivt.data && strikes.length === 0 && (
        <Empty text={`No ad traffic in the last ${STRIKE_DAYS} days.`} />
      )}

      {toggle.isError && (
        <p className="text-sm text-red-500">
          {errMsg(toggle.error, 'Suspension change failed.')}
        </p>
      )}

      {strikes.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-app bg-raised">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Business</th>
                <th className="px-4 py-2 text-right font-medium">Events</th>
                <th className="px-4 py-2 text-right font-medium">Invalid</th>
                <th className="px-4 py-2 text-right font-medium">Flagged campaigns</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {strikes.map((b) => {
                const total = b.impressions + b.clicks + b.invalid;
                const share = invalidShare(b);
                const busy = toggle.isPending && toggle.variables?.businessId === b.id;
                const known = suspendedById.get(b.id);
                return (
                  <tr key={b.id} className="border-b border-app last:border-b-0">
                    <td className="px-4 py-2">
                      <span className="font-medium text-app">{b.name}</span>
                      {known === true && (
                        <span className="ml-2 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500">
                          Suspended
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-app">
                      {total.toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2 text-right tabular-nums',
                        b.invalid > 0 ? 'text-red-500' : 'text-muted',
                      )}
                    >
                      {(share * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-app">
                      {b.flaggedCampaigns}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {known !== true && (
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busy}
                            onClick={() => ask(b, true)}
                          >
                            Suspend
                          </Button>
                        )}
                        {known !== false && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            onClick={() => ask(b, false)}
                          >
                            Unsuspend
                          </Button>
                        )}
                        {known === undefined && (
                          <span className="text-xs text-muted">state shown after refresh</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AdminTrust() {
  return (
    <div className="flex flex-col gap-10">
      <IvtSection />
      <AdReportsSection />
      <StrikesSection />
    </div>
  );
}
