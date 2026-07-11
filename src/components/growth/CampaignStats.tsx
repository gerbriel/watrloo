import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAdDailyStats } from '@/lib/api/adserving';
import type { AdDailyStat } from '@/lib/api/adserving';
import { listCampaigns } from '@/lib/api/growth';
import { ctrPosterior, MIN_SAMPLE } from '@/lib/ads/stats';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

/**
 * Advertiser-facing performance panel over ad_daily_stats. Honest low-volume
 * reporting (docs/growth/oss-research/3-growthbook.md): a CTR is only ever
 * shown with its 95% credible interval, and below MIN_SAMPLE impressions we
 * say "not enough data" instead of a misleading point estimate.
 */

const WINDOW_DAYS = 28;
const COMPARE_DAYS = 14;

/** ISO day (UTC) n days ago — matches the date-typed `day` column. */
function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Bar fill mirrors the app's theme cascade (media default + data-theme
 * override, as in index.css). flush-500 passes the light-surface checks;
 * flush-600 is the dark-surface step. The bars are decorative duplicates of
 * the numbers beside them, so low contrast is never the only encoding.
 */
const BAR_CSS = `
.cstats-bar { background-color: var(--color-flush-500); }
@media (prefers-color-scheme: dark) { .cstats-bar { background-color: var(--color-flush-600); } }
:root[data-theme='light'] .cstats-bar { background-color: var(--color-flush-500); }
:root[data-theme='dark'] .cstats-bar { background-color: var(--color-flush-600); }
`;

const SURFACE_ORDER = ['browse', 'map', 'detail'];
const SURFACE_LABEL: Record<string, string> = {
  browse: 'Browse',
  map: 'Map',
  detail: 'Detail',
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
  impressions: number;
  clicks: number;
  sessions: number;
  invalid: number;
  recent: PeriodSums;
  prior: PeriodSums;
  surfaces: SurfaceAgg[];
}

function aggregate(rows: AdDailyStat[]): CampaignAgg[] {
  const recentSince = dayAgo(COMPARE_DAYS);
  const byCampaign = new Map<string, CampaignAgg>();
  const surfacesByCampaign = new Map<string, Map<string, PeriodSums>>();

  for (const r of rows) {
    let agg = byCampaign.get(r.campaign_id);
    if (!agg) {
      agg = {
        id: r.campaign_id,
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
    const day = r.day.slice(0, 10);
    if (r.surface === '__all__') {
      agg.impressions += r.impressions;
      agg.clicks += r.clicks;
      agg.sessions += r.unique_sessions;
      agg.invalid += r.invalid_events;
      const bucket = day >= recentSince ? agg.recent : agg.prior;
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

  for (const [id, agg] of byCampaign) {
    const order = (surface: string) => {
      const i = SURFACE_ORDER.indexOf(surface);
      return i === -1 ? SURFACE_ORDER.length : i;
    };
    agg.surfaces = [...surfacesByCampaign.get(id)!.entries()]
      .map(([surface, sums]) => ({ surface, ...sums }))
      .sort((a, b) => order(a.surface) - order(b.surface));
  }

  return [...byCampaign.values()].sort((a, b) => b.impressions - a.impressions);
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function exportCsv(rows: AdDailyStat[], labelFor: (id: string) => string): void {
  const header = 'day,campaign,surface,impressions,clicks,unique_sessions,invalid_events';
  const lines = [...rows]
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        labelFor(a.campaign_id).localeCompare(labelFor(b.campaign_id)) ||
        a.surface.localeCompare(b.surface),
    )
    .map((r) =>
      [
        r.day.slice(0, 10),
        csvEscape(labelFor(r.campaign_id)),
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
  a.download = `watrloo-ads-${dayAgo(0)}.csv`;
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

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-sunken px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-app">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function CampaignCard({ agg, label }: { agg: CampaignAgg; label: string }) {
  const maxSurfaceImpressions = Math.max(
    1,
    ...agg.surfaces.map((s) => s.impressions),
  );
  const posterior = ctrPosterior(agg.clicks, agg.impressions);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 truncate text-sm font-semibold text-app">{label}</p>
        <p
          className="flex shrink-0 items-baseline gap-2"
          title={`Last ${COMPARE_DAYS} days vs the ${COMPARE_DAYS} before`}
        >
          <Delta
            label="impr"
            recent={agg.recent.impressions}
            prior={agg.prior.impressions}
          />
          <Delta label="clicks" recent={agg.recent.clicks} prior={agg.prior.clicks} />
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <StatTile label="Impressions" value={agg.impressions} />
        <StatTile label="Clicks" value={agg.clicks} />
        <StatTile label="Sessions" value={agg.sessions} />
      </dl>

      {agg.impressions < MIN_SAMPLE ? (
        <p className="text-sm text-muted">
          Not enough data yet ({agg.impressions.toLocaleString()} impressions).
        </p>
      ) : (
        <p className="text-sm text-app">
          CTR <span className="font-semibold tabular-nums">{pct(posterior.mean)}</span>{' '}
          <span className="tabular-nums text-muted">
            ({pct(posterior.low95).slice(0, -1)}–{pct(posterior.high95)})
          </span>{' '}
          <span className="text-xs text-muted">95% credible interval</span>
        </p>
      )}

      {agg.invalid > 0 && (
        <p
          className="text-xs text-muted"
          title="Events removed by validity filters and not counted above"
        >
          filtered: {agg.invalid.toLocaleString()}
        </p>
      )}

      {agg.surfaces.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-app pt-2">
          {agg.surfaces.map((s) => (
            <li key={s.surface} className="grid grid-cols-[4rem_1fr_auto] items-center gap-2">
              <span className="text-xs text-muted">
                {SURFACE_LABEL[s.surface] ?? s.surface}
              </span>
              <span
                aria-hidden="true"
                className="h-1.5 overflow-hidden rounded-full bg-sunken"
              >
                <span
                  className="cstats-bar block h-full rounded-full"
                  style={{
                    width: `${Math.max(
                      (s.impressions / maxSurfaceImpressions) * 100,
                      s.impressions > 0 ? 4 : 0,
                    )}%`,
                  }}
                />
              </span>
              <span className="text-xs tabular-nums text-muted">
                {s.impressions.toLocaleString()} impressions ·{' '}
                {s.clicks.toLocaleString()} clicks
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function CampaignStats({ businessId }: { businessId: string }) {
  const stats = useQuery({
    queryKey: ['adstats', businessId],
    queryFn: () => listAdDailyStats(businessId, { sinceDay: dayAgo(WINDOW_DAYS) }),
    enabled: businessId !== '',
  });
  const campaigns = useQuery({
    queryKey: queryKeys.campaigns(businessId),
    queryFn: () => listCampaigns(businessId),
    enabled: businessId !== '',
  });

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campaigns.data ?? []) {
      m.set(c.id, c.creative.title?.trim() || `Campaign ${c.id.slice(0, 8)}`);
    }
    return m;
  }, [campaigns.data]);
  const labelFor = (id: string) => labels.get(id) ?? `Campaign ${id.slice(0, 8)}`;

  const aggs = useMemo(() => aggregate(stats.data ?? []), [stats.data]);

  if (stats.isPending || campaigns.isPending) {
    return <div className="h-24 animate-pulse rounded-xl border border-app bg-raised" />;
  }
  if (stats.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {stats.error instanceof Error
            ? stats.error.message
            : 'Could not load campaign stats.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void stats.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (stats.data.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-app bg-raised px-4 py-8 text-center text-sm text-muted">
        No ad activity yet — stats appear within 15 minutes of your first impression.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <style>{BAR_CSS}</style>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Last {WINDOW_DAYS} days · trend compares the last {COMPARE_DAYS} days with
          the {COMPARE_DAYS} before
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => exportCsv(stats.data, labelFor)}
        >
          Export CSV
        </Button>
      </div>
      <ul className="flex flex-col gap-3">
        {aggs.map((agg) => (
          <CampaignCard key={agg.id} agg={agg} label={labelFor(agg.id)} />
        ))}
      </ul>
    </div>
  );
}
