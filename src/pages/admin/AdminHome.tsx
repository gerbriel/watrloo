import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { cn } from '@/lib/cn';

/**
 * The landing view of the control room / moderator panel: what needs a human
 * right now, as clickable queue counts. Moderators see their queues; admins
 * see everything. Counts are cheap HEAD queries under the same RLS that
 * guards the queues themselves.
 */

async function countRows(
  table: 'reports' | 'appeals' | 'bathroom_claims' | 'business_access_requests' | 'ad_campaigns',
  statusColumn: string,
  statusValue: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(statusColumn, statusValue);
  if (error) throw error;
  return count ?? 0;
}

function QueueTile({
  to,
  label,
  count,
  blurb,
}: {
  to: string;
  label: string;
  count: number | undefined;
  blurb: string;
}) {
  const hot = (count ?? 0) > 0;
  return (
    <Link
      to={to}
      className={cn(
        'flex flex-col gap-1 rounded-xl border p-4 transition-colors hover:bg-raised',
        hot ? 'border-flush-500/50' : 'border-app',
      )}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span
        className={cn(
          'text-2xl font-bold tabular-nums',
          hot ? 'text-flush-600' : 'text-app',
        )}
      >
        {count ?? '…'}
      </span>
      <span className="text-xs text-muted">{blurb}</span>
    </Link>
  );
}

export function AdminHome() {
  const { isAdmin } = useAuth();

  const counts = useQuery({
    queryKey: ['admin', 'home', isAdmin],
    queryFn: async () => {
      const [reports, appeals, claims, requests, campaigns] = await Promise.all([
        countRows('reports', 'status', 'open'),
        countRows('appeals', 'status', 'open'),
        isAdmin ? countRows('bathroom_claims', 'status', 'pending') : Promise.resolve(0),
        isAdmin
          ? countRows('business_access_requests', 'status', 'open')
          : Promise.resolve(0),
        isAdmin ? countRows('ad_campaigns', 'status', 'pending_review') : Promise.resolve(0),
      ]);
      return { reports, appeals, claims, requests, campaigns };
    },
    refetchInterval: 60_000,
  });

  const c = counts.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-app">
          {isAdmin ? 'What needs attention' : 'Your moderation queues'}
        </h2>
        <p className="text-sm text-muted">
          {isAdmin
            ? 'Open items across every queue. Tiles light up when a human is needed.'
            : 'Reports from the community land here. Thanks for keeping Watrloo honest.'}
        </p>
      </div>

      {counts.isError && (
        <p className="text-sm text-red-500">
          {counts.error instanceof Error
            ? counts.error.message
            : 'Could not load queue counts.'}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <QueueTile
          to="/admin/reports"
          label="Open reports"
          count={c?.reports}
          blurb="Flagged reviews, bathrooms, and ads"
        />
        {isAdmin && (
          <QueueTile
            to="/admin/appeals"
            label="Open appeals"
            count={c?.appeals}
            blurb="Removals contested by their owners"
          />
        )}
        {isAdmin && (
          <QueueTile
            to="/admin/requests"
            label="Business requests"
            count={c?.requests}
            blurb="Companies asking for access"
          />
        )}
        {isAdmin && (
          <QueueTile
            to="/admin/claims"
            label="Pending claims"
            count={c?.claims}
            blurb="Ownership claims awaiting review"
          />
        )}
        {isAdmin && (
          <QueueTile
            to="/admin/campaigns"
            label="Campaigns to review"
            count={c?.campaigns}
            blurb="Sponsored placements awaiting approval"
          />
        )}
      </div>

      <div className="rounded-xl border border-app bg-raised p-4">
        <p className="text-sm font-medium text-app">Quick reference</p>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
          <li>
            · Removing content always asks for a reason — the owner sees it and
            can appeal.
          </li>
          <li>· Businesses manage their listing facts; they can never touch reviews.</li>
          {isAdmin ? (
            <li>
              · Granting an appeal restores the content instantly; denying requires
              a note the owner will read.
            </li>
          ) : (
            <li>
              · Appeals of your removals are decided by an admin — nothing extra to
              do on your side.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
