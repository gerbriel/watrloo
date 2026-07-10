// AGENT UNIT — implement per instructions. Preserve the export name + props.
// Self-contained: given a bathroomId, fetch the verified owner (getVerifiedOwner)
// and render an "Official" badge (business name, optional logo/website link).
// Render null when there is no verified owner.
import { useQuery } from '@tanstack/react-query';
import { getVerifiedOwner } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { cn } from '@/lib/cn';

export function VerifiedBadge({ bathroomId }: { bathroomId: string }) {
  const { data: owner } = useQuery({
    queryKey: queryKeys.claimForBathroom(bathroomId),
    queryFn: () => getVerifiedOwner(bathroomId),
  });

  // No verified owner (or still loading): show nothing, not a placeholder.
  if (!owner) return null;

  return (
    <span
      aria-label={`Official listing from ${owner.name}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-xs font-medium',
        'bg-flush-600/10 text-flush-600 ring-1 ring-flush-600/20',
      )}
    >
      {owner.logo_url && (
        <img
          src={owner.logo_url}
          alt={owner.name}
          className="h-5 w-auto max-h-5 rounded-full object-contain"
        />
      )}
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
      >
        <path
          fillRule="evenodd"
          d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
          clipRule="evenodd"
        />
      </svg>
      <span>Official</span>
      {owner.website ? (
        <a
          href={owner.website}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          {owner.name}
        </a>
      ) : (
        <span>{owner.name}</span>
      )}
    </span>
  );
}
