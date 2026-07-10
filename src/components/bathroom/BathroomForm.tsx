import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Amenities, Bathroom, NewBathroom } from '@/types/db';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import { nearbyBathrooms } from '@/lib/api/bathrooms';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';

// MapLibre is only needed once this form is open — keep it out of the main chunk.
const BathroomMap = lazy(() =>
  import('@/components/map/BathroomMap').then((m) => ({ default: m.BathroomMap })),
);

interface FieldErrors {
  name?: string;
  address?: string;
  lat?: string;
  lng?: string;
}

/** How close two entries must be before we suspect they're the same bathroom. */
const DUPLICATE_RADIUS_M = 40;

const EMPTY_AMENITIES: Amenities = {
  wheelchair_accessible: false,
  gender_neutral: false,
  changing_table: false,
  requires_key: false,
};

export function BathroomForm({
  initial,
  submitLabel = 'Add bathroom',
  onSubmit,
}: {
  initial?: Partial<NewBathroom>;
  submitLabel?: string;
  onSubmit: (input: NewBathroom) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amenities, setAmenities] = useState<Amenities>({
    ...EMPTY_AMENITIES,
    wheelchair_accessible: initial?.wheelchair_accessible ?? false,
    gender_neutral: initial?.gender_neutral ?? false,
    changing_table: initial?.changing_table ?? false,
    requires_key: initial?.requires_key ?? false,
  });
  const [latStr, setLatStr] = useState(
    initial?.lat != null ? String(initial.lat) : '',
  );
  const [lngStr, setLngStr] = useState(
    initial?.lng != null ? String(initial.lng) : '',
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [duplicates, setDuplicates] = useState<Bathroom[]>([]);

  const lat = Number(latStr);
  const lng = Number(lngStr);
  const latValid = latStr.trim() !== '' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lngValid =
    lngStr.trim() !== '' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  const selected = latValid && lngValid ? { lat, lng } : null;

  // Warn, don't block: two bathrooms really can sit 40m apart. Debounced so
  // dragging the pin doesn't fire a query per frame.
  useEffect(() => {
    if (!selected) {
      setDuplicates([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      nearbyBathrooms(selected.lat, selected.lng, DUPLICATE_RADIUS_M)
        .then((rows) => {
          if (active) setDuplicates(rows);
        })
        .catch(() => {
          // A failed duplicate check must never stop someone adding a bathroom.
          if (active) setDuplicates([]);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected?.lat, selected?.lng]);

  function toggle(key: keyof Amenities) {
    setAmenities((a) => ({ ...a, [key]: !a[key] }));
  }

  function handlePick(nextLat: number, nextLng: number) {
    setLatStr(nextLat.toFixed(6));
    setLngStr(nextLng.toFixed(6));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!name.trim()) next.name = 'Name is required.';
    if (!address.trim()) next.address = 'Address is required.';
    if (!latValid) next.lat = 'Latitude must be a number between -90 and 90.';
    if (!lngValid) next.lng = 'Longitude must be a number between -180 and 180.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setFormError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        address: address.trim(),
        description: description.trim() ? description.trim() : null,
        lat,
        lng,
        ...amenities,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Could not save. Try again.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        placeholder="e.g. Central Library — 2nd floor"
        maxLength={120}
      />

      <Input
        label="Address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        error={errors.address}
        placeholder="Street, city"
        maxLength={300}
      />

      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        hint="Optional. Anything worth knowing before you go."
        maxLength={2000}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-app">Amenities</legend>
        {AMENITY_KEYS.map((key) => (
          <Checkbox
            key={key}
            label={AMENITY_LABELS[key]}
            checked={amenities[key]}
            onChange={() => toggle(key)}
          />
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-app">Location</span>
        <p className="text-xs text-muted">
          Click the map to drop a pin, or type coordinates. Drag the pin to adjust.
        </p>
        <div className="h-72 overflow-hidden rounded-xl border border-app">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center bg-raised">
                <span
                  role="status"
                  aria-label="Loading map"
                  className="size-6 animate-spin rounded-full border-2 border-flush-500 border-t-transparent"
                />
              </div>
            }
          >
            <BathroomMap
              bathrooms={[]}
              selectable
              selected={selected}
              onSelect={handlePick}
            />
          </Suspense>
        </div>

        {duplicates.length > 0 && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
          >
            <p className="text-sm font-medium text-app">
              {duplicates.length === 1
                ? 'A bathroom is already listed here'
                : `${duplicates.length} bathrooms are already listed here`}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Within {DUPLICATE_RADIUS_M}m of your pin. Add yours anyway if it’s a
              different room.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {duplicates.map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/bathrooms/${d.id}`}
                    className="text-xs font-medium text-flush-600 hover:underline"
                  >
                    {d.name} — {d.address}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Latitude"
            inputMode="decimal"
            value={latStr}
            onChange={(e) => setLatStr(e.target.value)}
            error={errors.lat}
            placeholder="-90 to 90"
          />
          <Input
            label="Longitude"
            inputMode="decimal"
            value={lngStr}
            onChange={(e) => setLngStr(e.target.value)}
            error={errors.lng}
            placeholder="-180 to 180"
          />
        </div>
      </div>

      {formError && (
        <p role="alert" className="text-sm text-red-500">
          {formError}
        </p>
      )}

      <div>
        <Button type="submit" size="lg" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
