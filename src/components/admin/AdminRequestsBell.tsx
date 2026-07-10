import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { countOpenAccessRequests } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { cn } from '@/lib/cn';

/** Outline bell, sized to sit alongside the other header controls. */
function BellIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/**
 * In-app admin notification: a bell that links to the pending business access
 * requests and overlays a live count. The Header only renders this for admins,
 * so no role check happens here. Any fetch failure degrades to "no badge"
 * rather than crashing the header.
 */
export function AdminRequestsBell() {
  const { data } = useQuery({
    queryKey: queryKeys.openAccessRequestCount(),
    queryFn: countOpenAccessRequests,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  // Loading and error both leave `data` undefined; treat that as zero pending.
  const count = data ?? 0;
  const hasPending = count > 0;
  const badge = count > 9 ? '9+' : String(count);

  return (
    <Link
      to="/admin/requests"
      aria-label={`Business access requests (${count} pending)`}
      title="Business access requests"
      className={cn(
        'relative inline-flex size-9 items-center justify-center rounded-full',
        'border border-transparent transition-colors',
        'hover:border-app hover:bg-raised',
        hasPending ? 'text-flush-600' : 'text-muted hover:text-app',
      )}
    >
      <BellIcon />
      {hasPending && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
