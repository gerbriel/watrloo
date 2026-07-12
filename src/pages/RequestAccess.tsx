import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { NewAccessRequest } from '@/types/db';
import { fileAccessRequest } from '@/lib/api';
import { listBathrooms } from '@/lib/api/bathrooms';
import { useAuth } from '@/auth/AuthProvider';
import { Input, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PickedBathroom = { id: string; name: string; address: string | null };

/**
 * Search existing Watrloo bathrooms and multi-select the ones this business
 * wants to claim; anything not listed yet is added as free text. Existing picks
 * ride along as `requested_bathroom_ids`, the free-text ones as
 * `requested_new_locations`, so the admin knows exactly what to set up.
 */
function LocationPicker({
  picked,
  onPickedChange,
  newLocations,
  onNewLocationsChange,
}: {
  picked: PickedBathroom[];
  onPickedChange: (next: PickedBathroom[]) => void;
  newLocations: string[];
  onNewLocationsChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results, isFetching } = useQuery({
    queryKey: ['accessRequestSearch', debounced],
    queryFn: () => listBathrooms({ search: debounced, limit: 8 }),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  const pickedIds = new Set(picked.map((p) => p.id));
  const matches = (results ?? []).filter((b) => !pickedIds.has(b.id));

  function add(b: { id: string; name: string; address: string | null }) {
    if (pickedIds.has(b.id)) return;
    onPickedChange([...picked, { id: b.id, name: b.name, address: b.address }]);
    setQuery('');
    setDebounced('');
  }

  function remove(id: string) {
    onPickedChange(picked.filter((p) => p.id !== id));
  }

  function addNew() {
    const value = draft.trim();
    if (!value) return;
    // Case-insensitive de-dupe against what's already listed.
    if (!newLocations.some((l) => l.toLowerCase() === value.toLowerCase())) {
      onNewLocationsChange([...newLocations, value.slice(0, 200)]);
    }
    setDraft('');
  }

  const total = picked.length + newLocations.length;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-app">Your locations</p>
        <p className="mt-0.5 text-xs text-muted">
          Search Watrloo and select the bathrooms you want to claim. Don&rsquo;t
          see one? Add it below and we&rsquo;ll create it when we set you up.
        </p>
      </div>

      {/* Search existing */}
      <div>
        <label htmlFor="loc-search" className="sr-only">
          Search bathrooms on Watrloo
        </label>
        <input
          id="loc-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Don't let Enter in the search box submit the whole form.
            if (e.key === 'Enter') e.preventDefault();
          }}
          placeholder="Search by name or address…"
          autoComplete="off"
          className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app placeholder:text-muted"
        />

        {debounced.length >= 2 && (
          <div className="mt-2 overflow-hidden rounded-lg border border-app bg-surface">
            {isFetching && matches.length === 0 && (
              <p className="px-3 py-2.5 text-sm text-muted">Searching…</p>
            )}
            {!isFetching && matches.length === 0 && (
              <p className="px-3 py-2.5 text-sm text-muted">
                No matches. Add it as a new location below.
              </p>
            )}
            {matches.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => add(b)}
                className="flex w-full items-center justify-between gap-3 border-b border-app px-3 py-2.5 text-left last:border-b-0 hover:bg-raised"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-app">
                    {b.name}
                  </span>
                  {b.address && (
                    <span className="block truncate text-xs text-muted">
                      {b.address}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-medium text-flush-600">
                  Add
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Add a location not in the system */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addNew();
            }
          }}
          placeholder="Add a location that isn't on Watrloo yet…"
          maxLength={200}
          className="min-w-0 flex-1 rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app placeholder:text-muted"
        />
        <Button type="button" variant="secondary" onClick={addNew} disabled={!draft.trim()}>
          Add
        </Button>
      </div>

      {/* Selected chips */}
      {total > 0 && (
        <ul className="flex flex-wrap gap-2">
          {picked.map((p) => (
            <li
              key={p.id}
              className="flex max-w-full items-center gap-1.5 rounded-full border border-app bg-raised py-1 pl-3 pr-1.5 text-sm"
            >
              <span className="truncate text-app" title={p.address ?? p.name}>
                {p.name}
              </span>
              <button
                type="button"
                onClick={() => remove(p.id)}
                aria-label={`Remove ${p.name}`}
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-sunken hover:text-app"
              >
                &times;
              </button>
            </li>
          ))}
          {newLocations.map((l) => (
            <li
              key={`new:${l}`}
              className="flex max-w-full items-center gap-1.5 rounded-full border border-dashed border-strong bg-raised py-1 pl-3 pr-1.5 text-sm"
            >
              <span
                className="rounded-full bg-flush-500/15 px-1.5 text-[0.65rem] font-medium uppercase tracking-wide text-flush-600"
                aria-hidden="true"
              >
                New
              </span>
              <span className="truncate text-app" title={l}>
                {l}
              </span>
              <button
                type="button"
                onClick={() =>
                  onNewLocationsChange(newLocations.filter((x) => x !== l))
                }
                aria-label={`Remove ${l}`}
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-sunken hover:text-app"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
      {total > 0 && (
        <p className="text-xs text-muted">
          {picked.length} listed · {newLocations.length} new
        </p>
      )}
    </div>
  );
}

export function RequestAccess() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [businessName, setBusinessName] = useState('');
  const [website, setWebsite] = useState('');
  const [contactEmail, setContactEmail] = useState(user?.email ?? '');
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState<PickedBathroom[]>([]);
  const [newLocations, setNewLocations] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: async (input: NewAccessRequest) => {
      await fileAccessRequest(input, user?.id ?? null);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = businessName.trim();
    const trimmedEmail = contactEmail.trim();

    let hasError = false;
    if (!trimmedName) {
      setNameError('Business name is required.');
      hasError = true;
    } else {
      setNameError(undefined);
    }

    // Signed-out visitors have no account we can tie the request to, so a
    // reachable contact email is the only way we can follow up.
    if (!user) {
      if (!trimmedEmail) {
        setEmailError('Contact email is required so we can reach you.');
        hasError = true;
      } else if (!EMAIL_RE.test(trimmedEmail)) {
        setEmailError('Enter a valid email address.');
        hasError = true;
      } else {
        setEmailError(undefined);
      }
    } else {
      setEmailError(undefined);
    }

    if (hasError) return;

    const input: NewAccessRequest = {
      business_name: trimmedName,
      website: website.trim() ? website.trim() : null,
      contact_email: trimmedEmail ? trimmedEmail : null,
      message: message.trim() ? message.trim() : null,
      requested_bathroom_ids: picked.map((p) => p.id),
      requested_new_locations: newLocations,
    };
    mutation.mutate(input);
  }

  if (mutation.isSuccess) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-app bg-raised p-6">
          <h1 className="text-xl font-semibold text-app">Request received</h1>
          <p className="text-sm text-muted">
            We&rsquo;ll be in touch to set up your account.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate('/browse')}>Browse bathrooms</Button>
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-6 flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-app">Request business access</h1>
        <p className="text-sm text-muted">
          Claim your locations, keep their info accurate, bulk-import a whole chain,
          and respond to reviews from one place. No Watrloo account required &mdash;
          just tell us how to reach you and we&rsquo;ll take it from there.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input
          label="Business name"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          error={nameError}
          placeholder="e.g. Riverside Cafés"
          maxLength={200}
          required
        />

        <Input
          label="Website"
          type="url"
          inputMode="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          hint="Optional."
          placeholder="https://example.com"
        />

        <Input
          label="Contact email"
          type="email"
          inputMode="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          error={emailError}
          hint={
            user
              ? 'Optional. How we’ll reach you about this request.'
              : 'So we can reach you about your request.'
          }
          placeholder="you@business.com"
          required={!user}
        />

        <LocationPicker
          picked={picked}
          onPickedChange={setPicked}
          newLocations={newLocations}
          onNewLocationsChange={setNewLocations}
        />

        <Textarea
          label="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          hint="Optional. Anything else you'd like us to know."
          maxLength={1000}
        />

        {mutation.isError && (
          <p role="alert" className="text-sm text-red-500">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Could not send your request. Try again.'}
          </p>
        )}

        <div>
          <Button type="submit" size="lg" loading={mutation.isPending}>
            Request access
          </Button>
        </div>
      </form>
    </div>
  );
}
