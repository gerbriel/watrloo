import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Amenities, Bathroom, NewBathroom } from '@/types/db';
import { AMENITY_KEYS, AMENITY_LABELS } from '@/types/db';
import { nearbyBathrooms } from '@/lib/api/bathrooms';
import { geocodeAddress, GEOCODE_ATTRIBUTION } from '@/lib/geocode';
import type { GeocodeCandidate } from '@/lib/geocode';
import { listAttributeDefs } from '@/lib/api/attributes';
import type { AttributeDef } from '@/lib/api/attributes';
import { Input, Textarea, Checkbox } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';

// MapLibre is only needed once this form is open — keep it out of the main chunk.
const BathroomMap = lazy(() =>
  import('@/components/map/BathroomMap').then((m) => ({ default: m.BathroomMap })),
);

interface FieldErrors {
  name?: string;
  address?: string;
  location?: string;
}

/** What the form hands back on submit: the row plus the standardized tags. */
export interface BathroomFormSubmit {
  bathroom: NewBathroom;
  attributeSlugs: string[];
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
  onSubmit: (input: BathroomFormSubmit) => Promise<void>;
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

  // Coordinates are internal only — set by the address search or the map pin,
  // never typed by hand.
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(
    initial?.lat != null && initial?.lng != null
      ? { lat: initial.lat, lng: initial.lng }
      : null,
  );

  // Address-search UI state.
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [matchedLabel, setMatchedLabel] = useState<string | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  // Standardized attribute taxonomy (amenities + cautions).
  const [attrDefs, setAttrDefs] = useState<AttributeDef[]>([]);
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [duplicates, setDuplicates] = useState<Bathroom[]>([]);

  useEffect(() => {
    let active = true;
    listAttributeDefs()
      .then((defs) => {
        if (active) setAttrDefs(defs);
      })
      .catch(() => {
        // The picker is a bonus — a failed load must not block adding a bathroom.
      });
    return () => {
      active = false;
    };
  }, []);

  // Warn, don't block: two bathrooms really can sit 40m apart. Debounced so
  // dragging the pin doesn't fire a query per frame.
  useEffect(() => {
    if (!position) {
      setDuplicates([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      nearbyBathrooms(position.lat, position.lng, DUPLICATE_RADIUS_M)
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
  }, [position?.lat, position?.lng]);

  function toggle(key: keyof Amenities) {
    setAmenities((a) => ({ ...a, [key]: !a[key] }));
  }

  function toggleSlug(slug: string) {
    setSelectedSlugs((s) =>
      s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug],
    );
  }

  function clearLocationError() {
    setErrors((e) => (e.location ? { ...e, location: undefined } : e));
  }

  function handlePick(nextLat: number, nextLng: number) {
    setPosition({ lat: nextLat, lng: nextLng });
    // A hand-placed pin no longer matches the geocoded label.
    setMatchedLabel(null);
    setSearchMessage(null);
    clearLocationError();
  }

  function applyCandidate(c: GeocodeCandidate) {
    setPosition({ lat: c.lat, lng: c.lng });
    setMatchedLabel(c.label);
    setCandidates([]);
    setSearchMessage(null);
    clearLocationError();
  }

  async function handleFindOnMap() {
    if (searching) return;
    const q = address.trim();
    if (!q) {
      setErrors((e) => ({ ...e, address: 'Enter an address to search.' }));
      return;
    }
    setErrors((e) => (e.address ? { ...e, address: undefined } : e));
    setSearching(true);
    setCandidates([]);
    setMatchedLabel(null);
    setSearchMessage(null);
    try {
      const results = await geocodeAddress(q);
      const only = results.length === 1 ? results[0] : undefined;
      if (only) {
        applyCandidate(only);
      } else if (results.length > 1) {
        setCandidates(results);
      } else {
        setSearchMessage(
          'Couldn’t find that address — try adding the city, or drop a pin on the map.',
        );
      }
    } finally {
      setSearching(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!name.trim()) next.name = 'Name is required.';
    if (!address.trim()) next.address = 'Address is required.';
    if (!position) next.location = 'Find the address or drop a pin on the map.';
    setErrors(next);
    if (Object.values(next).some(Boolean) || !position) return;

    setFormError(null);
    setSaving(true);
    try {
      await onSubmit({
        bathroom: {
          name: name.trim(),
          address: address.trim(),
          description: description.trim() ? description.trim() : null,
          lat: position.lat,
          lng: position.lng,
          ...amenities,
        },
        attributeSlugs: selectedSlugs,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Could not save. Try again.');
      setSaving(false);
    }
  }

  const amenityDefs = attrDefs.filter((d) => d.kind === 'amenity');
  const cautionDefs = attrDefs.filter((d) => d.kind === 'caution');

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

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              label="Address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleFindOnMap();
                }
              }}
              error={errors.address}
              placeholder="Street, city"
              maxLength={300}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            loading={searching}
            onClick={() => void handleFindOnMap()}
          >
            Find on map
          </Button>
        </div>
        <p className="text-[11px] text-muted">{GEOCODE_ATTRIBUTION}</p>

        {matchedLabel && (
          <p role="status" className="text-xs text-muted">
            Matched: <span className="font-medium text-app">{matchedLabel}</span>
          </p>
        )}

        {searchMessage && (
          <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
            {searchMessage}
          </p>
        )}

        {candidates.length > 0 && (
          <div className="rounded-lg border border-app bg-raised p-2">
            <p className="px-2 text-xs font-medium text-muted">
              Which one did you mean?
            </p>
            <ul className="mt-1 flex flex-col">
              {candidates.map((c) => (
                <li key={`${c.lat},${c.lng}`}>
                  <button
                    type="button"
                    onClick={() => applyCandidate(c)}
                    className="w-full rounded px-2 py-1.5 text-left text-sm text-app hover:bg-sunken"
                  >
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        hint="Optional. Anything worth knowing before you go."
        maxLength={2000}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-app">Basics</legend>
        {AMENITY_KEYS.map((key) => (
          <Checkbox
            key={key}
            label={AMENITY_LABELS[key]}
            checked={amenities[key]}
            onChange={() => toggle(key)}
          />
        ))}
      </fieldset>

      {amenityDefs.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-app">Amenities</legend>
          {amenityDefs.map((d) => (
            <Checkbox
              key={d.slug}
              label={d.label}
              title={d.description ?? undefined}
              checked={selectedSlugs.includes(d.slug)}
              onChange={() => toggleSlug(d.slug)}
            />
          ))}
        </fieldset>
      )}

      {cautionDefs.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-amber-600 dark:text-amber-400">
            Heads-ups
          </legend>
          {cautionDefs.map((d) => (
            <Checkbox
              key={d.slug}
              label={d.label}
              title={d.description ?? undefined}
              checked={selectedSlugs.includes(d.slug)}
              onChange={() => toggleSlug(d.slug)}
              style={{ accentColor: '#d97706' }}
            />
          ))}
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-app">Location</span>
        <p className="text-xs text-muted">
          Search the address above, then fine-tune here: drag the pin, or click
          the map to move it.
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
              selected={position}
              onSelect={handlePick}
            />
          </Suspense>
        </div>
        {errors.location && (
          <p role="alert" className="text-sm text-red-500">
            {errors.location}
          </p>
        )}

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
