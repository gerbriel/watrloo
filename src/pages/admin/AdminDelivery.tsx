import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listGrowthSettings,
  listPlacements,
  setGrowthSetting,
  updatePlacementDelivery,
} from '@/lib/api/adminOps';
import type { AdminPlacement, GrowthSetting, GrowthSettingKey } from '@/lib/api/adminOps';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

const SETTINGS_KEY = ['admin', 'growthSettings'] as const;
const PLACEMENTS_KEY = ['admin', 'placements'] as const;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Surface the server's message (RPC validation errors are the useful ones). */
function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** growth_settings values are jsonb; only trust numbers that are numbers. */
function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

// --- Delivery control panel ---------------------------------------------------

export function AdminDelivery() {
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: listGrowthSettings });
  const placements = useQuery({ queryKey: PLACEMENTS_KEY, queryFn: listPlacements });

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4" aria-label="Delivery settings">
        <h2 className="text-lg font-semibold text-app">Settings</h2>
        {settings.isPending ? (
          <p className="text-sm text-muted">Loading settings…</p>
        ) : settings.isError ? (
          <LoadError
            message={errMsg(settings.error, 'Could not load settings.')}
            onRetry={() => void settings.refetch()}
          />
        ) : settings.data.length === 0 ? (
          <p className="text-sm text-muted">No growth settings found.</p>
        ) : (
          <SettingsPanel settings={settings.data} />
        )}
      </section>

      <section className="flex flex-col gap-4" aria-label="Placements">
        <h2 className="text-lg font-semibold text-app">Placements</h2>
        {placements.isPending ? (
          <p className="text-sm text-muted">Loading placements…</p>
        ) : placements.isError ? (
          <LoadError
            message={errMsg(placements.error, 'Could not load placements.')}
            onRetry={() => void placements.refetch()}
          />
        ) : (
          <PlacementsPanel placements={placements.data} />
        )}
      </section>

      <p className="text-xs text-muted">Every change here is written to the audit log.</p>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-red-500">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

// --- Settings -------------------------------------------------------------------

const NUMERIC_SETTINGS: { key: GrowthSettingKey; label: string; hint: string }[] = [
  {
    key: 'ad_frequency_cap_per_day',
    label: 'Ad frequency cap / day',
    hint: 'Most promoted impressions one visitor sees per day.',
  },
  {
    key: 'k_anonymity_floor',
    label: 'k-anonymity floor',
    hint: 'Smallest cohort before advertisers see any stats.',
  },
  {
    key: 'promo_global_cap_per_week',
    label: 'Promo messages / week (global)',
    hint: 'Most promo messages a user gets per week, all advertisers combined.',
  },
  {
    key: 'promo_advertiser_cap_per_week',
    label: 'Promo messages / week (per advertiser)',
    hint: 'Most promo messages one advertiser can send a user per week.',
  },
];

function SettingsPanel({ settings }: { settings: GrowthSetting[] }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: ({ key, value }: { key: GrowthSettingKey; value: unknown }) =>
      setGrowthSetting(key, value),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });

  const byKey = new Map(settings.map((s) => [s.key, s]));
  const busyFor = (key: GrowthSettingKey) => save.isPending && save.variables?.key === key;
  const errorFor = (key: GrowthSettingKey) =>
    save.isError && save.variables?.key === key
      ? errMsg(save.error, 'Could not save this setting.')
      : undefined;

  const featured = byKey.get('featured_capacity');

  return (
    <div className="flex flex-col gap-4">
      <KillSwitchCard
        setting={byKey.get('promotions_enabled')}
        busy={busyFor('promotions_enabled')}
        disabled={save.isPending}
        error={errorFor('promotions_enabled')}
        onToggle={(enabled) => save.mutate({ key: 'promotions_enabled', value: enabled })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <FeaturedCapacityCard
          key={featured?.updated_at ?? 'featured_capacity'}
          setting={featured}
          busy={busyFor('featured_capacity')}
          disabled={save.isPending}
          error={errorFor('featured_capacity')}
          onSave={(value) => save.mutate({ key: 'featured_capacity', value })}
        />
        {NUMERIC_SETTINGS.map((cfg) => {
          const s = byKey.get(cfg.key);
          return (
            <NumberSettingCard
              key={`${cfg.key}:${s?.updated_at ?? ''}`}
              label={cfg.label}
              hint={cfg.hint}
              value={asInt(s?.value)}
              updatedAt={s?.updated_at}
              busy={busyFor(cfg.key)}
              disabled={save.isPending}
              error={errorFor(cfg.key)}
              onSave={(n) => save.mutate({ key: cfg.key, value: n })}
            />
          );
        })}
      </div>
    </div>
  );
}

function KillSwitchCard({
  setting,
  busy,
  disabled,
  error,
  onToggle,
}: {
  setting: GrowthSetting | undefined;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onToggle: (enabled: boolean) => void;
}) {
  const live = setting?.value === true;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-5',
        live ? 'border-green-600/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            All promotions
          </p>
          <p
            className={cn(
              'text-3xl font-bold tracking-tight',
              live ? 'text-green-600' : 'text-red-500',
            )}
          >
            {live ? 'LIVE' : 'PAUSED'}
          </p>
          <p className="text-sm text-muted">
            {live
              ? 'Featured slots and promoted placements are serving.'
              : 'Nothing promoted is serving, anywhere.'}
          </p>
        </div>
        {live ? (
          <Button
            variant="danger"
            loading={busy}
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  'Pause ALL promotions? Featured slots and promoted placements stop serving immediately, everywhere.',
                )
              ) {
                onToggle(false);
              }
            }}
          >
            Pause all promotions
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="bg-green-600 text-white shadow-lg shadow-green-600/20 hover:bg-green-500"
            loading={busy}
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  'Resume promotions? Featured slots and promoted placements start serving again immediately.',
                )
              ) {
                onToggle(true);
              }
            }}
          >
            Resume promotions
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {setting && <p className="text-xs text-muted">Updated {fmtDateTime(setting.updated_at)}</p>}
    </div>
  );
}

const SURFACES = ['browse', 'map', 'detail'] as const;
type Surface = (typeof SURFACES)[number];
const SURFACE_LABELS: Record<Surface, string> = {
  browse: 'Browse',
  map: 'Map',
  detail: 'Detail',
};

function FeaturedCapacityCard({
  setting,
  busy,
  disabled,
  error,
  onSave,
}: {
  setting: GrowthSetting | undefined;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onSave: (value: Record<string, number>) => void;
}) {
  const current: Record<string, unknown> =
    setting && typeof setting.value === 'object' && setting.value !== null && !Array.isArray(setting.value)
      ? (setting.value as Record<string, unknown>)
      : {};
  const [drafts, setDrafts] = useState<Record<Surface, string>>(() => ({
    browse: String(asInt(current.browse) ?? 0),
    map: String(asInt(current.map) ?? 0),
    detail: String(asInt(current.detail) ?? 0),
  }));
  const [localError, setLocalError] = useState<string>();

  const handleSave = () => {
    // Start from the stored object so surfaces we don't edit (e.g. newsletter)
    // survive the round trip.
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(current)) {
      const n = asInt(v);
      if (n !== null) next[k] = n;
    }
    for (const s of SURFACES) {
      const n = Number.parseInt(drafts[s], 10);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        setLocalError('Each surface takes a whole number from 0 to 10.');
        return;
      }
      next[s] = n;
    }
    setLocalError(undefined);
    onSave(next);
  };

  const shownError = localError ?? error;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex items-end gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">
          {SURFACES.map((s) => (
            <Input
              key={s}
              label={SURFACE_LABELS[s]}
              type="number"
              min={0}
              max={10}
              inputMode="numeric"
              value={drafts[s]}
              onChange={(e) => {
                setDrafts((d) => ({ ...d, [s]: e.target.value }));
                setLocalError(undefined);
              }}
            />
          ))}
        </div>
        <Button variant="secondary" loading={busy} disabled={disabled} onClick={handleSave}>
          Save
        </Button>
      </div>
      {shownError && (
        <p role="alert" className="text-xs text-red-500">
          {shownError}
        </p>
      )}
      <p className="text-xs text-muted">
        Featured slots per surface (0–10)
        {setting ? ` · Updated ${fmtDateTime(setting.updated_at)}` : ''}
      </p>
    </div>
  );
}

function NumberSettingCard({
  label,
  hint,
  value,
  updatedAt,
  busy,
  disabled,
  error,
  onSave,
}: {
  label: string;
  hint: string;
  value: number | null;
  updatedAt?: string;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onSave: (n: number) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [localError, setLocalError] = useState<string>();

  const handleSave = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      setLocalError('Enter a whole number from 1 to 1000.');
      return;
    }
    setLocalError(undefined);
    onSave(n);
  };

  const shownError = localError ?? error;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            label={label}
            type="number"
            min={1}
            max={1000}
            inputMode="numeric"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setLocalError(undefined);
            }}
          />
        </div>
        <Button variant="secondary" loading={busy} disabled={disabled} onClick={handleSave}>
          Save
        </Button>
      </div>
      {shownError && (
        <p role="alert" className="text-xs text-red-500">
          {shownError}
        </p>
      )}
      <p className="text-xs text-muted">
        {hint}
        {updatedAt ? ` · Updated ${fmtDateTime(updatedAt)}` : ''}
      </p>
    </div>
  );
}

// --- Placements -------------------------------------------------------------------

const STATUS_CHIP: Record<string, string> = {
  running: 'bg-green-500/15 text-green-600',
  approved: 'bg-green-500/15 text-green-600',
  pending: 'bg-amber-500/15 text-amber-600',
  paused: 'bg-amber-500/15 text-amber-600',
  rejected: 'bg-red-500/10 text-red-500',
  ended: 'bg-sunken text-muted',
};

function PlacementsPanel({ placements }: { placements: AdminPlacement[] }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: { placementId: string; weight: number; dailyCap: number | null }) =>
      updatePlacementDelivery(v.placementId, v.weight, v.dailyCap),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PLACEMENTS_KEY }),
  });

  if (placements.length === 0) {
    return (
      <p className="text-sm text-muted">
        No placements yet — approved campaign placements will show up here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {placements.map((p) => (
        <PlacementRow
          // Server values in the key: a refetch with new numbers re-seeds the drafts.
          key={`${p.placement_id}:${p.weight}:${p.daily_impression_cap ?? 'none'}`}
          placement={p}
          busy={save.isPending && save.variables?.placementId === p.placement_id}
          disabled={save.isPending}
          error={
            save.isError && save.variables?.placementId === p.placement_id
              ? errMsg(save.error, 'Could not save delivery settings.')
              : undefined
          }
          onSave={(weight, dailyCap) =>
            save.mutate({ placementId: p.placement_id, weight, dailyCap })
          }
        />
      ))}
    </ul>
  );
}

function PlacementRow({
  placement: p,
  busy,
  disabled,
  error,
  onSave,
}: {
  placement: AdminPlacement;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onSave: (weight: number, dailyCap: number | null) => void;
}) {
  const [weight, setWeight] = useState(String(p.weight));
  const [cap, setCap] = useState(
    p.daily_impression_cap === null ? '' : String(p.daily_impression_cap),
  );
  const [localError, setLocalError] = useState<string>();

  const handleSave = () => {
    const w = Number.parseInt(weight, 10);
    if (!Number.isInteger(w) || w < 1 || w > 10000) {
      setLocalError('Weight must be a whole number from 1 to 10000.');
      return;
    }
    let c: number | null = null;
    if (cap.trim() !== '') {
      c = Number.parseInt(cap, 10);
      if (!Number.isInteger(c) || c < 1) {
        setLocalError('Daily cap must be a whole number of at least 1, or blank for no cap.');
        return;
      }
    }
    setLocalError(undefined);
    onSave(w, c);
  };

  // Pacing against the SAVED cap (not the draft) — that's what delivery uses.
  const savedCap = p.daily_impression_cap;
  const hasPacing = savedCap !== null && savedCap > 0;
  const pct = hasPacing ? Math.min(100, (p.delivered_today / savedCap) * 100) : 0;
  const hot = hasPacing && p.delivered_today >= savedCap * 0.9;

  const shownError = localError ?? error;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-app">
          <span className="font-medium">{p.campaign_title}</span>{' '}
          <span className="text-muted">· {p.business_name}</span>
        </p>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            STATUS_CHIP[p.campaign_status] ?? 'bg-sunken text-muted',
          )}
        >
          {p.campaign_status}
        </span>
      </div>

      <p className="text-xs text-muted">
        {p.surface} · {p.region ?? 'everywhere'} · {fmtDate(p.starts_at)} → {fmtDate(p.ends_at)}
      </p>

      {hasPacing && (
        <div className="flex items-center gap-2">
          <div aria-hidden="true" className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken">
            <div
              className={cn('h-full rounded-full', hot ? 'bg-amber-500' : 'bg-flush-500')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              hot ? 'font-medium text-amber-600' : 'text-muted',
            )}
          >
            {p.delivered_today.toLocaleString()} / {savedCap.toLocaleString()} today
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-28">
          <Input
            label="Weight"
            type="number"
            min={1}
            max={10000}
            inputMode="numeric"
            value={weight}
            onChange={(e) => {
              setWeight(e.target.value);
              setLocalError(undefined);
            }}
          />
        </div>
        <div className="w-32">
          <Input
            label="Daily cap"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="No cap"
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              setLocalError(undefined);
            }}
          />
        </div>
        <Button variant="secondary" loading={busy} disabled={disabled} onClick={handleSave}>
          Save
        </Button>
      </div>
      {shownError && (
        <p role="alert" className="text-xs text-red-500">
          {shownError}
        </p>
      )}
    </li>
  );
}
