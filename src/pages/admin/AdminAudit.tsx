import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAuditLog } from '@/lib/api/adminOps';
import { Button } from '@/components/ui/Button';

/** Fixed vocabulary of audit targets; the action list is derived from the data. */
const TARGET_TYPES = [
  'review',
  'bathroom',
  'report',
  'profile',
  'photo',
  'business',
  'campaign',
  'setting',
  'placement',
] as const;

const SELECT =
  'rounded-lg border border-app bg-surface px-2 py-1.5 text-sm text-app';

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

/**
 * Flatten a jsonb detail object into displayable key/value pairs: nulls are
 * noise, nested values get stringified, and anything long is truncated.
 */
function detailPairs(detail: Record<string, unknown> | null): [string, string][] {
  if (!detail) return [];
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value == null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    pairs.push([key, text.length > 120 ? `${text.slice(0, 120)}…` : text]);
  }
  return pairs;
}

export function AdminAudit() {
  const [action, setAction] = useState('all');
  const [targetType, setTargetType] = useState('all');

  // 200 rows is weeks of moderation activity; filtering happens client-side.
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () => listAuditLog({ limit: 200 }),
  });

  const actions = useMemo(
    () => [...new Set((data ?? []).map((r) => r.action))].sort(),
    [data],
  );

  if (isPending) return <p className="text-sm text-muted">Loading audit log…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load the audit log.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const rows = data.filter(
    (r) =>
      (action === 'all' || r.action === action) &&
      (targetType === 'all' || r.target_type === targetType),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Action
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className={SELECT}
          >
            <option value="all">all</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Target
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            className={SELECT}
          >
            <option value="all">all</option>
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted">
          {rows.length} of {data.length} entries
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          {data.length === 0
            ? 'No audit entries yet. Moderation and admin actions will show up here.'
            : 'No entries match these filters.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const pairs = detailPairs(r.detail);
            return (
              <li
                key={r.id}
                className="flex flex-col gap-1.5 rounded-xl border border-app bg-raised p-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <time
                    dateTime={r.created_at}
                    title={new Date(r.created_at).toLocaleString()}
                    className="text-xs text-muted"
                  >
                    {timeAgo(r.created_at)}
                  </time>
                  <span className="text-sm font-medium text-app">
                    {r.actor ? `@${r.actor.username}` : 'system'}
                  </span>
                  <span className="rounded-full bg-flush-500/10 px-2 py-0.5 text-xs font-medium text-flush-600">
                    {r.action.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-muted">
                    {r.target_type}{' '}
                    <span className="font-mono" title={r.target_id}>
                      {r.target_id.slice(0, 8)}
                    </span>
                  </span>
                </div>

                {pairs.length > 0 && (
                  <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
                    {pairs.map(([key, value]) => (
                      <div key={key} className="flex items-baseline gap-1 text-xs">
                        <dt className="shrink-0 text-muted">{key}:</dt>
                        <dd className="break-all text-app">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
