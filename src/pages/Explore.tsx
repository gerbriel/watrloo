import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listBathrooms } from '@/lib/api/bathrooms';
import { pickFeatured } from '@/lib/api/adserving';
import { queryKeys } from '@/lib/queryClient';
import { BathroomCard } from '@/components/bathroom/BathroomCard';
import { FeaturedCard } from '@/components/growth/FeaturedCard';
import { Button } from '@/components/ui/Button';

// MapLibre is ~225KB gzipped — load it only when Explore mounts.
const BathroomMap = lazy(() =>
  import('@/components/map/BathroomMap').then((m) => ({ default: m.BathroomMap })),
);

/**
 * The unified Browse + Map view (owner: "combine the browse and map views into
 * one"). Desktop: scrollable list beside a full-height map. Mobile: a
 * list/map toggle. One search box drives both — the map always shows exactly
 * the bathrooms in the list.
 */
export function Explore() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mobilePane, setMobilePane] = useState<'list' | 'map'>('list');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const {
    data: bathrooms,
    error,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.bathrooms(debounced),
    queryFn: () => listBathrooms({ search: debounced || undefined, limit: 200 }),
    placeholderData: (previous) => previous,
  });

  // Contextual sponsored slots. Selection is server-side (weighted, paced,
  // frequency-capped); each returned item carries an offer nonce the card
  // confirms on real viewport visibility, so impressions are honest.
  const { data: featured } = useQuery({
    queryKey: queryKeys.featured('browse'),
    queryFn: () => pickFeatured('browse'),
    staleTime: 5 * 60_000,
  });

  const list = (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-app p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight text-app">
              Explore
            </h1>
            <p className="text-xs text-muted">
              {bathrooms
                ? `${bathrooms.length} bathroom${bathrooms.length === 1 ? '' : 's'}`
                : 'Loading…'}
            </p>
          </div>
          <Button size="sm" variant="primary" onClick={() => navigate('/bathrooms/new')}>
            Add a bathroom
          </Button>
        </div>
        <label htmlFor="explore-search" className="sr-only">
          Search bathrooms
        </label>
        <input
          id="explore-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or address…"
          className="w-full rounded-lg border border-app bg-surface px-3 py-2 text-sm text-app placeholder:text-muted"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isPending && (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl border border-app bg-raised" />
            ))}
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-app bg-raised px-6 py-12 text-center">
            <p className="font-medium text-app">Couldn’t load bathrooms</p>
            <p className="max-w-md text-sm text-muted">
              {error instanceof Error ? error.message : 'Something went wrong.'}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        )}
        {bathrooms && bathrooms.length === 0 && (
          <div className="rounded-xl border border-dashed border-app bg-raised px-6 py-12 text-center">
            <p className="font-semibold text-app">
              {debounced ? 'No matches' : 'No bathrooms yet'}
            </p>
            <p className="mt-1 text-sm text-muted">
              {debounced
                ? `Nothing matched “${debounced}”.`
                : 'Add the first one.'}
            </p>
          </div>
        )}
        {bathrooms && bathrooms.length > 0 && (
          <div className="flex flex-col gap-3">
            {featured?.map((item) => (
              <FeaturedCard key={item.offer_id} item={item} />
            ))}
            {bathrooms.map((b) => (
              <BathroomCard key={b.id} bathroom={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const map = (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center bg-sunken">
          <span
            role="status"
            aria-label="Loading map"
            className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent"
          />
        </div>
      }
    >
      <BathroomMap bathrooms={bathrooms ?? []} locate className="h-full w-full" />
    </Suspense>
  );

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[480px] w-full flex-col">
      {/* Mobile pane toggle */}
      <div className="flex border-b border-app md:hidden" role="tablist" aria-label="View">
        {(['list', 'map'] as const).map((pane) => (
          <button
            key={pane}
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={`flex-1 py-2 text-sm font-medium capitalize ${
              mobilePane === pane
                ? 'border-b-2 border-flush-500 text-app'
                : 'text-muted'
            }`}
          >
            {pane}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={`min-h-0 w-full md:block md:w-[420px] md:shrink-0 md:border-r md:border-app ${
            mobilePane === 'list' ? 'block' : 'hidden'
          }`}
        >
          {list}
        </div>
        <div
          className={`min-h-0 flex-1 md:block ${mobilePane === 'map' ? 'block' : 'hidden'}`}
        >
          {map}
        </div>
      </div>
    </div>
  );
}
