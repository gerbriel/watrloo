import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  bathroomAttributes,
  listAttributeDefs,
  toggleBathroomAttribute,
} from '@/lib/api/attributes';
import type { AttributeDef } from '@/lib/api/attributes';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';

/**
 * Community upkeep of a bathroom's tags, on the detail page. Any signed-in
 * user can flip amenities/heads-ups/venue type; each toggle saves instantly
 * through toggle_bathroom_attribute (logged server-side) — the same
 * publish-now, moderate-reactively model as reviews. Signed-out visitors see
 * nothing; the badges next door already show them the current tags.
 */
export function AttributeEditor({ bathroomId }: { bathroomId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keys shared with AttributeBadges so a toggle here updates the pills there.
  const slugsKey = ['bathroomAttributes', bathroomId] as const;
  const defs = useQuery({
    queryKey: ['attributeDefs', true],
    queryFn: () => listAttributeDefs(),
    enabled: open,
  });
  const slugs = useQuery({
    queryKey: slugsKey,
    queryFn: () => bathroomAttributes(bathroomId),
    enabled: open,
  });

  const toggle = useMutation({
    mutationFn: ({ slug, add }: { slug: string; add: boolean }) =>
      toggleBathroomAttribute(bathroomId, slug, add),
    // Optimistic: flip locally, roll back on error.
    onMutate: async ({ slug, add }) => {
      await qc.cancelQueries({ queryKey: slugsKey });
      const prev = qc.getQueryData<string[]>(slugsKey);
      qc.setQueryData<string[]>(slugsKey, (cur = []) =>
        add ? [...new Set([...cur, slug])] : cur.filter((s) => s !== slug),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(slugsKey, ctx.prev);
      setError('Couldn’t save that change. Try again.');
    },
    onSuccess: () => setError(null),
    onSettled: () => void qc.invalidateQueries({ queryKey: slugsKey }),
  });

  if (!user) return null;

  if (!open) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Update options
        </Button>
      </div>
    );
  }

  const ready = defs.isSuccess && slugs.isSuccess;
  const attached = new Set(slugs.data ?? []);

  function Group({ title, items }: { title: string; items: AttributeDef[] }) {
    if (items.length === 0) return null;
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {title}
        </legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {items.map((d) => (
            <Checkbox
              key={d.slug}
              label={d.label}
              title={d.description ?? undefined}
              checked={attached.has(d.slug)}
              onChange={() =>
                toggle.mutate({ slug: d.slug, add: !attached.has(d.slug) })
              }
            />
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-app bg-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-app">Update this bathroom’s options</h3>
          <p className="mt-0.5 text-xs text-muted">
            Spotted something the listing is missing? Changes save instantly and
            everyone sees them.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>

      {!ready ? (
        <div className="h-24 animate-pulse rounded-lg bg-sunken" />
      ) : (
        <>
          <Group
            title="Amenities"
            items={defs.data.filter((d) => d.kind === 'amenity')}
          />
          <Group
            title="Heads-ups"
            items={defs.data.filter((d) => d.kind === 'caution')}
          />
          <Group
            title="What kind of place is this?"
            items={defs.data.filter((d) => d.kind === 'category')}
          />
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
