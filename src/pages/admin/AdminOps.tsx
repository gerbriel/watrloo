import { useQuery } from '@tanstack/react-query';
import { opsSnapshot, type CronStatus } from '@/lib/api/adminOps';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** The five jobs migration 20260713000000 schedules. Missing = machine off. */
const EXPECTED_CRONS = [
  'ads_rollup',
  'ads_salt_rotate',
  'ads_freq_prune',
  'ads_partition',
  'ads_flag_ivt',
] as const;

/** ads_rollup runs every 15 min; three missed runs means stats are stale. */
const ROLLUP_STALE_MINUTES = 45;

const GREEN_CHIP = 'bg-green-500/10 text-green-600';
const AMBER_CHIP = 'bg-amber-500/10 text-amber-600';
const RED_CHIP = 'bg-red-500/10 text-red-500';
const MUTED_CHIP = 'bg-surface text-muted';

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

/** Translate the handful of cron shapes we actually schedule; else show raw. */
function humanSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === '*') return `every ${every[1]} min`;
  const hhmm = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (dom === '*' && mon === '*' && dow === '*') return `daily at ${hhmm}`;
    if (mon === '*' && dow === '*' && /^\d+$/.test(dom)) {
      return `monthly on day ${dom} at ${hhmm}`;
    }
  }
  return cron;
}

function monthToken(d: Date): string {
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function Chip({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
      {label}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </h2>
  );
}

function StatTile({
  label,
  value,
  sub,
  chip,
}: {
  label: string;
  value?: string;
  sub?: string;
  chip?: { tone: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-app bg-raised p-4">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <div className="flex flex-wrap items-baseline gap-2">
        {value != null && (
          <span className="text-xl font-bold text-app">{value}</span>
        )}
        {chip && <Chip tone={chip.tone} label={chip.label} />}
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

function CronCard({ cron }: { cron: CronStatus }) {
  // Failed is always red; the rollup is additionally red when it stops running,
  // since every stat on this page downstream depends on it.
  const stale =
    cron.jobname === 'ads_rollup' &&
    (cron.last_start == null || minutesSince(cron.last_start) > ROLLUP_STALE_MINUTES);
  const red = cron.last_status === 'failed' || stale;

  const chip =
    cron.last_status === 'succeeded' ? (
      <Chip tone={GREEN_CHIP} label="succeeded" />
    ) : cron.last_status === 'failed' ? (
      <Chip tone={RED_CHIP} label="failed" />
    ) : cron.last_status == null ? (
      <Chip tone={MUTED_CHIP} label="never ran" />
    ) : (
      <Chip tone={MUTED_CHIP} label={cron.last_status} />
    );

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border bg-raised p-4',
        red ? 'border-red-500/50' : 'border-app',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium text-app">{cron.jobname}</span>
        {chip}
      </div>
      <p className="text-xs text-muted">
        {humanSchedule(cron.schedule)}
        {!cron.active && ' · inactive'}
      </p>
      <p className="text-xs text-muted">
        Last run:{' '}
        {cron.last_start ? (
          <time
            dateTime={cron.last_start}
            title={new Date(cron.last_start).toLocaleString()}
          >
            {timeAgo(cron.last_start)}
          </time>
        ) : (
          'never'
        )}
        {stale && <span className="font-medium text-red-500"> · overdue</span>}
      </p>
    </li>
  );
}

export function AdminOps() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'ops'],
    queryFn: opsSnapshot,
    refetchInterval: 60_000,
  });

  if (isPending) return <p className="text-sm text-muted">Loading ops snapshot…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load the ops snapshot.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const byName = new Map(data.crons.map((c) => [c.jobname, c]));
  const missingCrons = EXPECTED_CRONS.filter((name) => !byName.has(name));
  // Expected first (in a stable order), then anything unexpected the DB reports.
  const orderedCrons = [
    ...EXPECTED_CRONS.filter((name) => byName.has(name)),
    ...data.crons.map((c) => c.jobname).filter((n) => !EXPECTED_CRONS.includes(n as (typeof EXPECTED_CRONS)[number])),
  ]
    .map((name) => byName.get(name))
    .filter((c): c is CronStatus => c != null);

  const rollupStale =
    data.rollup_fresh_at == null ||
    minutesSince(data.rollup_fresh_at) > ROLLUP_STALE_MINUTES;
  const rollupAmber = rollupStale && data.events_today > 0;

  const now = new Date();
  const currentMonth = monthToken(now);
  const nextMonth = monthToken(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const nextMissing = !data.partitions.some((p) => p.includes(nextMonth));

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Promotions"
          chip={
            data.promotions_enabled
              ? { tone: GREEN_CHIP, label: 'LIVE' }
              : { tone: RED_CHIP, label: 'PAUSED' }
          }
        />
        <StatTile label="Running campaigns" value={String(data.running_campaigns)} />
        <StatTile
          label="Events today"
          value={String(data.events_today)}
          sub={`${data.invalid_today} invalid`}
        />
        <StatTile
          label="Visitor salt"
          chip={
            data.salt_today
              ? { tone: GREEN_CHIP, label: 'ok' }
              : { tone: AMBER_CHIP, label: 'missing' }
          }
        />
      </div>

      <section className="flex flex-col gap-2">
        <SectionTitle>Cron health</SectionTitle>
        {missingCrons.length > 0 && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-500">
            Not scheduled: {missingCrons.join(', ')}. These jobs should exist in
            pg_cron — the ad platform is not fully running without them.
          </p>
        )}
        {orderedCrons.length === 0 ? (
          <p className="text-sm text-muted">No cron jobs reported.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {orderedCrons.map((c) => (
              <CronCard key={c.jobname} cron={c} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Rollup freshness</SectionTitle>
        <div
          className={cn(
            'rounded-xl border bg-raised p-4',
            rollupAmber ? 'border-amber-500/40' : 'border-app',
          )}
        >
          <p className="text-sm text-app">
            {data.rollup_fresh_at ? (
              <>
                Stats current as of{' '}
                <time
                  dateTime={data.rollup_fresh_at}
                  title={new Date(data.rollup_fresh_at).toLocaleString()}
                  className="font-medium"
                >
                  {timeAgo(data.rollup_fresh_at)}
                </time>
              </>
            ) : (
              'No rollup has run yet.'
            )}
          </p>
          {rollupAmber && (
            <p className="pt-1 text-xs text-amber-600">
              Events are arriving today but stats haven’t been rolled up in over{' '}
              {ROLLUP_STALE_MINUTES} minutes — check ads_rollup.
            </p>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <section className="flex flex-col gap-2">
          <SectionTitle>Offers</SectionTitle>
          <div className="flex flex-col gap-1 rounded-xl border border-app bg-raised p-4">
            <p className="text-sm text-app">
              <span className="text-xl font-bold">{data.offers_open}</span>{' '}
              <span className="text-muted">open (last 2h, awaiting view)</span>
            </p>
            <p className="text-xs text-muted">{data.offers_total} offers all-time</p>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Partitions</SectionTitle>
          <div className="flex flex-col gap-2 rounded-xl border border-app bg-raised p-4">
            {data.partitions.length === 0 ? (
              <p className="text-sm text-muted">No ad_events partitions exist.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {data.partitions.map((p) => (
                  <li
                    key={p}
                    className={cn(
                      'rounded-full border border-app bg-surface px-2 py-0.5 font-mono text-xs',
                      p.includes(currentMonth) ? 'font-medium text-app' : 'text-muted',
                    )}
                  >
                    {p}
                  </li>
                ))}
              </ul>
            )}
            {nextMissing && (
              <p className="text-xs text-amber-600">
                Next month’s partition (ad_events_{nextMonth}) is missing —
                ads_partition should create it before the month rolls over.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
