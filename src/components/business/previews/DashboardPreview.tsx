// AGENT UNIT — implemented per instructions. Preserve the export name.
// A STATIC, hard-coded marketing mockup of the business-owner dashboard.
// No data fetching, no props — pure presentational JSX with fake data that
// mirrors the real page at src/pages/business/BusinessDashboard.tsx.
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
import { cn } from '@/lib/cn';

const CHIP_BASE = 'inline-block rounded-full px-2 py-0.5 text-xs font-medium';
const GREEN_CHIP = 'bg-green-500/15 text-green-600';
const AMBER_CHIP = 'bg-amber-500/15 text-amber-600';

const QUICK_LINKS = ['Import CSV', 'Team', 'Analytics', 'Settings'] as const;

type Location = {
  name: string;
  address: string;
  status: 'Verified' | 'Pending';
};

const LOCATIONS: Location[] = [
  {
    name: 'Golden Bear Gas — Bakersfield',
    address: '2400 Golden State Hwy',
    status: 'Verified',
  },
  {
    name: 'Golden Bear Gas — Sacramento',
    address: '500 Richards Blvd',
    status: 'Verified',
  },
  {
    name: 'Golden Bear Gas — Barstow',
    address: '2751 Lenwood Rd',
    status: 'Pending',
  },
];

export function DashboardPreview() {
  return (
    <PreviewFrame title="Your businesses">
      <section className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-5">
        {/* Business header: logo + name + role, plan chip on the right */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* Square logo placeholder */}
            <div
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-flush-500/15 text-flush-600"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
              >
                <path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
                <path d="M3.5 21h11M6.5 7h5M15 10h2a2 2 0 0 1 2 2v5.5a1.5 1.5 0 0 0 3 0V9l-2.5-2.5" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-app">
                Golden Bear Gas
              </h2>
              <p className="text-xs text-muted">Your role: owner</p>
            </div>
          </div>
          <span className={cn(CHIP_BASE, GREEN_CHIP)}>Active</span>
        </div>

        {/* Quick-links row — non-interactive, styled to read as links */}
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-app pt-3">
          {QUICK_LINKS.map((label, i) => (
            <span key={label} className="flex items-center gap-x-3">
              {i > 0 && (
                <span aria-hidden="true" className="text-muted/50">
                  ·
                </span>
              )}
              <span className="text-sm font-medium text-flush-600">{label}</span>
            </span>
          ))}
        </nav>

        {/* Claimed locations */}
        <ul className="flex flex-col gap-2">
          {LOCATIONS.map((loc) => (
            <li
              key={loc.name}
              className="flex items-center gap-3 rounded-xl border border-app bg-surface px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-app">{loc.name}</p>
                <p className="truncate text-xs text-muted">{loc.address}</p>
              </div>
              <span
                className={cn(
                  CHIP_BASE,
                  loc.status === 'Verified' ? GREEN_CHIP : AMBER_CHIP,
                )}
              >
                {loc.status}
              </span>
              <span className="shrink-0 text-sm font-medium text-muted">Manage</span>
            </li>
          ))}
        </ul>
      </section>
    </PreviewFrame>
  );
}
