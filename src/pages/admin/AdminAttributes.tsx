import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listAttributeDefs, upsertAttribute } from '@/lib/api/attributes';
import type { AttributeDef, AttributeKind } from '@/lib/api/attributes';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input } from '@/components/ui/Field';

const SLUG_RE = /^[a-z0-9_]{2,40}$/;
const SLUG_HINT = '2–40 chars: lowercase letters, digits, underscores.';

const CONTROL =
  'w-full rounded-lg border border-app bg-surface px-3 py-2 text-app placeholder:text-muted disabled:opacity-60';

function parseSort(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 100;
}

/** One taxonomy entry: label/description/sort/active editable, slug fixed. */
function DefRow({ def, onSaved }: { def: AttributeDef; onSaved: () => void }) {
  const [label, setLabel] = useState(def.label);
  const [description, setDescription] = useState(def.description ?? '');
  const [sort, setSort] = useState(String(def.sort));
  const [active, setActive] = useState(def.active);

  const save = useMutation({
    mutationFn: () =>
      upsertAttribute({
        slug: def.slug,
        label,
        kind: def.kind,
        description: description.trim() || null,
        active,
        sort: parseSort(sort),
      }),
    onSuccess: onSaved,
  });

  const dirty =
    label !== def.label ||
    description !== (def.description ?? '') ||
    parseSort(sort) !== def.sort ||
    active !== def.active;

  return (
    <li
      className={`flex flex-col gap-2 rounded-xl border border-app bg-raised p-4 ${
        def.active ? '' : 'opacity-70'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted">{def.slug}</span>
        {!def.active && (
          <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-muted">
            Inactive
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_5rem]">
        <input
          aria-label={`Label for ${def.slug}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
          className={CONTROL}
        />
        <input
          aria-label={`Description for ${def.slug}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (shown as a tooltip on cautions)"
          maxLength={200}
          className={CONTROL}
        />
        <input
          aria-label={`Sort order for ${def.slug}`}
          type="number"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className={CONTROL}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Checkbox
          label="Active"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={save.isPending}
          disabled={!dirty || label.trim().length === 0}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </div>

      {save.isError && (
        <p className="text-xs text-red-500">
          {save.error instanceof Error ? save.error.message : 'Save failed.'}
        </p>
      )}
    </li>
  );
}

/** Create a new def under the section's kind. Slug is permanent once created. */
function AddForm({ kind, onSaved }: { kind: AttributeKind; onSaved: () => void }) {
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [sort, setSort] = useState('100');

  const create = useMutation({
    mutationFn: () =>
      upsertAttribute({
        slug,
        label,
        kind,
        description: description.trim() || null,
        sort: parseSort(sort),
      }),
    onSuccess: () => {
      setSlug('');
      setLabel('');
      setDescription('');
      setSort('100');
      onSaved();
    },
  });

  const slugOk = SLUG_RE.test(slug);
  const slugError = slug.length > 0 && !slugOk ? SLUG_HINT : undefined;

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-dashed border-app p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (slugOk && label.trim()) create.mutate();
      }}
    >
      <p className="text-sm font-medium text-app">
        Add {kind === 'amenity' ? 'an amenity' : 'a caution'}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          label="Slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="hand_dryer"
          error={slugError}
          hint={slugError ? undefined : `Permanent identifier. ${SLUG_HINT}`}
        />
        <Input
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Hand dryer"
          maxLength={60}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem]">
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — shown as a tooltip on cautions"
          maxLength={200}
        />
        <Input
          label="Sort"
          type="number"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={create.isPending}
          disabled={!slugOk || label.trim().length === 0}
        >
          Create
        </Button>
      </div>
      {create.isError && (
        <p className="text-xs text-red-500">
          {create.error instanceof Error ? create.error.message : 'Create failed.'}
        </p>
      )}
    </form>
  );
}

// Taxonomy editor: standardized amenities and cautions, admin-extensible.
export function AdminAttributes() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['attributeDefs', false],
    queryFn: () => listAttributeDefs(false),
  });

  // Refresh both this editor and the active-only defs behind pickers/badges.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['attributeDefs'] });
  };

  if (isPending) return <p className="text-sm text-muted">Loading attributes…</p>;
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load attributes.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const sections: { kind: AttributeKind; title: string }[] = [
    { kind: 'amenity', title: 'Amenities' },
    { kind: 'caution', title: 'Cautions' },
  ];

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted">
        The standardized attributes people can attach to bathrooms. Changes are
        audited. There is no delete: uncheck Active instead — inactive
        attributes disappear from pickers and badges (which only load active
        definitions) but stay on record for bathrooms that already have them.
      </p>

      {sections.map(({ kind, title }) => {
        const defs = data.filter((d) => d.kind === kind);
        return (
          <section key={kind} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-app">{title}</h2>
            {defs.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {defs.map((def) => (
                  <DefRow key={def.slug} def={def} onSaved={invalidate} />
                ))}
              </ul>
            )}
            <AddForm kind={kind} onSaved={invalidate} />
          </section>
        );
      })}
    </div>
  );
}
