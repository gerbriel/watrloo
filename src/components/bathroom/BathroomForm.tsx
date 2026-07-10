import { useState } from 'react';
import type { Amenities, NewBathroom } from '@/types/db';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { BathroomMap } from '@/components/map/BathroomMap';

interface FieldErrors {
  name?: string;
  address?: string;
  lat?: string;
  lng?: string;
}

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

  const lat = Number(latStr);
  const lng = Number(lngStr);
  const latValid = latStr.trim() !== '' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lngValid =
    lngStr.trim() !== '' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  const selected = latValid && lngValid ? { lat, lng } : null;

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
          <BathroomMap
            bathrooms={[]}
            selectable
            selected={selected}
            onSelect={handlePick}
          />
        </div>
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
