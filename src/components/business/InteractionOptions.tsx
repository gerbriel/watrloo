import { cn } from '@/lib/cn';

/** Small inline icons — no icon dependency, no emoji. Mirrors Landing.tsx. */
function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'size-5'}
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  claim: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4',
  edit: 'M4 20h4L18 10a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  reply: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V6z',
  upload: 'M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6 6 0 0 1 12 0M17 5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-4.9',
  analytics: 'M3 3v18h18M7 15l3-4 3 2 4-6',
  sponsor:
    'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 22l-5.2-2.7 1-5.8-4.3-4.1 5.9-.9z',
  promo: 'M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01',
} as const;

type Capability = {
  icon: string;
  title: string;
  body: string;
  soon?: boolean;
};

const CAPABILITIES: Capability[] = [
  {
    icon: ICONS.claim,
    title: 'Claim your locations',
    body: 'Verify ownership and get the Official badge on your listings.',
  },
  {
    icon: ICONS.edit,
    title: 'Edit listing facts',
    body: 'Keep name, address, hours, and amenities accurate.',
  },
  {
    icon: ICONS.reply,
    title: 'Respond to reviews',
    body: "Reply publicly — you can't edit or delete reviews.",
  },
  {
    icon: ICONS.upload,
    title: 'Bulk-import a chain',
    body: 'Upload a CSV to create or claim many locations at once.',
  },
  {
    icon: ICONS.team,
    title: 'Invite your team',
    body: 'Owners, managers, and staff with scoped access.',
  },
  {
    icon: ICONS.analytics,
    title: 'See analytics',
    body: 'Ratings and review trends across your locations.',
  },
  {
    icon: ICONS.sponsor,
    title: 'Sponsored placement',
    body: 'Feature your listings above the rest.',
    soon: true,
  },
  {
    icon: ICONS.promo,
    title: 'Promotions & coupons',
    body: 'Drive foot traffic with in-listing offers.',
    soon: true,
  },
];

export function InteractionOptions() {
  return (
    <section className="flex flex-col gap-10">
      <div className="max-w-2xl">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-app bg-raised px-3 py-1 text-xs font-medium text-muted">
          <Icon path={ICONS.claim} className="size-3.5 text-flush-500" />
          For businesses
        </span>
        <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-app">
          What you can do once you&rsquo;re approved
        </h2>
        <p className="mt-3 text-lg text-muted">
          Approval unlocks a full toolkit for managing how your places show up on
          Watrloo — from claiming listings to answering the people who review them.
        </p>
      </div>

      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map((c) => (
          <li
            key={c.title}
            className={cn(
              'card card-hover flex flex-col gap-3 p-6',
              c.soon && 'border-dashed',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-flush-600/10 text-flush-600 ring-1 ring-flush-500/20">
                <Icon path={c.icon} />
              </span>
              {c.soon && (
                <span className="rounded-full border border-app bg-sunken px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-muted">
                  Soon
                </span>
              )}
            </div>
            <h3 className="font-display text-lg font-semibold text-app">
              {c.title}
            </h3>
            <p className="text-sm leading-relaxed text-muted">{c.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
