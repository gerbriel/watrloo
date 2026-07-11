/**
 * Anonymous, non-PII identifiers for ad delivery (see docs/growth/oss-research/
 * 4-plausible-umami.md and 5-revive.md).
 *
 * - sessionSeed: per-tab, sessionStorage. Keeps the weighted ad pick stable for
 *   a session (no flicker on re-render) while the pool still rotates hourly.
 * - clientSeed: per-device, localStorage. Feeds the server-side rotating-salt
 *   visitor hash used ONLY for frequency capping; the hash never leaves the
 *   database and is unrecoverable within 48h (salt rotated, rows pruned).
 * Both are random UUIDs, never tied to an account, cleared with site data.
 */

const SESSION_KEY = 'wl_ad_session';
const CLIENT_KEY = 'wl_ad_seed';

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null; // storage blocked (private mode / policy) — degrade gracefully
  }
}

function safeSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

export function sessionSeed(): string {
  let seed = safeGet(sessionStorage, SESSION_KEY);
  if (!seed) {
    seed = crypto.randomUUID();
    safeSet(sessionStorage, SESSION_KEY, seed);
  }
  return seed;
}

export function clientSeed(): string | null {
  let seed = safeGet(localStorage, CLIENT_KEY);
  if (!seed) {
    seed = crypto.randomUUID();
    safeSet(localStorage, CLIENT_KEY, seed);
    // If storage is blocked, return null rather than a fresh UUID per call —
    // an unstable seed would defeat frequency capping while looking valid.
    if (safeGet(localStorage, CLIENT_KEY) !== seed) return null;
  }
  return seed;
}
