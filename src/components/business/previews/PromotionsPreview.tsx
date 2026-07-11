// AGENT UNIT — implement per instructions. Preserve the export name.
// Static marketing mockup of the (upcoming) promotions / coupons feature: an
// advertiser option that turns nearby "find a bathroom" searches into foot
// traffic. Pure JSX — no data, no props, no fetching.
import { cn } from '@/lib/cn';
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';

const ICONS = {
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-6.2-6.2A2 2 0 0 1 4 13V5a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.6zM7.5 7.5h.01',
  clock: 'M12 8v4l2.5 2.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
} as const;

/** Small inline icon — no icon dependency, mirrors ForBusiness.tsx. */
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

/** A single promotion tile — echoes the "Free coffee" tile on ForBusiness. */
function PromoCard({
  icon,
  title,
  meta,
  stat,
}: {
  icon: string;
  title: string;
  meta: string;
  stat: string;
}) {
  return (
    <div className={cn('rounded-xl border border-app bg-sunken p-4')}>
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-flush-500/15 to-cyan-500/15 text-flush-500 ring-1 ring-flush-500/20">
          <Icon path={icon} className="size-4" />
        </span>
        <p className="text-sm font-medium text-app">{title}</p>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{meta}</p>
        <span className="shrink-0 text-[0.7rem] font-medium text-flush-500">
          {stat}
        </span>
      </div>
    </div>
  );
}

export function PromotionsPreview() {
  return (
    <PreviewFrame title="Promotions">
      <div className="flex flex-col gap-4">
        {/* Title + upcoming marker */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-flush-500/15 to-cyan-500/15 text-flush-500 ring-1 ring-flush-500/20">
              <Icon path={ICONS.tag} className="size-4" />
            </span>
            <p className="font-display text-sm font-semibold text-app">
              Promotions &amp; coupons
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-app bg-raised px-2.5 py-1 text-[0.7rem] font-medium text-muted">
            <span className="size-1.5 rounded-full bg-flush-500" aria-hidden="true" />
            Coming soon
          </span>
        </div>

        {/* Example promotions */}
        <div className="flex flex-col gap-3">
          <PromoCard
            icon={ICONS.tag}
            title="Free coffee with any fill-up"
            meta="Live promotion · shown to nearby searchers"
            stat="Redeemed 143 times"
          />
          <PromoCard
            icon={ICONS.clock}
            title="$2 off a car wash — weekday mornings"
            meta="Live promotion · shown to nearby searchers"
            stat="Redeemed 58 times"
          />
        </div>

        {/* One-line pitch */}
        <div className="rounded-xl border border-app bg-gradient-to-br from-flush-500/10 to-cyan-500/10 p-4">
          <p className="text-sm font-medium text-app">
            Turn nearby “find a bathroom” searches into paying customers.
          </p>
        </div>
      </div>
    </PreviewFrame>
  );
}
