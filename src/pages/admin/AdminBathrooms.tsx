import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  listBathroomsForModeration,
  restoreBathroom,
  softDeleteBathroom,
} from '@/lib/api/moderation';
import { hardDeleteBathroom } from '@/lib/api/appeals';
import { updateBathroom } from '@/lib/api/bathrooms';
import { geocodeAddress, GEOCODE_ATTRIBUTION } from '@/lib/geocode';
import type { GeocodeCandidate } from '@/lib/geocode';
import { queryKeys } from '@/lib/queryClient';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import type { Amenities, Bathroom, NewBathroom } from '@/types/db';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';

function AdminBathroomRow({ b, onChanged }: { b: Bathroom; onChanged: () => void }) {
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
    <li className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          to={`/bathrooms/${b.id}`}
          className="font-medium text-app hover:underline"
        >
          {b.name}
        </Link>
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
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminBathrooms(),
    queryFn: () => listBathroomsForModeration(100),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.adminBathrooms() });
    void qc.invalidateQueries({ queryKey: ['bathrooms'] });
  };

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

  return (
    <ul className="flex flex-col gap-3">
      {data.map((b) => (
        <AdminBathroomRow key={b.id} b={b} onChanged={invalidate} />
      ))}
    </ul>
  );
}
