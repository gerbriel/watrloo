/**
 * Forward geocoding via OpenStreetMap Nominatim — address text in, candidate
 * coordinates out — so adding a bathroom needs no lat/lng typing.
 *
 * Usage rules we must respect (nominatim.org/release-docs/latest/api/Search/):
 * absolute max 1 request/second, no autocomplete-per-keystroke (we geocode on
 * an explicit button press / debounced submit, never per keypress), and the
 * result requires attribution — render ATTRIBUTION near any UI fed by this.
 * At Watrloo's volume this is comfortably within policy; if the app outgrows
 * it, swap `endpoint` for a paid geocoder behind the same interface.
 */

export const GEOCODE_ATTRIBUTION = 'Address search © OpenStreetMap contributors';

export interface GeocodeCandidate {
  lat: number;
  lng: number;
  /** Human-readable place label, e.g. "Ferry Building, San Francisco, CA". */
  label: string;
}

const endpoint = 'https://nominatim.openstreetmap.org/search';

let lastCallAt = 0;

/**
 * Geocode an address string to up to `limit` candidates. Returns [] for
 * blank/failed lookups rather than throwing on rate/network hiccups — the
 * caller decides how to prompt the user. Enforces a 1.1s client-side gap
 * between calls (Nominatim's hard rate rule).
 */
export async function geocodeAddress(
  address: string,
  limit = 5,
): Promise<GeocodeCandidate[]> {
  const q = address.trim();
  if (q.length < 3) return [];

  const wait = 1100 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  const url =
    `${endpoint}?format=jsonv2&addressdetails=0&limit=${limit}` +
    `&countrycodes=us&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const rows = (await res.json()) as {
      lat: string;
      lon: string;
      display_name: string;
    }[];
    return rows
      .map((r) => ({
        lat: Number(r.lat),
        lng: Number(r.lon),
        label: r.display_name,
      }))
      .filter(
        (c) =>
          Number.isFinite(c.lat) &&
          Number.isFinite(c.lng) &&
          c.lat >= -90 &&
          c.lat <= 90 &&
          c.lng >= -180 &&
          c.lng <= 180,
      );
  } catch {
    return [];
  }
}
