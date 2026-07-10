import { supabase } from '@/lib/supabase';
import type {
  Bathroom,
  BathroomStats,
  BathroomWithStats,
  Bounds,
  NewBathroom,
} from '@/types/db';

/** Default page size for the directory list. */
const DEFAULT_LIMIT = 50;

/**
 * Explicit column list. `bathrooms` also carries a generated `geog` column for
 * spatial queries; `select('*')` would drag that WKB blob across the wire on
 * every row and it isn't part of the `Bathroom` type.
 */
const COLUMNS =
  'id,name,address,lat,lng,description,wheelchair_accessible,gender_neutral,changing_table,requires_key,created_by,created_at,deleted_at,deleted_by';

/**
 * `bathroom_stats` is a VIEW with no foreign-key relationship PostgREST can see,
 * so it cannot be embedded (`select('*, bathroom_stats(*)')` returns PGRST200).
 * We therefore fetch the stats in a second query and merge them in JS, shaping
 * `stats` as an OBJECT to match `BathroomWithStats`.
 */

/** A bathroom with no aggregate row yet (defensive: the view emits a row per bathroom). */
function emptyStats(bathroomId: string): BathroomStats {
  return {
    bathroom_id: bathroomId,
    review_count: 0,
    avg_rating: null,
    avg_cleanliness: null,
    avg_privacy: null,
    avg_accessibility: null,
  };
}

/** Postgres `numeric` can serialize as a string; coerce to number, keeping null. */
function toNum(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? null : n;
}

interface RawStats {
  bathroom_id: string;
  review_count: number | string | null;
  avg_rating: number | string | null;
  avg_cleanliness: number | string | null;
  avg_privacy: number | string | null;
  avg_accessibility: number | string | null;
}

function normalizeStats(row: RawStats): BathroomStats {
  return {
    bathroom_id: row.bathroom_id,
    review_count: toNum(row.review_count) ?? 0,
    avg_rating: toNum(row.avg_rating),
    avg_cleanliness: toNum(row.avg_cleanliness),
    avg_privacy: toNum(row.avg_privacy),
    avg_accessibility: toNum(row.avg_accessibility),
  };
}

/**
 * The RPCs are declared `returns setof public.bathrooms`, so they hand back the
 * generated `geog` column too. Drop it: it isn't part of `Bathroom`, and callers
 * have no use for WKB.
 */
function stripGeog(rows: unknown): Bathroom[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const { geog: _geog, ...rest } = row as Bathroom & { geog?: unknown };
    return rest as Bathroom;
  });
}

/** Fetch stats for the given bathrooms and attach each as a `stats` OBJECT. */
async function attachStats(rows: Bathroom[]): Promise<BathroomWithStats[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((b) => b.id);
  const { data, error } = await supabase
    .from('bathroom_stats')
    .select('*')
    .in('bathroom_id', ids);
  if (error) throw error;

  const byId = new Map<string, BathroomStats>();
  for (const raw of (data ?? []) as RawStats[]) {
    byId.set(raw.bathroom_id, normalizeStats(raw));
  }
  return rows.map((b) => ({ ...b, stats: byId.get(b.id) ?? emptyStats(b.id) }));
}

/**
 * Search goes through the `search_bathrooms` RPC rather than a PostgREST
 * `.or()` filter string. The term is a bound parameter, so there is no filter
 * expression for it to break out of, the trigram indexes get used, and results
 * come back ranked by similarity instead of insertion order.
 */
export async function listBathrooms(
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<BathroomWithStats[]> {
  const term = opts.search?.trim() || null;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  const { data, error } = await supabase.rpc('search_bathrooms', {
    q: term,
    lim: limit,
    off: offset,
  });
  if (error) throw error;
  return attachStats(stripGeog(data));
}

export async function getBathroom(id: string): Promise<BathroomWithStats | null> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const [withStats] = await attachStats([data as unknown as Bathroom]);
  return withStats;
}

export async function listBathroomsInBounds(b: Bounds): Promise<BathroomWithStats[]> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select(COLUMNS)
    .gte('lat', b.minLat)
    .lte('lat', b.maxLat)
    .gte('lng', b.minLng)
    .lte('lng', b.maxLng)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachStats((data ?? []) as unknown as Bathroom[]);
}

/**
 * Bathrooms within `meters` of a point, nearest first. Used to warn about a
 * duplicate before someone adds a bathroom that already exists.
 */
export async function nearbyBathrooms(
  lat: number,
  lng: number,
  meters = 40,
): Promise<Bathroom[]> {
  const { data, error } = await supabase.rpc('nearby_bathrooms', {
    p_lat: lat,
    p_lng: lng,
    p_meters: meters,
  });
  if (error) throw error;
  return stripGeog(data);
}

export async function createBathroom(
  input: NewBathroom,
  userId: string,
): Promise<Bathroom> {
  // `created_by` must equal the caller's uid or the RLS insert policy rejects it.
  const { data, error } = await supabase
    .from('bathrooms')
    .insert({ ...input, created_by: userId })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as Bathroom;
}

/**
 * Edit a bathroom's facts. RLS decides who may: the creator (own row) or a
 * moderator (any row). The caller doesn't pass identity — the policy reads it
 * from the JWT — so this same call serves both the owner-edit and admin flows.
 */
export async function updateBathroom(
  id: string,
  patch: NewBathroom,
): Promise<Bathroom> {
  const { data, error } = await supabase
    .from('bathrooms')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as Bathroom;
}
