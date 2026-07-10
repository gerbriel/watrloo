// AGENT UNIT — implemented per instructions. Preserve the export name.
// A STATIC, hard-coded marketing mockup of the CSV bulk-import preview/confirm
// step — the headline feature for chains. No data fetching, no props, no real
// file input: pure presentational JSX with fake data that mirrors the real
// wizard at src/pages/business/CsvImport.tsx.
import { PreviewFrame } from '@/components/business/previews/PreviewFrame';
import { cn } from '@/lib/cn';

const CHIP_BASE = 'inline-block rounded-full px-2 py-0.5 text-xs font-medium';
const FLUSH_CHIP = 'bg-flush-500/15 text-flush-600';
const GREEN_CHIP = 'bg-green-500/15 text-green-600';

type Plan = 'create' | 'claim';

type Tile = {
  label: string;
  count: number;
  className: string;
};

const TILES: Tile[] = [
  { label: 'Create new', count: 4, className: 'bg-flush-500/10 text-flush-600' },
  { label: 'Claim existing', count: 2, className: 'bg-green-500/10 text-green-600' },
  { label: 'Skipped', count: 0, className: 'bg-amber-500/10 text-amber-600' },
];

type Row = {
  name: string;
  address: string;
  plan: Plan;
};

const ROWS: Row[] = [
  { name: 'Bean & Bar — Clovis', address: '123 Pollasky Ave', plan: 'create' },
  { name: 'Bean & Bar — River Park', address: '71 E Nees Ave', plan: 'claim' },
  { name: 'Bean & Bar — Tower District', address: '815 E Olive Ave', plan: 'create' },
  { name: 'Bean & Bar — Old Town Clovis', address: '456 Clovis Ave', plan: 'create' },
  { name: 'Bean & Bar — Fig Garden', address: '5088 N Palm Ave', plan: 'claim' },
  { name: 'Bean & Bar — Downtown Fresno', address: '2100 Kern St', plan: 'create' },
];

export function CsvImportPreview() {
  return (
    <PreviewFrame title="Bulk import a chain">
      <section className="flex flex-col gap-4">
        {/* Header line */}
        <div className="flex items-center gap-2">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-5 shrink-0 text-muted"
          >
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
            <path d="M9 13h6M9 17h6" />
          </svg>
          <p className="text-sm text-app">
            <span className="font-semibold">6 locations</span>
            <span className="text-muted"> parsed from </span>
            <span className="font-medium">locations.csv</span>
          </p>
        </div>

        {/* Count tiles */}
        <div className="grid grid-cols-3 gap-3">
          {TILES.map((tile) => (
            <div
              key={tile.label}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-xl border border-app p-3 text-center',
                tile.className,
              )}
            >
              <span className="text-2xl font-semibold leading-none">{tile.count}</span>
              <span className="text-xs font-medium">{tile.label}</span>
            </div>
          ))}
        </div>

        {/* Preview table */}
        <div className="overflow-x-auto rounded-xl border border-app">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="bg-raised text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Address</th>
                <th className="px-3 py-2 font-medium">Plan</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.name} className="border-t border-app">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-app">
                    {row.name}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">
                    {row.address}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        CHIP_BASE,
                        row.plan === 'create' ? FLUSH_CHIP : GREEN_CHIP,
                      )}
                    >
                      {row.plan === 'create' ? 'Create' : 'Claim existing'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Primary CTA — non-interactive mockup */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={cn(
            'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium',
            'bg-gradient-to-b from-flush-500 to-flush-600 text-white shadow-lg shadow-flush-600/25',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Import 6 locations
        </button>
      </section>
    </PreviewFrame>
  );
}
