import { lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listBathrooms } from '@/lib/api/bathrooms';
import { queryKeys } from '@/lib/queryClient';
import { Button } from '@/components/ui/Button';

// MapLibre is ~225KB gzipped. Load it only when a map is actually shown, so the
// home page and every auth screen stay light.
const BathroomMap = lazy(() =>
  import('@/components/map/BathroomMap').then((m) => ({ default: m.BathroomMap })),
);

function MapSpinner({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center">
      <span
        role="status"
        aria-label={label}
        className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent"
      />
    </div>
  );
}

export function MapPage() {
  const navigate = useNavigate();
  const {
    data: bathrooms,
    error,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.bathrooms('__map__'),
    queryFn: () => listBathrooms({ limit: 500 }),
  });

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[480px] w-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-app">Bathroom map</h1>
          <p className="text-xs text-muted">
            {bathrooms
              ? `${bathrooms.length} bathroom${bathrooms.length === 1 ? '' : 's'}`
              : 'Loading…'}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => navigate('/bathrooms/new')}>
          Add a bathroom
        </Button>
      </div>

      <div className="relative flex-1">
        {isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-medium text-app">Couldn’t load the map</p>
            <p className="max-w-md text-sm text-muted">
              {error instanceof Error ? error.message : 'Something went wrong.'}
            </p>
            <Button variant="secondary" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : isPending ? (
          <MapSpinner label="Loading bathrooms" />
        ) : (
          <Suspense fallback={<MapSpinner label="Loading map" />}>
            <BathroomMap bathrooms={bathrooms} locate className="h-full w-full" />
          </Suspense>
        )}
      </div>
    </div>
  );
}
