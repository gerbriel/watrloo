import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listBathrooms } from '@/lib/api/bathrooms';
import { queryKeys } from '@/lib/queryClient';
import { BathroomCard } from '@/components/bathroom/BathroomCard';
import { Button } from '@/components/ui/Button';

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-app bg-raised p-4">
      <div className="h-5 w-2/3 animate-pulse rounded bg-porcelain-200 dark:bg-porcelain-800" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-porcelain-200 dark:bg-porcelain-800" />
      <div className="h-4 w-24 animate-pulse rounded bg-porcelain-200 dark:bg-porcelain-800" />
    </div>
  );
}

export function Home() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // Debounce the search box (~300ms) so we don't fire a query per keystroke.
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
    queryFn: () => listBathrooms({ search: debounced || undefined }),
    // Keep the previous results on screen while a new search resolves, so the
    // grid doesn't flash back to skeletons on every keystroke.
    placeholderData: (previous) => previous,
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-app">Find a bathroom</h1>
            <p className="text-sm text-muted">
              Public restrooms, rated by people who’ve been there.
            </p>
          </div>
          {/* A button rather than a <Link> wrapping a <Button>: nesting an
              interactive element inside another is invalid and breaks AT. */}
          <Button variant="primary" onClick={() => navigate('/bathrooms/new')}>
            Add a bathroom
          </Button>
        </div>

        <div className="relative">
          <label htmlFor="bathroom-search" className="sr-only">
            Search bathrooms
          </label>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              className="size-5"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            id="bathroom-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or address…"
            className="w-full rounded-lg border border-app bg-surface py-2.5 pl-10 pr-3 text-app placeholder:text-muted"
          />
        </div>
      </header>

      {isPending && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-app bg-raised px-6 py-16 text-center">
          <p className="font-medium text-app">Couldn’t load bathrooms</p>
          <p className="max-w-md text-sm text-muted">
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {bathrooms && bathrooms.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-app bg-raised px-6 py-16 text-center">
          <p className="text-lg font-semibold text-app">
            {debounced ? 'No matches' : 'No bathrooms yet'}
          </p>
          <p className="max-w-md text-sm text-muted">
            {debounced
              ? `Nothing matched “${debounced}”. Try a different search.`
              : 'No bathrooms yet — add the first one.'}
          </p>
          {!debounced && (
            <Button variant="primary" onClick={() => navigate('/bathrooms/new')}>
              Add the first bathroom
            </Button>
          )}
        </div>
      )}

      {bathrooms && bathrooms.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bathrooms.map((b) => (
            <BathroomCard key={b.id} bathroom={b} />
          ))}
        </div>
      )}
    </div>
  );
}
