import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BathroomWithStats } from '@/types/db';
import { listBathrooms } from '@/lib/api/bathrooms';
import { BathroomMap } from '@/components/map/BathroomMap';
import { Button } from '@/components/ui/Button';

type Status = 'loading' | 'ready' | 'error';

export function MapPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [bathrooms, setBathrooms] = useState<BathroomWithStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setError(null);
    listBathrooms({ limit: 500 })
      .then((rows) => {
        if (!active) return;
        setBathrooms(rows);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-[480px] w-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-app">Bathroom map</h1>
          <p className="text-xs text-muted">
            {status === 'ready'
              ? `${bathrooms.length} bathroom${bathrooms.length === 1 ? '' : 's'}`
              : 'Loading…'}
          </p>
        </div>
        <Link to="/bathrooms/new">
          <Button variant="primary" size="sm">
            Add a bathroom
          </Button>
        </Link>
      </div>

      <div className="relative flex-1">
        {status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-medium text-app">Couldn’t load the map</p>
            <p className="max-w-md text-sm text-muted">{error}</p>
            <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          </div>
        ) : status === 'loading' ? (
          <div className="grid h-full place-items-center">
            <span
              aria-label="Loading map"
              className="size-8 animate-spin rounded-full border-2 border-flush-500 border-t-transparent"
            />
          </div>
        ) : (
          <BathroomMap bathrooms={bathrooms} fit className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
