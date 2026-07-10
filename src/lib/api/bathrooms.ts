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
 * PostgREST `.or()` takes a raw filter string, so a search term containing `,`
 * or `)` could break out of the expression. Wrapping the value in double quotes
 * makes reserved characters literal; we escape backslashes and quotes so the
 * term cannot terminate the quoted value early.
 */
function ilikeValue(term: string): string {
  const safe = term.replace(/[\\"]/g, '\\$&');
  return `"%${safe}%"`;
}

export async function listBathrooms(
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<BathroomWithStats[]> {
  let query = supabase
    .from('bathrooms')
    .select('*')
    .order('created_at', { ascending: false });

  const term = opts.search?.trim();
  if (term) {
    const value = ilikeValue(term);
    query = query.or(`name.ilike.${value},address.ilike.${value}`);
  }

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) throw error;
  return attachStats((data ?? []) as Bathroom[]);
}

export async function getBathroom(id: string): Promise<BathroomWithStats | null> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const [withStats] = await attachStats([data as Bathroom]);
  return withStats;
}

export async function listBathroomsInBounds(b: Bounds): Promise<BathroomWithStats[]> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select('*')
    .gte('lat', b.minLat)
    .lte('lat', b.maxLat)
    .gte('lng', b.minLng)
    .lte('lng', b.maxLng)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachStats((data ?? []) as Bathroom[]);
}

export async function createBathroom(
  input: NewBathroom,
  userId: string,
): Promise<Bathroom> {
  // `created_by` must equal the caller's uid or the RLS insert policy rejects it.
  const { data, error } = await supabase
    .from('bathrooms')
    .insert({ ...input, created_by: userId })
    .select('*')
    .single();
  if (error) throw error;
  return data as Bathroom;
}
