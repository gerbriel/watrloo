import { useState } from 'react';
import type { MapsApp } from '@/lib/directions';
import {
  directionsUrl,
  MAPS_APP_LABELS,
  preferredMapsApp,
  rememberMapsApp,
} from '@/lib/directions';
import { Button } from '@/components/ui/Button';

/**
 * Split "Directions" control: the main button opens the user's preferred maps
 * app straight away (platform default until they've picked once), and the
 * chevron opens a two-item menu to launch — and remember — the other one.
 * Links are destination-only; see src/lib/directions.ts for the privacy
 * reasoning.
 */
export function DirectionsButton({ lat, lng }: { lat: number; lng: number }) {
  const [app, setApp] = useState<MapsApp>(() => preferredMapsApp());
  const [open, setOpen] = useState(false);

  function choose(next: MapsApp) {
    setApp(next);
    rememberMapsApp(next);
    setOpen(false);
  }

  return (
    <div className="relative shrink-0">
      <div className="flex items-center">
        <a
          href={directionsUrl(app, lat, lng)}
          target="_blank"
          rel="noreferrer"
          onClick={() => rememberMapsApp(app)}
        >
          <Button size="sm" variant="primary" className="rounded-r-none">
            Directions
          </Button>
        </a>
        <Button
          size="sm"
          variant="primary"
          className="rounded-l-none border-l border-white/25 px-2"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Choose maps app (currently ${MAPS_APP_LABELS[app]})`}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden="true">
            <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
          </svg>
        </Button>
      </div>

      {open && (
        <div
          role="menu"
          aria-label="Open directions in"
          className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-lg border border-app bg-raised shadow-lg"
        >
          {(['apple', 'google'] as const).map((option) => (
            <a
              key={option}
              role="menuitem"
              href={directionsUrl(option, lat, lng)}
              target="_blank"
              rel="noreferrer"
              onClick={() => choose(option)}
              className="flex items-center justify-between px-3 py-2 text-sm text-app hover:bg-sunken"
            >
              {MAPS_APP_LABELS[option]}
              {option === app && (
                <span className="text-xs text-muted" aria-label="current choice">
                  ✓
                </span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
