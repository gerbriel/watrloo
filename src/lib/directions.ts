/**
 * External directions, privacy-first: the link carries ONLY the bathroom's
 * coordinates. The user's maps app supplies their live location as the route
 * origin itself, so Watrloo never reads, stores, or transmits where anyone
 * is — there's no geolocation permission prompt from us and nothing to
 * retain. (Stated in the privacy policy; keep the two in sync.)
 *
 * Walking mode by default — bathroom emergencies are usually on foot — and
 * the maps app lets them switch.
 */

export type MapsApp = 'apple' | 'google';

export const MAPS_APP_LABELS: Record<MapsApp, string> = {
  apple: 'Apple Maps',
  google: 'Google Maps',
};

export function directionsUrl(app: MapsApp, lat: number, lng: number): string {
  if (app === 'apple') {
    // daddr + dirflg only. Adding q= makes Apple Maps treat the link as a
    // SEARCH and it drops the route — the destination must stay bare.
    return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`;
  }
  // api=1 + destination opens the directions UI with origin = current
  // location; omitting `origin` on purpose is what keeps us out of the loop.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
}

/** Apple platforms get Apple Maps by default; everyone else Google Maps. */
export function defaultMapsApp(): MapsApp {
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)) {
    return 'apple';
  }
  return 'google';
}

const PREF_KEY = 'watrloo:maps-app';

/** The user's remembered maps app, else the platform default. */
export function preferredMapsApp(): MapsApp {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored === 'apple' || stored === 'google') return stored;
  } catch {
    /* storage blocked (private mode etc.) — fall through to the default */
  }
  return defaultMapsApp();
}

export function rememberMapsApp(app: MapsApp): void {
  try {
    localStorage.setItem(PREF_KEY, app);
  } catch {
    /* non-fatal: they just get asked by default next time */
  }
}
