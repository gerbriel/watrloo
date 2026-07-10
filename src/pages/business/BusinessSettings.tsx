import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Business, MyBusiness, SubscriptionStatus } from '@/types/db';
import { getBusiness, updateBusinessProfile } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

type BusinessPatch = Partial<Pick<Business, 'name' | 'website' | 'logo_url' | 'slug'>>;

/** Empty text fields map to NULL in the database, not an empty string. */
function norm(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** RLS blocks non-owner/manager writes; PostgREST surfaces that as 403 / 42501. */
function isPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };
  return (
    e.status === 403 ||
    e.code === '42501' ||
    /permission|not authoriz|violates row-level/i.test(e.message ?? '')
  );
}

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  active: 'bg-green-500/15 text-green-600',
  trialing: 'bg-blue-500/15 text-blue-600',
  past_due: 'bg-amber-500/15 text-amber-600',
  canceled: 'bg-red-500/15 text-red-600',
};

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
};

function PlanPanel({ business }: { business: MyBusiness }) {
  const sub = business.subscription;
  return (
    <section className="mt-10 rounded-xl border border-app bg-raised p-5">
      <h2 className="text-base font-semibold text-app">Plan</h2>
      {sub ? (
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <dt className="w-24 shrink-0 text-muted">Status</dt>
            <dd>
              <span
                className={cn(
                  'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                  STATUS_BADGE[sub.status],
                )}
              >
                {STATUS_LABEL[sub.status]}
              </span>
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-24 shrink-0 text-muted">Plan</dt>
            <dd className="text-app">{sub.plan}</dd>
          </div>
          {sub.current_period_end && (
            <div className="flex items-center gap-2">
              <dt className="w-24 shrink-0 text-muted">
                {sub.status === 'active' || sub.status === 'trialing' ? 'Renews' : 'Ends'}
              </dt>
              <dd className="text-app">{fmtDate(sub.current_period_end)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted">
          No active plan — contact us to set up billing.
        </p>
      )}
    </section>
  );
}

export function BusinessSettings() {
  const { businessId } = useParams<{ businessId: string }>();
  const id = businessId ?? '';
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.business(id),
    queryFn: () => getBusiness(id),
    enabled: id !== '',
  });

  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  // Hydrate the form once per business so a post-save refetch can't clobber edits.
  const hydratedId = useRef<string | null>(null);
  useEffect(() => {
    if (data && hydratedId.current !== data.id) {
      hydratedId.current = data.id;
      setName(data.name);
      setWebsite(data.website ?? '');
      setLogoUrl(data.logo_url ?? '');
      setSlug(data.slug ?? '');
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch: BusinessPatch) => updateBusinessProfile(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.business(id) });
    },
  });

  if (!businessId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 text-sm text-muted">
        No business selected.
      </div>
    );
  }

  if (isPending) {
    return (
      <div
        className="mx-auto max-w-2xl px-4 py-8 text-sm text-muted"
        role="status"
        aria-live="polite"
      >
        Loading business…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-4 py-8">
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'Could not load this business.'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 text-sm text-muted">
        We couldn&rsquo;t find that business.
      </div>
    );
  }

  const business = data;

  const dirty =
    name.trim() !== business.name ||
    norm(website) !== business.website ||
    norm(logoUrl) !== business.logo_url ||
    norm(slug) !== business.slug;

  const showSaved = mutation.isSuccess && !dirty && !mutation.isPending;
  const permissionDenied = mutation.isError && isPermissionDenied(mutation.error);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setNameError('Name is required.');
      return;
    }
    setNameError(undefined);

    const patch: BusinessPatch = {};
    if (nextName !== business.name) patch.name = nextName;
    if (norm(website) !== business.website) patch.website = norm(website);
    if (norm(logoUrl) !== business.logo_url) patch.logo_url = norm(logoUrl);
    if (norm(slug) !== business.slug) patch.slug = norm(slug);
    if (Object.keys(patch).length === 0) return;

    mutation.mutate(patch);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-app">Business settings</h1>
      <p className="mt-1 text-sm text-muted">
        Edit how {business.name} appears to people browsing bathrooms.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          required
          maxLength={200}
          placeholder="e.g. Riverside Cafés"
        />

        <Input
          label="Website"
          type="url"
          inputMode="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://example.com"
        />

        <Input
          label="Logo URL"
          type="url"
          inputMode="url"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          hint="square image works best"
          placeholder="https://example.com/logo.png"
        />

        {logoUrl.trim() !== '' && (
          <img
            src={logoUrl.trim()}
            alt={`${business.name} logo preview`}
            className="size-16 rounded-lg border border-app object-cover"
          />
        )}

        <Input
          label="Slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          hint="lowercase letters, numbers, hyphens"
          placeholder="riverside-cafes"
        />

        {permissionDenied && (
          <p role="alert" className="text-sm text-red-500">
            You don&rsquo;t have permission to edit this business.
          </p>
        )}
        {mutation.isError && !permissionDenied && (
          <p role="alert" className="text-sm text-red-500">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Could not save your changes. Try again.'}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            size="lg"
            loading={mutation.isPending}
            disabled={!dirty}
          >
            Save changes
          </Button>
          {showSaved && (
            <span role="status" aria-live="polite" className="text-sm text-green-600">
              Saved
            </span>
          )}
        </div>
      </form>

      <PlanPanel business={business} />
    </div>
  );
}
