// Static marketing mockup of the business analytics dashboard. Hard-coded fake
// data only — no fetching, no props — mirroring the real BusinessAnalytics
// layout (KPI tiles + a ranked bar list) so the public page can show it off.
import { cn } from '@/lib/cn';
import { Stars } from '@/components/ui/Stars';
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';

const KPIS: { label: string; value: string }[] = [
  { label: 'Verified listings', value: '6' },
  { label: 'Total reviews', value: '312' },
  { label: 'Avg rating', value: '4.6' },
  { label: 'Awaiting reviews', value: '1' },
];

const LOCATIONS: { name: string; rating: number; reviews: number }[] = [
  { name: 'Bakersfield', rating: 4.8, reviews: 96 },
  { name: 'Sacramento', rating: 4.6, reviews: 74 },
  { name: 'San Diego', rating: 4.4, reviews: 58 },
  { name: 'Barstow', rating: 4.1, reviews: 41 },
];

export function AnalyticsPreview() {
  return (
    <PreviewFrame title="Analytics">
      <div className="flex flex-col gap-5">
        <header>
          <h3 className="text-base font-bold text-app">Golden Bear Gas</h3>
          <p className="mt-0.5 text-xs text-muted">
            Review performance across your verified listings.
          </p>
        </header>

        {/* KPI tile grid */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {KPIS.map((kpi) => (
            <div
              key={kpi.label}
              className="flex flex-col gap-1 rounded-xl border border-app bg-raised p-3"
            >
              <span className="text-[0.65rem] font-medium uppercase tracking-wide text-muted">
                {kpi.label}
              </span>
              <span className="text-xl font-bold text-app">{kpi.value}</span>
            </div>
          ))}
        </div>

        {/* Ranked rating bars, best first */}
        <div className="flex flex-col gap-2.5">
          <h4 className="text-xs font-semibold text-app">Listings by rating</h4>
          <ul className="flex flex-col gap-2.5">
            {LOCATIONS.map((loc, i) => {
              const isBest = i === 0;
              return (
                <li
                  key={loc.name}
                  className={cn(
                    'flex flex-col gap-2 rounded-xl border bg-raised p-3',
                    isBest ? 'border-flush-500' : 'border-app',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-app">
                      {loc.name}
                    </span>
                    <div className="flex items-center gap-2">
                      {isBest && (
                        <span className="rounded-full bg-flush-500/10 px-2 py-0.5 text-[0.7rem] font-medium text-flush-600">
                          Top rated
                        </span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <Stars value={loc.rating} size={13} />
                        <span className="text-sm font-semibold text-app">
                          {loc.rating.toFixed(1)}
                        </span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div
                      className="h-2 flex-1 overflow-hidden rounded-full bg-sunken"
                      role="img"
                      aria-label={`${loc.rating.toFixed(1)} out of 5`}
                    >
                      <div
                        className="h-full rounded-full bg-flush-500"
                        style={{ width: `${(loc.rating / 5) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-xs text-muted">
                      ({loc.reviews})
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Teaser for the paid analytics add-on */}
        <div className="rounded-xl border border-dashed border-app bg-sunken p-4">
          <p className="text-xs text-muted">
            Coming with the full plan: listing impressions, &ldquo;near me&rdquo;
            appearances, and direction taps.
          </p>
        </div>
      </div>
    </PreviewFrame>
  );
}
