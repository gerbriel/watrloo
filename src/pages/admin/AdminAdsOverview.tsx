import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adOverview } from '@/lib/api/adminOps';
import type { AdminAdRow } from '@/lib/api/adminOps';
import { ctrPosterior, MIN_SAMPLE } from '@/lib/ads/stats';
import { Button } from '@/components/ui/Button';

/**
 * Ads Command Center: platform-wide campaign performance for admins
 * (docs/growth/ADMIN_CONTROL_ROOM_V2.md, Agent 1). One admin_ad_overview
 * round trip feeds everything: KPI tiles across all campaigns, a per-campaign
 * table sorted by impressions (the spend proxy), honest CTRs with 95%
 * credible intervals (never a bare point estimate below MIN_SAMPLE),
 * invalid-traffic shares, per-surface splits, 14v14-day deltas, anomaly
 * chips, and a raw CSV export for billing conversations.
 */

const WINDOW_DAYS = 28;
const COMPARE_DAYS = 14;
/** Flag a campaign when more than this share of its events were invalid. */
const IVT_WARN_SHARE = 0.1;

/** ISO day (UTC) n days ago — matches the date-typed `day` column. */
function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Share of all recorded events (valid impressions + valid clicks + filtered
 * events) that the validity filters threw out.
 */
function invalidShare(invalid: number, impressions: number, clicks: number): number {
  const total = impressions + clicks + invalid;
  return total > 0 ? invalid / total : 0;
}

/**
 * Bar fill mirrors the app's theme cascade (media default + data-theme
 * override, as in index.css). The bars are decorative duplicates of the
 * numbers beside them, so low contrast is never the only encoding.
 */
const BAR_CSS = `
.aads-bar { background-color: var(--color-flush-500); }
@media (prefers-color-scheme: dark) { .aads-bar { background-color: var(--color-flush-600); } }
:root[data-theme='light'] .aads-bar { background-color: var(--color-flush-500); }
:root[data-theme='dark'] .aads-bar { background-color: var(--color-flush-600); }
`;

const SURFACE_ORDER = ['browse', 'map', 'detail'];
const SURFACE_LABEL: Record<string, string> = {
  browse: 'Browse',
  map: 'Map',
  detail: 'Detail',
};

const STATUS_CHIP: Record<string, string> = {
  running: 'bg-green-500/10 text-green-500',
  paused: 'bg-amber-500/15 text-amber-600',
  approved: 'bg-flush-500/10 text-flush-600',
};

interface PeriodSums {
  impressions: number;
  clicks: number;
}

interface SurfaceAgg extends PeriodSums {
  surface: string;
}

interface CampaignAgg {
  id: string;
  title: string;
  business: string;
  status: string;
  impressions: number;
  clicks: number;
  sessions: number;
  invalid: number;
  recent: PeriodSums;
  prior: PeriodSums;
  surfaces: SurfaceAgg[];
}

/**
 * One row per campaign, sorted by impressions desc. Totals come from the
 * '__all__' rollup rows; per-surface rows only feed the surface mini-lines
 * (counting both would double it all).
 */
function aggregate(rows: AdminAdRow[]): CampaignAgg[] {
  const recentSince = dayAgo(COMPARE_DAYS);
  const byCampaign = new Map<string, CampaignAgg>();
  const surfacesByCampaign = new Map<string, Map<string, PeriodSums>>();

  for (const r of rows) {
    let agg = byCampaign.get(r.campaign_id);
    if (!agg) {
      agg = {
        id: r.campaign_id,
        title: r.campaign_title.trim() || `Campaign ${r.campaign_id.slice(0, 8)}`,
        business: r.business_name,
        status: r.campaign_status,
        impressions: 0,
        clicks: 0,
        sessions: 0,
        invalid: 0,
        recent: { impressions: 0, clicks: 0 },
        prior: { impressions: 0, clicks: 0 },
        surfaces: [],
      };
      byCampaign.set(r.campaign_id, agg);
      surfacesByCampaign.set(r.campaign_id, new Map());
    }
    if (r.surface === '__all__') {
      agg.impressions += r.impressions;
      agg.clicks += r.clicks;
      agg.sessions += r.unique_sessions;
      agg.invalid += r.invalid_events;
      const bucket = r.day.slice(0, 10) >= recentSince ? agg.recent : agg.prior;
      bucket.impressions += r.impressions;
      bucket.clicks += r.clicks;
    } else {
      const surfaces = surfacesByCampaign.get(r.campaign_id)!;
      const s = surfaces.get(r.surface) ?? { impressions: 0, clicks: 0 };
      s.impressions += r.impressions;
      s.clicks += r.clicks;
      surfaces.set(r.surface, s);
    }
  }

  const order = (surface: string) => {
    const i = SURFACE_ORDER.indexOf(surface);
    return i === -1 ? SURFACE_ORDER.length : i;
  };
  for (const [id, agg] of byCampaign) {
    agg.surfaces = [...surfacesByCampaign.get(id)!.entries()]
      .map(([surface, sums]) => ({ surface, ...sums }))
      .sort((a, b) => order(a.surface) - order(b.surface));
  }

  return [...byCampaign.values()].sort((a, b) => b.impressions - a.impressions);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function exportCsv(rows: AdminAdRow[]): void {
  const header = 'day,campaign,business,surface,impressions,clicks,unique_sessions,invalid_events';
  const lines = [...rows]
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.campaign_title.localeCompare(b.campaign_title) ||
        a.surface.localeCompare(b.surface),
    )
    .map((r) =>
      [
        r.day.slice(0, 10),
        csvEscape(r.campaign_title),
        csvEscape(r.business_name),
        r.surface,
        r.impressions,
        r.clicks,
        r.unique_sessions,
        r.invalid_events,
      ].join(','),
    );
  const blob = new Blob([[header, ...lines].join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `watrloo-admin-ads-${dayAgo(0)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** ▲/▼ change vs the previous period; muted "new" when there was no baseline. */
function Delta({ label, recent, prior }: { label: string; recent: number; prior: number }) {
  if (prior === 0) {
    return (
      <span className="text-xs text-muted">
        {label}: {recent > 0 ? 'new' : '—'}
      </span>
    );
  }
  const change = Math.round(((recent - prior) / prior) * 100);
  if (change === 0) {
    return <span className="text-xs text-muted">{label}: ±0%</span>;
  }
  const up = change > 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-green-500' : 'text-red-500'}`}>
      {label}: <span aria-hidden="true">{up ? '▲' : '▼'}</span> {Math.abs(change)}%
      <span className="sr-only">{up ? ' up' : ' down'}</span>
    </span>
  );
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-app bg-raised px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-app">{value}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-sunken px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-app">{children}</dd>
    </div>
  );
}

function CampaignRow({ c }: { c: CampaignAgg }) {
  const posterior = ctrPosterior(c.clicks, c.impressions);
  const share = invalidShare(c.invalid, c.impressions, c.clicks);
  const highIvt = share > IVT_WARN_SHARE;

  // CTR anomaly: last 14 days under half of the prior 14, and only when both
  // periods clear the sample floor — below it a "drop" is just noise.
  const priorCtr = c.prior.impressions > 0 ? c.prior.clicks / c.prior.impressions : 0;
  const recentCtr = c.recent.impressions > 0 ? c.recent.clicks / c.recent.impressions : 0;
  const ctrDrop =
    c.recent.impressions >= MIN_SAMPLE &&
    c.prior.impressions >= MIN_SAMPLE &&
    priorCtr > 0 &&
    recentCtr < priorCtr / 2;

  const maxSurfaceImpressions = Math.max(1, ...c.surfaces.map((s) => s.impressions));

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-semibold text-app">{c.title}</p>
          <p className="truncate text-xs text-muted">{c.business}</p>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_CHIP[c.status] ?? 'bg-sunken text-muted'
            }`}
          >
            {c.status}
          </span>
          {ctrDrop && (
            <span
              className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500"
              title={`CTR over the last ${COMPARE_DAYS} days is under half of the prior ${COMPARE_DAYS} days (both periods ≥ ${MIN_SAMPLE} impressions)`}
            >
              CTR drop
            </span>
          )}
          {highIvt && (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600"
              title="More than 10% of this campaign's events were flagged invalid"
            >
              high IVT
            </span>
          )}
        </div>
        <p
          className="flex shrink-0 items-baseline gap-2"
          title={`Last ${COMPARE_DAYS} days vs the ${COMPARE_DAYS} before`}
        >
          <Delta label="impr" recent={c.recent.impressions} prior={c.prior.impressions} />
          <Delta label="clicks" recent={c.recent.clicks} prior={c.prior.clicks} />
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Cell label="Impressions">{c.impressions.toLocaleString()}</Cell>
        <Cell label="Clicks">{c.clicks.toLocaleString()}</Cell>
        <Cell label="CTR (95% CI)">
          {c.impressions >= MIN_SAMPLE ? (
            <>
              {pct(posterior.mean)}{' '}
              <span className="font-normal text-muted">
                ({pct(posterior.low95).slice(0, -1)}–{pct(posterior.high95)})
              </span>
            </>
          ) : (
            <span className="font-normal text-muted">
              n/a ({c.impressions.toLocaleString()} impr)
            </span>
          )}
        </Cell>
        <Cell label="Sessions">{c.sessions.toLocaleString()}</Cell>
        <Cell label="Invalid share">
          {highIvt ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
              {pct(share)}
            </span>
          ) : (
            pct(share)
          )}{' '}
          <span className="text-xs font-normal text-muted">
            {c.invalid.toLocaleString()} events
          </span>
        </Cell>
      </dl>

      {c.surfaces.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-app pt-2">
          {c.surfaces.map((s) => (
            <li key={s.surface} className="grid grid-cols-[4rem_1fr_auto] items-center gap-2">
              <span className="text-xs text-muted">{SURFACE_LABEL[s.surface] ?? s.surface}</span>
              <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <span
                  className="aads-bar block h-full rounded-full"
                  style={{
                    width: `${Math.max(
                      (s.impressions / maxSurfaceImpressions) * 100,
                      s.impressions > 0 ? 4 : 0,
                    )}%`,
                  }}
                />
              </span>
              <span className="text-xs tabular-nums text-muted">
                {s.impressions.toLocaleString()} impressions · {s.clicks.toLocaleString()} clicks
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function AdminAdsOverview() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'adOverview'],
    queryFn: () => adOverview(dayAgo(WINDOW_DAYS)),
  });

  const campaigns = useMemo(() => aggregate(data ?? []), [data]);
  const totals = useMemo(
    () =>
      campaigns.reduce(
        (t, c) => ({
          impressions: t.impressions + c.impressions,
          clicks: t.clicks + c.clicks,
          sessions: t.sessions + c.sessions,
          invalid: t.invalid + c.invalid,
          running: t.running + (c.status === 'running' ? 1 : 0),
        }),
        { impressions: 0, clicks: 0, sessions: 0, invalid: 0, running: 0 },
      ),
    [campaigns],
  );

  if (isPending) return <p className="text-sm text-muted">Loading ads overview…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load the ads overview.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-8 text-center text-sm text-muted">
        No ad activity yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <style>{BAR_CSS}</style>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          All campaigns · last {WINDOW_DAYS} days · trend compares the last {COMPARE_DAYS} days
          with the {COMPARE_DAYS} before
        </p>
        <Button variant="secondary" size="sm" onClick={() => exportCsv(data)}>
          Export CSV
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="Impressions" value={totals.impressions.toLocaleString()} />
        <KpiTile label="Clicks" value={totals.clicks.toLocaleString()} />
        <KpiTile label="Unique sessions" value={totals.sessions.toLocaleString()} />
        <KpiTile
          label="Invalid events"
          value={totals.invalid.toLocaleString()}
          sub={`${pct(invalidShare(totals.invalid, totals.impressions, totals.clicks))} of events`}
        />
        <KpiTile
          label="Campaigns active"
          value={totals.running.toLocaleString()}
          sub="status: running"
        />
      </dl>

      <ul className="flex flex-col gap-3">
        {campaigns.map((c) => (
          <CampaignRow key={c.id} c={c} />
        ))}
      </ul>
    </div>
  );
}
