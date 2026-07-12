import { useQuery } from '@tanstack/react-query';
import { bathroomAttributes, listAttributeDefs } from '@/lib/api/attributes';
import type { AttributeDef } from '@/lib/api/attributes';
import { cn } from '@/lib/cn';

/**
 * The bathroom's standardized attributes as pills, styled to sit alongside
 * AmenityBadges: amenities as neutral pills, cautions in the same amber
 * treatment as `requires_key`. Only active defs render — deactivated taxonomy
 * entries stay on record but disappear here because we fetch active defs only.
 */
export function AttributeBadges({
  bathroomId,
  className,
}: {
  bathroomId: string;
  className?: string;
}) {
  const defs = useQuery({
    queryKey: ['attributeDefs', true],
    queryFn: () => listAttributeDefs(),
  });
  const slugs = useQuery({
    queryKey: ['bathroomAttributes', bathroomId],
    queryFn: () => bathroomAttributes(bathroomId),
  });

  // Nothing to show while loading, on error, or when the bathroom is bare.
  if (!defs.isSuccess || !slugs.isSuccess || slugs.data.length === 0) return null;

  const attached = new Set(slugs.data);
  const present: AttributeDef[] = defs.data
    .filter((d) => attached.has(d.slug))
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'amenity' ? -1 : 1) : a.sort - b.sort,
    );
  if (present.length === 0) return null;

  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {present.map((def) => {
        const caution = def.kind === 'caution';
        return (
          <li
            key={def.slug}
            title={caution ? (def.description ?? undefined) : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
              caution
                ? 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300'
                : 'border-app bg-raised text-app',
            )}
          >
            {def.label}
          </li>
        );
      })}
    </ul>
  );
}
