// AGENT UNIT — implement per instructions. Preserve the export name.
// STATIC MOCKUP. No data fetching, props, or auth — pure JSX with fake data
// that mirrors a real bathroom page + <ClaimButton /> claim panel so the public
// marketing page can show the "claim this listing" flow at a glance.
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';

/** Read-only star row, fractional fill — a trimmed copy of <Stars /> for the mock. */
function Stars({ value }: { value: number }) {
  const gid = useId();
  return (
    <div
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const pct = Math.round(Math.max(0, Math.min(1, value - i)) * 100);
        const id = `${gid}-${i}`;
        return (
          <svg key={i} viewBox="0 0 20 20" className="size-3.5" aria-hidden="true">
            <defs>
              <linearGradient id={id}>
                <stop offset={`${pct}%`} stopColor="var(--color-star)" />
                <stop offset={`${pct}%`} stopColor="transparent" />
              </linearGradient>
            </defs>
            <path
              d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"
              fill={`url(#${id})`}
              stroke="var(--color-star)"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        );
      })}
    </div>
  );
}

function Chip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <li className="inline-flex items-center gap-1 rounded-full border border-app bg-raised px-2.5 py-1 text-xs font-medium text-app">
      {icon}
      <span>{label}</span>
    </li>
  );
}

const WheelchairIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-4 shrink-0"
  >
    <circle cx="9.5" cy="4" r="1.8" />
    <path d="M9.5 6v6h5l2.5 5" />
    <path d="M14.5 12a5.5 5.5 0 1 1-5-3" />
  </svg>
);

const CustomersIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-4 shrink-0"
  >
    <circle cx="12" cy="7" r="3.2" />
    <path d="M6 20v-1a6 6 0 0 1 12 0v1" />
  </svg>
);

/** A static "claim this listing" flow on a bathroom page, shown before → after. */
export function ClaimPreview() {
  return (
    <PreviewFrame title="Claim a location">
      <div className="flex flex-col gap-4">
        {/* Mini bathroom-detail card */}
        <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
          <div>
            <h3 className="text-base font-bold text-app">
              Bean &amp; Bar Coffee — Tower District
            </h3>
            <p className="mt-0.5 text-xs text-muted">815 E Olive Ave, Fresno, CA</p>
          </div>

          <div className="flex items-center gap-2">
            <Stars value={4.6} />
            <span className="text-xs text-app">
              <span className="font-semibold">4.6</span>{' '}
              <span className="text-muted">· 128 reviews</span>
            </span>
          </div>

          <ul className="flex flex-wrap items-center gap-1.5">
            <Chip icon={WheelchairIcon} label="Wheelchair accessible" />
            <Chip icon={CustomersIcon} label="Customers only" />
          </ul>
        </div>

        {/* Claim panel (mock of <ClaimButton />'s open picker) */}
        <div className="flex flex-col gap-3 rounded-xl border border-app bg-surface p-4">
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-4 shrink-0 text-flush-500"
            >
              <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <p className="text-sm font-semibold text-app">Claim this listing</p>
          </div>

          <p className="text-xs text-muted">
            Confirm you manage this business to respond to reviews and keep the
            listing accurate.
          </p>

          {/* Business picker — the owning business is pre-selected */}
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted">Claim for which business?</p>
            <div
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm',
                'border-flush-500 bg-flush-500/10 text-app',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">Bean &amp; Bar Coffee</span>
                <span className="text-xs capitalize text-muted">owner</span>
              </span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-4 shrink-0 text-flush-500"
              >
                <path d="M5 12l4 4 10-10" />
              </svg>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <span className="inline-flex h-8 items-center rounded-xl px-3 text-sm font-medium text-app">
              Cancel
            </span>
            <span className="inline-flex h-8 items-center justify-center rounded-xl bg-gradient-to-b from-flush-500 to-flush-600 px-3 text-sm font-medium text-white shadow-lg shadow-flush-600/25">
              Confirm claim
            </span>
          </div>
        </div>

        {/* Resulting state — the quiet confirmation after the claim is filed */}
        <div className="flex items-center gap-2 rounded-xl border border-app bg-sunken px-3 py-2.5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-4 shrink-0 text-muted"
          >
            <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />
            <path d="M8.5 12l2.5 2.5 4.5-5" />
          </svg>
          <p className="text-xs font-medium text-muted">
            Claim requested — pending admin review.
          </p>
        </div>
      </div>
    </PreviewFrame>
  );
}
