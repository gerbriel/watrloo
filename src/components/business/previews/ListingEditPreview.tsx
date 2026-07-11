// AGENT UNIT — implemented per instructions. Preserve the export name.
// A STATIC, hard-coded marketing mockup of the "edit your listing's facts"
// screen. No data fetching, props, or real form state — pure presentational
// JSX that mirrors the real FactsForm at src/pages/business/ListingManage.tsx.
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
import { cn } from '@/lib/cn';

// The shared control look from src/components/ui/Field.tsx, inlined so this
// mock stays self-contained and reads exactly like a real input.
const FIELD = 'w-full rounded-lg border border-app bg-surface px-3 py-2 text-app';
const LABEL = 'text-sm font-medium text-app';

type Amenity = { label: string; checked: boolean };

// Mirrors AMENITY_LABELS in src/types/db.ts. Two are on, two are off.
const AMENITIES: Amenity[] = [
  { label: 'Wheelchair accessible', checked: true },
  { label: 'Gender neutral', checked: false },
  { label: 'Changing table', checked: true },
  { label: 'Requires a key', checked: true },
];

function CheckMark({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-6.5" />
    </svg>
  );
}

export function ListingEditPreview() {
  return (
    <PreviewFrame title="Edit listing">
      {/* Static facts form — labelled, read-only, does nothing when touched. */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>Name</span>
          <input
            className={FIELD}
            defaultValue={'Golden Bear Gas — Bakersfield'}
            readOnly
            aria-label="Name"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>Address</span>
          <input
            className={FIELD}
            defaultValue={'2400 Golden State Hwy, Bakersfield, CA 93308'}
            readOnly
            aria-label="Address"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>Description</span>
          <div className={cn(FIELD, 'min-h-24 text-sm leading-relaxed')}>
            24-hour station right off CA-99. Restrooms around the side — ask
            the cashier for the key. Cleaned every shift and stocked daily.
          </div>
        </div>

        {/* Amenities — custom-styled checkboxes so checked/unchecked read
            crisply without a disabled control's dimming. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-app">Amenities</legend>
          {AMENITIES.map((a) => (
            <div key={a.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded border',
                  a.checked
                    ? 'border-flush-600 bg-flush-600 text-white'
                    : 'border-app bg-surface',
                )}
              >
                {a.checked && <CheckMark className="size-3" />}
              </span>
              <span className="text-sm text-app select-none">{a.label}</span>
            </div>
          ))}
        </fieldset>

        {/* Footer: primary Save + green saved state, mirroring FactsForm. */}
        <div className="flex items-center gap-3 border-t border-app pt-4">
          <button
            type="button"
            className={cn(
              'inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium',
              'bg-gradient-to-b from-flush-500 to-flush-600 text-white',
              'shadow-lg shadow-flush-600/25',
            )}
          >
            Save changes
          </button>
          <span
            role="status"
            className="flex items-center gap-1 text-sm font-medium text-green-600"
          >
            <CheckMark className="size-4" />
            Saved
          </span>
        </div>

        {/* Trust rule: facts are owner-editable, reviews never are. */}
        <p className="text-xs text-muted">
          You control your listing&rsquo;s facts. Reviews are never editable.
        </p>
      </div>
    </PreviewFrame>
  );
}
