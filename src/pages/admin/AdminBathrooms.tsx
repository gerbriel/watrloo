import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  bulkRestoreBathrooms,
  bulkSetAttribute,
  bulkSoftDeleteBathrooms,
  listBathroomsForModeration,
  restoreBathroom,
  softDeleteBathroom,
} from '@/lib/api/moderation';
import { listAttributeDefs } from '@/lib/api/attributes';
import { assignBathrooms, myAssignedBathrooms } from '@/lib/api/moderation';
import { searchUsers } from '@/lib/api/adminDirectory';
import { useAuth } from '@/auth/AuthProvider';
import { decideBathroomEdit, listEditRequests } from '@/lib/api/contributions';
import type { EditRequestWithContext } from '@/lib/api/contributions';
import { hardDeleteBathroom } from '@/lib/api/appeals';
import { updateBathroom } from '@/lib/api/bathrooms';
import { geocodeAddress, GEOCODE_ATTRIBUTION } from '@/lib/geocode';
import type { GeocodeCandidate } from '@/lib/geocode';
import { queryKeys } from '@/lib/queryClient';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import type { Amenities, Bathroom, NewBathroom } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';

const EDIT_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  address: 'Address',
  description: 'Description',
  wheelchair_accessible: 'Wheelchair accessible',
  gender_neutral: 'Gender neutral',
  changing_table: 'Changing table',
  requires_key: 'Requires a key',
};

/** Creator-suggested edits awaiting admin approval, rendered as diffs. */
function EditRequestsQueue() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'editRequests'],
    queryFn: () => listEditRequests('open'),
  });

  const decide = useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
      decideBathroomEdit(id, approve, note),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'editRequests'] });
      void qc.invalidateQueries({ queryKey: queryKeys.adminBathrooms() });
      void qc.invalidateQueries({ queryKey: ['bathrooms'] });
    },
  });

  if (!data || data.length === 0) return null;

  function diffRows(r: EditRequestWithContext): [string, string, string][] {
    const rows: [string, string, string][] = [];
    const current: Record<string, unknown> = r.bathroom ?? {};
    for (const [key, proposed] of Object.entries(r.proposed)) {
      const label = EDIT_FIELD_LABELS[key] ?? key;
      const before = current[key as keyof typeof current];
      const fmt = (v: unknown) =>
        v == null || v === '' ? '(empty)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
      if (fmt(before) !== fmt(proposed)) rows.push([label, fmt(before), fmt(proposed)]);
    }
    return rows;
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-raised p-4">
      <p className="text-sm font-semibold text-app">
        Edit requests awaiting approval ({data.length})
      </p>
      <ul className="flex flex-col gap-3">
        {data.map((r) => {
          const busy = decide.isPending && decide.variables?.id === r.id;
          const rows = diffRows(r);
          return (
            <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-app bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-app">
                  <span className="font-medium">{r.bathroom?.name ?? 'Bathroom'}</span>{' '}
                  <span className="text-muted">
                    · suggested by @{r.requester?.username ?? 'unknown'}
                  </span>
                </p>
                <span className="text-xs text-muted">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.note && <p className="text-xs italic text-muted">“{r.note}”</p>}
              {rows.length === 0 ? (
                <p className="text-xs text-muted">No visible changes (values already match).</p>
              ) : (
                <ul className="flex flex-col gap-1 text-xs">
                  {rows.map(([label, before, after]) => (
                    <li key={label} className="flex flex-wrap gap-1.5">
                      <span className="font-medium text-app">{label}:</span>
                      <span className="text-red-500 line-through">{before}</span>
                      <span aria-hidden="true" className="text-muted">→</span>
                      <span className="text-green-600">{after}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 hover:bg-red-500/10"
                  disabled={busy}
                  onClick={() => {
                    const note = window.prompt(
                      'Reason for rejecting (shown to the requester):',
                    );
                    if (note === null) return;
                    decide.mutate({ id: r.id, approve: false, note: note.trim() || undefined });
                  }}
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy}
                  onClick={() => decide.mutate({ id: r.id, approve: true })}
                >
                  Approve & apply
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AdminBathroomRow({
  b,
  onChanged,
  selected,
  onToggleSelect,
}: {
  b: Bathroom;
  onChanged: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const removed = b.deleted_at != null;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(b.name);
  const [address, setAddress] = useState(b.address);
  const [description, setDescription] = useState(b.description ?? '');
  const [amenities, setAmenities] = useState<Amenities>({
    wheelchair_accessible: b.wheelchair_accessible,
    gender_neutral: b.gender_neutral,
    changing_table: b.changing_table,
    requires_key: b.requires_key,
  });

  // Staged pin move from "Re-locate from address"; null = keep b.lat/b.lng.
  const [staged, setStaged] = useState<{ lat: number; lng: number } | null>(null);
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);

  function resetLocationEdit() {
    setStaged(null);
    setCandidates([]);
    setGeocodeMsg(null);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const patch: NewBathroom = {
      name: name.trim(),
      address: address.trim(),
      lat: staged?.lat ?? b.lat,
      lng: staged?.lng ?? b.lng,
      description: description.trim() || null,
      ...amenities,
    };
    await run(async () => {
      await updateBathroom(b.id, patch);
      setEditing(false);
      resetLocationEdit();
    });
  }

  async function relocate() {
    setGeocoding(true);
    setGeocodeMsg(null);
    setCandidates([]);
    try {
      const found = await geocodeAddress(address);
      if (found.length === 0) {
        setGeocodeMsg('No matches for that address — edit it and try again.');
      } else if (found.length === 1) {
        setStaged({ lat: found[0].lat, lng: found[0].lng });
      } else {
        setCandidates(found);
      }
    } finally {
      setGeocoding(false);
    }
  }

  function removeWithReason() {
    const reason = window.prompt('Reason shown to the owner (they can appeal):');
    if (reason === null) return;
    void run(() => softDeleteBathroom(b.id, reason.trim() || undefined));
  }

  function deleteForever() {
    const ok = window.confirm(
      'Permanently deletes this bathroom AND its reviews, photos, claims, placements, and any ad campaigns pinned to it. This cannot be undone or appealed.',
    );
    if (!ok) return;
    if (window.prompt('Type DELETE to confirm') !== 'DELETE') return;
    const reason = window.prompt('Reason (optional):');
    if (reason === null) return;
    void run(() => hardDeleteBathroom(b.id, reason.trim() || undefined));
  }

  return (
    <li
      className={`flex flex-col gap-3 rounded-xl border bg-raised p-4 ${
        selected ? 'border-flush-500' : 'border-app'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${b.name}`}
            className="size-4 accent-flush-600"
          />
          <Link
            to={`/bathrooms/${b.id}`}
            className="font-medium text-app hover:underline"
          >
            {b.name}
          </Link>
        </div>
        {removed && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
            Removed
          </span>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Input
            label="Address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={300}
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
          />
          <fieldset className="grid grid-cols-2 gap-2">
            {AMENITY_KEYS.map((key) => (
              <Checkbox
                key={key}
                label={AMENITY_LABELS[key]}
                checked={amenities[key]}
                onChange={(e) =>
                  setAmenities((a) => ({ ...a, [key]: e.target.checked }))
                }
              />
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="secondary"
                size="sm"
                loading={geocoding}
                disabled={busy}
                onClick={() => void relocate()}
              >
                Re-locate from address
              </Button>
            </div>
            {candidates.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-app p-2">
                {candidates.map((c) => (
                  <li key={`${c.lat},${c.lng}`}>
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-xs text-app hover:bg-black/5 dark:hover:bg-white/10"
                      onClick={() => {
                        setStaged({ lat: c.lat, lng: c.lng });
                        setCandidates([]);
                      }}
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {staged && (
              <p className="text-xs text-muted">
                pin will move to {staged.lat.toFixed(5)}, {staged.lng.toFixed(5)}
              </p>
            )}
            {geocodeMsg && <p className="text-xs text-red-500">{geocodeMsg}</p>}
            <p className="text-[11px] text-muted">{GEOCODE_ATTRIBUTION}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">{b.address}</p>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                resetLocationEdit();
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>
              Save changes
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {removed ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() => void run(() => restoreBathroom(b.id))}
              >
                Restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:bg-red-500/10"
                loading={busy}
                onClick={removeWithReason}
              >
                Remove
              </Button>
            )}
            <Button variant="danger" size="sm" loading={busy} onClick={deleteForever}>
              Delete forever
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function AdminBathrooms() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();

  // Moderators are scoped (migration 20260714010000): this console shows only
  // their assigned bathrooms. Admins see the full directory.
  const assigned = useQuery({
    queryKey: ['assigned', 'bathrooms'],
    queryFn: myAssignedBathrooms,
    enabled: !isAdmin,
  });
  const scopeIds = isAdmin ? undefined : assigned.data?.map((b) => b.bathroom_id);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: [...queryKeys.adminBathrooms(), scopeIds ?? 'all'],
    queryFn: () => listBathroomsForModeration(100, scopeIds),
    enabled: isAdmin || scopeIds != null,
  });
  const attrDefs = useQuery({
    queryKey: ['attributeDefs', true],
    queryFn: () => listAttributeDefs(true),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkSlug, setBulkSlug] = useState('');
  const [bulkModerator, setBulkModerator] = useState('');
  const moderators = useQuery({
    queryKey: ['admin', 'users', 'moderators'],
    queryFn: () => searchUsers({ role: 'moderator', limit: 200 }),
    enabled: isAdmin,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminBathrooms() });
    void qc.invalidateQueries({ queryKey: ['bathrooms'] });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ids = [...selected];

  async function runBulk(fn: () => Promise<string>) {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      setBulkMsg(await fn());
      setSelected(new Set());
      invalidate();
    } catch (err: unknown) {
      setBulkMsg(err instanceof Error ? err.message : 'Bulk action failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkRemove() {
    const reason = window.prompt(
      `Reason shown to the owners of these ${ids.length} bathrooms (they can appeal):`,
    );
    if (reason === null) return;
    void runBulk(async () => {
      const n = await bulkSoftDeleteBathrooms(ids, reason.trim() || undefined);
      return `Removed ${n} bathroom${n === 1 ? '' : 's'}.`;
    });
  }

  function bulkRestore() {
    void runBulk(async () => {
      const n = await bulkRestoreBathrooms(ids);
      return `Restored ${n} bathroom${n === 1 ? '' : 's'}.`;
    });
  }

  function bulkTag(add: boolean) {
    if (!bulkSlug) return;
    void runBulk(async () => {
      const n = await bulkSetAttribute(ids, bulkSlug, add);
      return `${add ? 'Tagged' : 'Untagged'} ${n} bathroom${n === 1 ? '' : 's'}.`;
    });
  }

  function bulkAssign(add: boolean) {
    if (!bulkModerator) return;
    void runBulk(async () => {
      const n = await assignBathrooms(bulkModerator, ids, add);
      return `${add ? 'Assigned' : 'Unassigned'} ${n} bathroom${n === 1 ? '' : 's'}.`;
    });
  }

  function bulkHardDelete() {
    const ok = window.confirm(
      `PERMANENTLY delete ${ids.length} bathrooms AND their reviews, photos, claims, placements, and pinned campaigns. This cannot be undone or appealed.`,
    );
    if (!ok) return;
    if (window.prompt('Type DELETE to confirm') !== 'DELETE') return;
    const reason = window.prompt('Reason (optional):');
    if (reason === null) return;
    void runBulk(async () => {
      let done = 0;
      const failed: string[] = [];
      // Sequential on purpose: each delete clears its photo bytes from
      // storage first, and parallel storage batches can rate-limit.
      for (const id of ids) {
        try {
          await hardDeleteBathroom(id, reason.trim() || undefined);
          done += 1;
        } catch {
          failed.push(id);
        }
      }
      return failed.length === 0
        ? `Permanently deleted ${done} bathroom${done === 1 ? '' : 's'}.`
        : `Deleted ${done}; ${failed.length} failed — retry those.`;
    });
  }

  if (isPending) return <p className="text-sm text-muted">Loading bathrooms…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load bathrooms.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const defs = attrDefs.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <EditRequestsQueue />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={selected.size > 0 && selected.size === data.length}
            onChange={() =>
              setSelected(
                selected.size === data.length
                  ? new Set()
                  : new Set(data.map((b) => b.id)),
              )
            }
            aria-label="Select all bathrooms"
            className="size-4 accent-flush-600"
          />
          Select all
        </label>
        {selected.size > 0 && (
          <span className="text-xs text-muted">{selected.size} selected</span>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-flush-500/40 bg-raised p-3 shadow-sm">
          <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={bulkRemove}
            className="text-red-500 hover:bg-red-500/10">
            Remove ({selected.size})
          </Button>
          <Button variant="secondary" size="sm" disabled={bulkBusy} onClick={bulkRestore}>
            Restore
          </Button>
          <span className="flex items-center gap-1">
            <select
              value={bulkSlug}
              onChange={(e) => setBulkSlug(e.target.value)}
              aria-label="Attribute to apply"
              className="h-8 rounded-lg border border-app bg-surface px-2 text-xs text-app"
            >
              <option value="">Tag with…</option>
              {defs.map((d) => (
                <option key={d.slug} value={d.slug}>
                  {d.kind}: {d.label}
                </option>
              ))}
            </select>
            <Button variant="secondary" size="sm" disabled={bulkBusy || !bulkSlug}
              onClick={() => bulkTag(true)}>
              Add
            </Button>
            <Button variant="ghost" size="sm" disabled={bulkBusy || !bulkSlug}
              onClick={() => bulkTag(false)}>
              Remove tag
            </Button>
          </span>
          {isAdmin && (
            <span className="flex items-center gap-1">
              <select
                value={bulkModerator}
                onChange={(e) => setBulkModerator(e.target.value)}
                aria-label="Moderator to assign"
                className="h-8 rounded-lg border border-app bg-surface px-2 text-xs text-app"
              >
                <option value="">Assign to…</option>
                {(moderators.data ?? []).map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    @{m.username}
                  </option>
                ))}
              </select>
              <Button variant="secondary" size="sm" disabled={bulkBusy || !bulkModerator}
                onClick={() => bulkAssign(true)}>
                Assign
              </Button>
              <Button variant="ghost" size="sm" disabled={bulkBusy || !bulkModerator}
                onClick={() => bulkAssign(false)}>
                Unassign
              </Button>
            </span>
          )}
          <Button variant="danger" size="sm" loading={bulkBusy} onClick={bulkHardDelete}>
            Delete forever
          </Button>
        </div>
      )}

      {bulkMsg && <p className="text-sm text-muted" role="status">{bulkMsg}</p>}

      <ul className="flex flex-col gap-3">
        {data.map((b) => (
          <AdminBathroomRow
            key={b.id}
            b={b}
            onChanged={invalidate}
            selected={selected.has(b.id)}
            onToggleSelect={() => toggle(b.id)}
          />
        ))}
      </ul>
    </div>
  );
}
