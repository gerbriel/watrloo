import type { ReactNode } from 'react';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import type { Amenities } from '@/types/db';
import { cn } from '@/lib/cn';

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: 'size-4 shrink-0',
};

const ICONS: Record<keyof Amenities, ReactNode> = {
  wheelchair_accessible: (
    <svg {...svgProps}>
      <circle cx="9.5" cy="4" r="1.8" />
      <path d="M9.5 6v6h5l2.5 5" />
      <path d="M14.5 12a5.5 5.5 0 1 1-5-3" />
    </svg>
  ),
  gender_neutral: (
    <svg {...svgProps}>
      <circle cx="12" cy="6.5" r="3" />
      <path d="M6.5 20v-1a5.5 5.5 0 0 1 11 0v1" />
    </svg>
  ),
  changing_table: (
    <svg {...svgProps}>
      <circle cx="8" cy="6" r="2" />
      <path d="M6 20v-4a2 2 0 0 1 2-2h1l2 3 6-2" />
    </svg>
  ),
  requires_key: (
    <svg {...svgProps}>
      <circle cx="8" cy="9" r="4" />
      <path d="M11 12l7 7M15.5 16.5l2-2M13.5 18.5l2-2" />
    </svg>
  ),
};

const CAUTION_KEY: keyof Amenities = 'requires_key';

/**
 * Renders only the amenities that are `true`, as pills. `requires_key` is a
 * caution (you may not be able to get in), so it is styled amber, distinctly
 * from the perks.
 */
export function AmenityBadges({
  amenities,
  compact = false,
  className,
}: {
  amenities: Amenities;
  /** Icon-only pills for dense contexts like cards; label moves to a tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const present = AMENITY_KEYS.filter((k) => amenities[k]);
  if (present.length === 0) return null;

  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {present.map((key) => {
        const caution = key === CAUTION_KEY;
        const label = AMENITY_LABELS[key];
        return (
          <li
            key={key}
            title={compact ? label : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border text-xs font-medium',
              compact ? 'p-1.5' : 'px-2.5 py-1',
              caution
                ? 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300'
                : 'border-app bg-raised text-app',
            )}
          >
            {ICONS[key]}
            {compact ? (
              <span className="sr-only">{label}</span>
            ) : (
              <span>{label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
