/**
 * External directions, privacy-first: the link carries ONLY the bathroom's
 * coordinates. The user's maps app supplies their live location itself, so
 * Watrloo never reads, stores, or transmits where anyone is — there's no
 * geolocation permission prompt from us and nothing to retain. (Stated in the
 * privacy policy; keep the two in sync.)
 *
 * Walking mode by default — bathroom emergencies are usually on foot — and
 * the maps app lets them switch.
 */

/** True on iPhone/iPad/Mac, where maps.apple.com opens the native Maps app. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
}

export function directionsUrl(lat: number, lng: number, name?: string): string {
  if (isApplePlatform()) {
    const q = name ? `&q=${encodeURIComponent(name)}` : '';
    return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w${q}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
}
