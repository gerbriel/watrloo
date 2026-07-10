// AGENT UNIT — implement per instructions. Preserve the export name + props.
// Display-only: given a reviewId, fetch getReviewResponse and, if present, render
// the official business reply as a distinct nested card (business name + body).
// Render null when there is no response. Composing responses lives in ListingManage.
import { useQuery } from '@tanstack/react-query';
import { getReviewResponse } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { cn } from '@/lib/cn';

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

export function OwnerResponse({ reviewId }: { reviewId: string }) {
  const { data: response } = useQuery({
    queryKey: queryKeys.reviewResponse(reviewId),
    queryFn: () => getReviewResponse(reviewId),
  });

  // No official reply (or still loading): show nothing, not a placeholder.
  if (!response) return null;

  const businessName = response.business?.name ?? 'the business';
  const logoUrl = response.business?.logo_url;

  return (
    <div
      className={cn(
        'ml-2 border-l-2 border-flush-500 rounded-lg bg-sunken pl-3 pr-3 py-2',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {logoUrl && (
            <img
              src={logoUrl}
              alt={businessName}
              className="h-4 w-4 shrink-0 rounded-full object-cover"
            />
          )}
          <span className="truncate text-xs font-bold text-app">
            Response from {businessName}
          </span>
        </div>
        <time
          dateTime={response.created_at}
          title={new Date(response.created_at).toLocaleString()}
          className="shrink-0 text-xs text-muted"
        >
          {timeAgo(response.created_at)}
        </time>
      </div>

      <p className="mt-1 whitespace-pre-line text-sm text-app">{response.body}</p>
    </div>
  );
}
