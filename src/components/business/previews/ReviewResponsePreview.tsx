// AGENT UNIT — implement per instructions. Preserve the export name.
// Static marketing mockup: a customer review with the business's public
// response nested beneath it. Hard-coded fake data only — no fetching.
import { Stars } from '@/components/ui/Stars';
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
import { cn } from '@/lib/cn';

export function ReviewResponsePreview() {
  return (
    <PreviewFrame title="Respond to reviews">
      {/* Review card — mirrors ReviewCard's chrome */}
      <article className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium text-app">@marisol_f</span>
          <span className="shrink-0 text-xs text-muted">2d ago</span>
        </div>

        <div className="flex items-center gap-2">
          <Stars value={4} size={16} />
          <span className="text-sm font-medium text-app">4.0</span>
        </div>

        <p className="text-sm text-app">
          Surprisingly clean for a highway stop, but the changing table was out
          of supplies on Sunday.
        </p>

        {/* Official reply — mirrors OwnerResponse's nested card */}
        <div
          className={cn(
            'ml-2 border-l-2 border-flush-500 rounded-lg bg-sunken pl-3 pr-3 py-2',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-bold text-app">
              Response from Golden Bear Gas
            </span>
            <span className="shrink-0 text-xs text-muted">1d ago</span>
          </div>
          <p className="mt-1 text-sm text-app">
            Thanks Marisol — we&rsquo;ve restocked and added a midday check.
            Safe travels!
          </p>
        </div>
      </article>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <svg
          viewBox="0 0 20 20"
          className="size-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" />
          <circle cx="10" cy="10" r="2.2" />
        </svg>
        Your reply is shown publicly under the review.
      </p>
    </PreviewFrame>
  );
}
