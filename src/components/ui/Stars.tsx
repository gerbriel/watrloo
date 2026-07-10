import { useId } from 'react';
import { cn } from '@/lib/cn';
import type { Score } from '@/types/db';

function Star({ fill, className }: { fill: number; className?: string }) {
  // `fill` is 0..1. Clip a solid star to that fraction for half-star display.
  // The gradient id must be unique per instance or stars collide in the DOM.
  const gid = useId();
  const pct = Math.round(Math.max(0, Math.min(1, fill)) * 100);
  return (
    <svg viewBox="0 0 20 20" className={cn('size-full', className)} aria-hidden="true">
      <defs>
        <linearGradient id={gid}>
          <stop offset={`${pct}%`} stopColor="var(--color-star)" />
          <stop offset={`${pct}%`} stopColor="transparent" />
        </linearGradient>
      </defs>
      <path
        d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z"
        fill={`url(#${gid})`}
        stroke="var(--color-star)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Read-only star display. `value` may be fractional (e.g. an average). */
export function Stars({
  value,
  size = 16,
  className,
}: {
  value: number;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('inline-flex items-center gap-0.5', className)}
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} style={{ width: size, height: size }}>
          <Star fill={value - i} />
        </span>
      ))}
    </div>
  );
}

/** Interactive 1–5 picker. Renders a radio group so it is keyboard-navigable. */
export function StarInput({
  name,
  value,
  onChange,
  size = 24,
}: {
  name: string;
  value: Score | null;
  onChange: (v: Score) => void;
  size?: number;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="inline-flex gap-1">
      {([1, 2, 3, 4, 5] as const).map((n) => (
        <label
          key={n}
          className="cursor-pointer"
          style={{ width: size, height: size }}
        >
          <input
            type="radio"
            name={name}
            value={n}
            checked={value === n}
            onChange={() => onChange(n)}
            className="sr-only"
          />
          <Star
            fill={value !== null && n <= value ? 1 : 0}
            className="transition-transform hover:scale-110"
          />
          <span className="sr-only">
            {n} star{n > 1 ? 's' : ''}
          </span>
        </label>
      ))}
    </div>
  );
}
