// Static marketing mockup: how a CLAIMED listing appears to the public — the
// "storefront" payoff. Hard-coded fake data only — no fetching, no props.
// Mirrors the public bathroom-detail page (src/pages/BathroomDetail.tsx) plus
// the verified "Official" badge (VerifiedBadge) and nested owner response
// (OwnerResponse) so the marketing page can show off a polished, trusted listing.
import type { ReactNode } from 'react';
import { Stars } from '@/components/ui/Stars';
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
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

// Amenity pills mirror AmenityBadges: perks are neutral, access restrictions
// ("Customers only") are amber, exactly like the real listing page.
const AMENITIES: { label: string; caution?: boolean; icon: ReactNode }[] = [
  {
    label: 'Wheelchair accessible',
    icon: (
      <svg {...svgProps}>
        <circle cx="9.5" cy="4" r="1.8" />
        <path d="M9.5 6v6h5l2.5 5" />
        <path d="M14.5 12a5.5 5.5 0 1 1-5-3" />
      </svg>
    ),
  },
  {
    label: 'Changing table',
    icon: (
      <svg {...svgProps}>
        <circle cx="8" cy="6" r="2" />
        <path d="M6 20v-4a2 2 0 0 1 2-2h1l2 3 6-2" />
      </svg>
    ),
  },
  {
    label: 'Customers only',
    caution: true,
    icon: (
      <svg {...svgProps}>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    ),
  },
];

export function StorefrontPreview() {
  return (
    <PreviewFrame title="How visitors see it">
      <div className="flex flex-col gap-5">
        {/* Header — mirrors BathroomDetail's title + address, with the
            verified "Official" pill inline (see VerifiedBadge). */}
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-app">
              Bean &amp; Bar Coffee — Tower District
            </h1>
            <span
              aria-label="Official listing"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
                'text-xs font-medium',
                'bg-flush-600/10 text-flush-600 ring-1 ring-flush-600/20',
              )}
            >
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
            </span>
          </div>
          <p className="text-sm text-muted">805 E Olive Ave, Fresno, CA 93728</p>

          {/* Rating row — mirrors BathroomDetail's aggregate score line. */}
          <div className="flex flex-wrap items-center gap-2">
            <Stars value={4.6} size={20} />
            <span className="text-sm text-app">
              <span className="font-semibold">4.6</span>{' '}
              <span className="text-muted">· 96 reviews</span>
            </span>
          </div>

          {/* Amenity chips — mirrors AmenityBadges. */}
          <ul className="flex flex-wrap items-center gap-1.5">
            {AMENITIES.map((amenity) => (
              <li
                key={amenity.label}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
                  amenity.caution
                    ? 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300'
                    : 'border-app bg-raised text-app',
                )}
              >
                {amenity.icon}
                <span>{amenity.label}</span>
              </li>
            ))}
          </ul>
        </header>

        {/* Example review with the business's official response beneath it —
            mirrors ReviewCard + OwnerResponse. */}
        <article className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
          <div className="flex items-start justify-between gap-3">
            <span className="font-medium text-app">@marisol_f</span>
            <span className="shrink-0 text-xs text-muted">3d ago</span>
          </div>

          <div className="flex items-center gap-2">
            <Stars value={5} size={16} />
            <span className="text-sm font-medium text-app">5.0</span>
          </div>

          <p className="text-sm text-app">
            Spotless and easy to find. Grabbed a coffee and the door code was
            right on the receipt — quick in and out.
          </p>

          {/* Official reply — mirrors OwnerResponse's nested, left-accented card. */}
          <div
            className={cn(
              'ml-2 border-l-2 border-flush-500 rounded-lg bg-sunken pl-3 pr-3 py-2',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-flush-600"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className="truncate text-xs font-bold text-app">
                  Response from Bean &amp; Bar Coffee
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">2d ago</span>
            </div>
            <p className="mt-1 text-sm text-app">
              Thank you, Marisol! We keep the restrooms stocked and check them
              every hour. See you again soon.
            </p>
          </div>
        </article>
      </div>
    </PreviewFrame>
  );
}
