import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyBusiness, NewBathroom } from '@/types/db';
import {
  createBathroom,
  fileClaim,
  listMyBusinesses,
  nearbyBathrooms,
} from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

// --- CSV parsing ------------------------------------------------------------

/** How close a row must be to an existing listing before we treat it as a match. */
const DEDUP_RADIUS_M = 40;

/** The header we tell people to use, and validate against (case-insensitive). */
const EXPECTED_HEADER =
  'name,address,lat,lng,wheelchair_accessible,gender_neutral,changing_table,requires_key,description';

const REQUIRED_COLUMNS = ['name', 'address', 'lat', 'lng'] as const;

/**
 * A tolerant RFC-4180-ish parser: quoted fields may contain commas and
 * newlines, and a doubled quote ("") inside a quoted field is a literal quote.
 * Returns one string[] per record. We parse in-file to avoid a dependency.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    if (c === '\r') {
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush the final field/row (unless the file ended on a clean newline).
  if (field !== '' || row.length > 0) endRow();

  // Drop rows that are entirely blank (e.g. a trailing newline).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function truthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

interface ParsedRow {
  /** 1-based position among the data rows, for display. */
  line: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  description: string | null;
  wheelchair_accessible: boolean;
  gender_neutral: boolean;
  changing_table: boolean;
  requires_key: boolean;
  errors: string[];
}

interface ParseResult {
  rows: ParsedRow[];
  error: string | null;
}

function parseRows(text: string): ParseResult {
  if (text.trim() === '') return { rows: [], error: null };

  const records = parseCsv(text);
  if (records.length === 0) return { rows: [], error: null };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      error: `CSV is missing required column(s): ${missing.join(', ')}.`,
    };
  }

  const idx = (name: string) => header.indexOf(name);
  const cols = {
    name: idx('name'),
    address: idx('address'),
    lat: idx('lat'),
    lng: idx('lng'),
    wheelchair_accessible: idx('wheelchair_accessible'),
    gender_neutral: idx('gender_neutral'),
    changing_table: idx('changing_table'),
    requires_key: idx('requires_key'),
    description: idx('description'),
  };

  const at = (rec: string[], col: number) => (col >= 0 ? (rec[col] ?? '') : '');

  const rows = records.slice(1).map((rec, i): ParsedRow => {
    const name = at(rec, cols.name).trim();
    const address = at(rec, cols.address).trim();
    const latRaw = at(rec, cols.lat).trim();
    const lngRaw = at(rec, cols.lng).trim();
    const description = at(rec, cols.description).trim();
    const lat = Number(latRaw);
    const lng = Number(lngRaw);

    const errors: string[] = [];
    if (!name) errors.push('name is required');
    if (!address) errors.push('address is required');
    if (latRaw === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      errors.push('lat must be a number between -90 and 90');
    }
    if (lngRaw === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      errors.push('lng must be a number between -180 and 180');
    }

    return {
      line: i + 1,
      name,
      address,
      lat,
      lng,
      description: description ? description : null,
      wheelchair_accessible: truthy(at(rec, cols.wheelchair_accessible)),
      gender_neutral: truthy(at(rec, cols.gender_neutral)),
      changing_table: truthy(at(rec, cols.changing_table)),
      requires_key: truthy(at(rec, cols.requires_key)),
      errors,
    };
  });

  return { rows, error: null };
}

function toNewBathroom(row: ParsedRow): NewBathroom {
  return {
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    description: row.description,
    wheelchair_accessible: row.wheelchair_accessible,
    gender_neutral: row.gender_neutral,
    changing_table: row.changing_table,
    requires_key: row.requires_key,
  };
}

// --- Dedup preview ----------------------------------------------------------

type PreviewRow =
  | { kind: 'invalid'; row: ParsedRow }
  | { kind: 'create'; row: ParsedRow }
  | { kind: 'claim'; row: ParsedRow; matchId: string; matchLabel: string };

/** Look each valid row up against nearby listings to decide create vs. claim. */
async function buildPreview(rows: ParsedRow[]): Promise<PreviewRow[]> {
  const out: PreviewRow[] = [];
  for (const row of rows) {
    if (row.errors.length > 0) {
      out.push({ kind: 'invalid', row });
      continue;
    }
    try {
      const matches = await nearbyBathrooms(row.lat, row.lng, DEDUP_RADIUS_M);
      const match = matches[0];
      if (match) {
        out.push({
          kind: 'claim',
          row,
          matchId: match.id,
          matchLabel: `${match.name} — ${match.address}`,
        });
      } else {
        out.push({ kind: 'create', row });
      }
    } catch {
      // If the duplicate check itself fails we can't confirm a match; fall back
      // to creating a new listing. The user still reviews this before writing.
      out.push({ kind: 'create', row });
    }
  }
  return out;
}

// --- Import run -------------------------------------------------------------

interface RowResult {
  row: ParsedRow;
  outcome: 'created' | 'claimed' | 'failed';
  error?: string;
}

// --- UI ---------------------------------------------------------------------

type Step = 'pick' | 'input' | 'preview' | 'summary';

const STEPS: { key: Step; label: string }[] = [
  { key: 'pick', label: 'Pick business' },
  { key: 'input', label: 'Add CSV' },
  { key: 'preview', label: 'Preview' },
  { key: 'summary', label: 'Done' },
];

export function CsvImport() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>('pick');
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<RowResult[]>([]);

  const businessesQuery = useQuery({
    queryKey: queryKeys.myBusinesses(userId ?? ''),
    queryFn: () => listMyBusinesses(userId ?? ''),
    enabled: userId != null,
  });

  const manageable: MyBusiness[] = (businessesQuery.data ?? []).filter(
    (b) => b.role === 'owner' || b.role === 'manager',
  );
  const selectedBusiness = manageable.find((b) => b.id === businessId) ?? null;

  const parsed = useMemo(() => parseRows(csvText), [csvText]);
  const validCount = parsed.rows.filter((r) => r.errors.length === 0).length;
  const invalidRowCount = parsed.rows.length - validCount;

  const preview = useMutation({
    mutationFn: (rows: ParsedRow[]) => buildPreview(rows),
    onSuccess: (rows) => {
      setPreviewRows(rows);
      setStep('preview');
    },
  });

  const createCount = previewRows.filter((r) => r.kind === 'create').length;
  const claimCount = previewRows.filter((r) => r.kind === 'claim').length;
  const invalidCount = previewRows.filter((r) => r.kind === 'invalid').length;
  const actionable = previewRows.filter((r) => r.kind !== 'invalid');

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Allow re-selecting the same file later.
    e.target.value = '';
    if (!file) return;
    setCsvText(await file.text());
  }

  async function runImport() {
    if (userId == null || businessId == null) return;
    setRunning(true);
    setProgress(0);
    setResults([]);
    const acc: RowResult[] = [];
    for (const item of actionable) {
      try {
        if (item.kind === 'create') {
          const created = await createBathroom(toNewBathroom(item.row), userId);
          await fileClaim(created.id, businessId, userId);
          acc.push({ row: item.row, outcome: 'created' });
        } else {
          await fileClaim(item.matchId, businessId, userId);
          acc.push({ row: item.row, outcome: 'claimed' });
        }
      } catch (err) {
        acc.push({
          row: item.row,
          outcome: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
      setProgress(acc.length);
      setResults([...acc]);
    }
    void qc.invalidateQueries({ queryKey: queryKeys.businessListings(businessId) });
    void qc.invalidateQueries({ queryKey: ['bathrooms'] });
    setRunning(false);
    setStep('summary');
  }

  function reset() {
    setCsvText('');
    setPreviewRows([]);
    setResults([]);
    setProgress(0);
    setStep('input');
  }

  const createdTotal = results.filter((r) => r.outcome === 'created').length;
  const claimedTotal = results.filter((r) => r.outcome === 'claimed').length;
  const failedResults = results.filter((r) => r.outcome === 'failed');

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-app">Bulk import locations</h1>
        <p className="text-sm text-muted">
          Import a chain&apos;s bathrooms from a CSV and claim them for your business in
          one pass. Nothing is written until you confirm the preview.
        </p>
      </header>

      {/* Stepper */}
      <ol className="mb-8 flex flex-wrap gap-2">
        {STEPS.map((s, i) => {
          const current = s.key === step;
          const done = STEPS.findIndex((x) => x.key === step) > i;
          return (
            <li
              key={s.key}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                current && 'border-flush-500 bg-flush-500/10 text-flush-600',
                done && !current && 'border-app bg-raised text-app',
                !current && !done && 'border-app text-muted',
              )}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full text-[11px]',
                  current ? 'bg-flush-600 text-white' : 'bg-sunken text-muted',
                )}
              >
                {i + 1}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>

      {/* Step 1: pick a business */}
      {step === 'pick' && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium text-app">Which business?</h2>
          {businessesQuery.isPending && (
            <p className="text-sm text-muted">Loading your businesses…</p>
          )}
          {businessesQuery.isError && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-500">
                {businessesQuery.error instanceof Error
                  ? businessesQuery.error.message
                  : 'Could not load your businesses.'}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void businessesQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          )}
          {businessesQuery.isSuccess && manageable.length === 0 && (
            <p className="rounded-xl border border-app bg-raised p-4 text-sm text-muted">
              You need an owner or manager role on a business to import listings.
              Ask an owner to add you, or request business access first.
            </p>
          )}
          {manageable.length > 0 && (
            <>
              <ul className="flex flex-col gap-2">
                {manageable.map((b) => {
                  const active = b.id === businessId;
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => setBusinessId(b.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors',
                          active
                            ? 'border-flush-500 bg-flush-500/10'
                            : 'border-app bg-raised hover:border-strong',
                        )}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm font-medium text-app">{b.name}</span>
                          <span className="text-xs text-muted capitalize">{b.role}</span>
                        </span>
                        {active && (
                          <span className="text-xs font-medium text-flush-600">
                            Selected
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div>
                <Button
                  disabled={businessId == null}
                  onClick={() => setStep('input')}
                >
                  Continue
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Step 2: CSV input */}
      {step === 'input' && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium text-app">Add your CSV</h2>
            {selectedBusiness && (
              <p className="text-xs text-muted">
                Importing for{' '}
                <span className="font-medium text-app">{selectedBusiness.name}</span>
              </p>
            )}
          </div>

          <div className="rounded-xl border border-app bg-raised p-4">
            <p className="text-xs font-medium text-app">Expected header</p>
            <pre className="mt-1 overflow-x-auto text-xs text-muted">
              <code>{EXPECTED_HEADER}</code>
            </pre>
            <p className="mt-2 text-xs text-muted">
              Required: <span className="text-app">name, address, lat, lng</span>. The
              amenity columns and description are optional; amenity values count as true
              when they read <code>true</code>, <code>1</code>, or <code>yes</code>.
              lat/lng are required for now (address geocoding comes later).
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-app">Upload a file</span>
            <input
              type="file"
              accept=".csv"
              onChange={handleFile}
              className="text-sm text-app file:mr-3 file:rounded-lg file:border file:border-app file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-app hover:file:bg-sunken"
            />
          </div>

          <Textarea
            label="…or paste CSV"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className="font-mono text-xs"
            rows={8}
            placeholder={EXPECTED_HEADER}
          />

          {parsed.error && (
            <p role="alert" className="text-sm text-red-500">
              {parsed.error}
            </p>
          )}

          {!parsed.error && parsed.rows.length > 0 && (
            <div className="rounded-xl border border-app bg-raised p-4">
              <p className="text-sm text-app">
                Parsed <span className="font-medium">{parsed.rows.length}</span> row(s):{' '}
                <span className="text-flush-600">{validCount} valid</span>
                {invalidRowCount > 0 && (
                  <span className="text-amber-500"> · {invalidRowCount} invalid</span>
                )}
              </p>
              {invalidRowCount > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {parsed.rows
                    .filter((r) => r.errors.length > 0)
                    .map((r) => (
                      <li key={r.line} className="text-xs text-amber-500">
                        Row {r.line}: {r.errors.join('; ')}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          {preview.isError && (
            <p role="alert" className="text-sm text-red-500">
              {preview.error instanceof Error
                ? preview.error.message
                : 'Could not build the preview.'}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('pick')}>
              Back
            </Button>
            <Button
              loading={preview.isPending}
              disabled={validCount === 0}
              onClick={() =>
                preview.mutate(parsed.rows.filter((r) => r.errors.length === 0))
              }
            >
              Build preview
            </Button>
          </div>
        </section>
      )}

      {/* Step 3: dedup preview */}
      {step === 'preview' && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium text-app">Review before importing</h2>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-flush-600">{createCount}</p>
              <p className="text-xs text-muted">Create new</p>
            </div>
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-emerald-500">{claimCount}</p>
              <p className="text-xs text-muted">Claim existing</p>
            </div>
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-amber-500">{invalidCount}</p>
              <p className="text-xs text-muted">Skipped (invalid)</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-app">
            <table className="w-full text-left text-sm">
              <thead className="bg-raised text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((item) => (
                  <tr key={item.row.line} className="border-t border-app align-top">
                    <td className="px-3 py-2 text-muted">{item.row.line}</td>
                    <td className="px-3 py-2 text-app">{item.row.name || '—'}</td>
                    <td className="px-3 py-2 text-muted">{item.row.address || '—'}</td>
                    <td className="px-3 py-2">
                      {item.kind === 'create' && (
                        <span className="text-flush-600">Create new</span>
                      )}
                      {item.kind === 'claim' && (
                        <span className="flex flex-col">
                          <span className="text-emerald-500">Claim existing</span>
                          <span className="text-xs text-muted">{item.matchLabel}</span>
                        </span>
                      )}
                      {item.kind === 'invalid' && (
                        <span className="flex flex-col">
                          <span className="text-amber-500">Skip</span>
                          <span className="text-xs text-muted">
                            {item.row.errors.join('; ')}
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {running && (
            <p role="status" className="text-sm text-muted">
              Importing… {progress} of {actionable.length}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={running}
              onClick={() => setStep('input')}
            >
              Back
            </Button>
            <Button
              loading={running}
              disabled={actionable.length === 0}
              onClick={() => void runImport()}
            >
              Confirm import ({actionable.length})
            </Button>
          </div>
        </section>
      )}

      {/* Step 4: summary */}
      {step === 'summary' && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium text-app">Import complete</h2>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-flush-600">{createdTotal}</p>
              <p className="text-xs text-muted">Created</p>
            </div>
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-emerald-500">{claimedTotal}</p>
              <p className="text-xs text-muted">Claimed</p>
            </div>
            <div className="rounded-xl border border-app bg-raised p-4 text-center">
              <p className="text-2xl font-semibold text-red-500">
                {failedResults.length}
              </p>
              <p className="text-xs text-muted">Failed</p>
            </div>
          </div>

          <p className="text-xs text-muted">
            Claims are filed as pending — an admin verifies them before your business
            takes control of each listing.
          </p>

          {failedResults.length > 0 && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
              <p className="text-sm font-medium text-app">Failed rows</p>
              <ul className="mt-2 flex flex-col gap-1">
                {failedResults.map((r) => (
                  <li key={r.row.line} className="text-xs text-red-500">
                    Row {r.row.line} ({r.row.name || 'unnamed'}): {r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={reset}>Import another CSV</Button>
          </div>
        </section>
      )}
    </div>
  );
}
