/**
 * Hand-maintained mirror of supabase/migrations. If you change the schema,
 * change this file in the same commit.
 */

export type Uuid = string;

/** 1–5, inclusive. */
export type Score = 1 | 2 | 3 | 4 | 5;

export interface Profile {
  id: Uuid;
  username: string;
  avatar_url: string | null;
  created_at: string;
}

/** The four amenity flags, kept as a named type so UI can iterate them. */
export interface Amenities {
  wheelchair_accessible: boolean;
  gender_neutral: boolean;
  changing_table: boolean;
  requires_key: boolean;
}

export const AMENITY_KEYS = [
  'wheelchair_accessible',
  'gender_neutral',
  'changing_table',
  'requires_key',
] as const satisfies readonly (keyof Amenities)[];

export const AMENITY_LABELS: Record<keyof Amenities, string> = {
  wheelchair_accessible: 'Wheelchair accessible',
  gender_neutral: 'Gender neutral',
  changing_table: 'Changing table',
  requires_key: 'Requires a key',
};

export interface Bathroom extends Amenities {
  id: Uuid;
  name: string;
  address: string;
  lat: number;
  lng: number;
  description: string | null;
  created_by: Uuid | null;
  created_at: string;
}

/** Aggregates from the `bathroom_stats` view. Null when review_count is 0. */
export interface BathroomStats {
  bathroom_id: Uuid;
  review_count: number;
  avg_rating: number | null;
  avg_cleanliness: number | null;
  avg_privacy: number | null;
  avg_accessibility: number | null;
}

/** What list and detail views actually render: a bathroom joined to its stats. */
export interface BathroomWithStats extends Bathroom {
  stats: BathroomStats;
}

export interface Review {
  id: Uuid;
  bathroom_id: Uuid;
  author_id: Uuid;
  rating: Score;
  cleanliness: Score | null;
  privacy: Score | null;
  accessibility: Score | null;
  body: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewPhoto {
  id: Uuid;
  review_id: Uuid;
  storage_path: string;
  created_at: string;
}

/** A review with its author and photos resolved, as the detail page needs it. */
export interface ReviewWithAuthor extends Review {
  author: Pick<Profile, 'id' | 'username' | 'avatar_url'>;
  photos: ReviewPhoto[];
}

// --- Write payloads --------------------------------------------------------

export type NewBathroom = Omit<Bathroom, 'id' | 'created_by' | 'created_at'>;

export type NewReview = Pick<
  Review,
  'bathroom_id' | 'rating' | 'cleanliness' | 'privacy' | 'accessibility' | 'body'
>;

// --- Map -------------------------------------------------------------------

/** Bounding box for the map's viewport query. */
export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export const STORAGE_BUCKET = 'review-photos';
