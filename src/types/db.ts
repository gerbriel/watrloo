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
  /** Set when a moderator removes it. Hidden from the public by RLS. */
  deleted_at: string | null;
  deleted_by: Uuid | null;
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
  /** Set when a moderator removes it. Hidden from the public by RLS. */
  deleted_at: string | null;
  deleted_by: Uuid | null;
}

export interface ReviewPhoto {
  id: Uuid;
  review_id: Uuid;
  storage_path: string;
  created_at: string;
}

/** Live-review count per profile, from the `reviewer_stats` view. Feeds the
 *  reviewer rank ladder in src/lib/ranks.ts. */
export interface ReviewerStats {
  profile_id: Uuid;
  review_count: number;
}

/** A review with its author and photos resolved, as the detail page needs it.
 *  `review_count` is the author's total live reviews (their rank), merged in
 *  from `reviewer_stats` by the API. */
export interface ReviewWithAuthor extends Review {
  author: Pick<Profile, 'id' | 'username' | 'avatar_url'> & {
    review_count: number;
  };
  photos: ReviewPhoto[];
}

// --- Roles & moderation ----------------------------------------------------

/** Absence of a row means the base "user" tier; see docs/ops/USERS_AND_ROLES.md. */
export type AppRole = 'moderator' | 'admin';

export interface UserRole {
  user_id: Uuid;
  role: AppRole;
  granted_by: Uuid | null;
  granted_at: string;
}

export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface Report {
  id: Uuid;
  reporter_id: Uuid | null;
  review_id: Uuid | null;
  bathroom_id: Uuid | null;
  ad_campaign_id: Uuid | null;
  reason: string;
  status: ReportStatus;
  resolved_by: Uuid | null;
  resolved_at: string | null;
  created_at: string;
}

/** A report with its reporter and target resolved, as the admin queue renders it. */
export interface ReportWithTarget extends Report {
  reporter: Pick<Profile, 'username'> | null;
  review:
    | (Pick<Review, 'id' | 'body' | 'rating' | 'bathroom_id' | 'deleted_at'> & {
        author: Pick<Profile, 'username'> | null;
      })
    | null;
  bathroom: Pick<Bathroom, 'id' | 'name' | 'address' | 'deleted_at'> | null;
  ad_campaign: {
    id: Uuid;
    creative: { title?: string; body?: string };
    status: string;
    business: { name: string } | null;
  } | null;
}

// --- Write payloads --------------------------------------------------------

export type NewBathroom = Omit<
  Bathroom,
  'id' | 'created_by' | 'created_at' | 'deleted_at' | 'deleted_by'
>;

export type NewReview = Pick<
  Review,
  'bathroom_id' | 'rating' | 'cleanliness' | 'privacy' | 'accessibility' | 'body'
>;

/** A user's flag on exactly one target. `reporter_id` is set by the API. */
export interface NewReport {
  review_id?: Uuid;
  bathroom_id?: Uuid;
  ad_campaign_id?: Uuid;
  reason: string;
}

// --- Map -------------------------------------------------------------------

/** Bounding box for the map's viewport query. */
export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export const STORAGE_BUCKET = 'review-photos';

// --- Business accounts (paid tier) -----------------------------------------

export type BusinessRole = 'owner' | 'manager' | 'staff';

export interface Business {
  id: Uuid;
  name: string;
  slug: string | null;
  website: string | null;
  logo_url: string | null;
  owner_id: Uuid | null;
  created_at: string;
}

export interface BusinessMember {
  business_id: Uuid;
  user_id: Uuid;
  role: BusinessRole;
  created_at: string;
}

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled';

export interface Subscription {
  business_id: Uuid;
  plan: string;
  status: SubscriptionStatus;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  updated_at: string;
}

export type ClaimStatus = 'pending' | 'verified' | 'rejected';

export interface BathroomClaim {
  id: Uuid;
  bathroom_id: Uuid;
  business_id: Uuid;
  status: ClaimStatus;
  requested_by: Uuid | null;
  reviewed_by: Uuid | null;
  created_at: string;
  reviewed_at: string | null;
}

export type AccessRequestStatus = 'open' | 'approved' | 'rejected';

export interface BusinessAccessRequest {
  id: Uuid;
  requester_id: Uuid | null;
  business_name: string;
  website: string | null;
  contact_email: string | null;
  message: string | null;
  locations_note: string | null;
  /** Existing bathrooms the requester picked to claim. */
  requested_bathroom_ids: Uuid[];
  /** Free-text locations they say aren't on Watrloo yet. */
  requested_new_locations: string[];
  status: AccessRequestStatus;
  reviewed_by: Uuid | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface ReviewResponse {
  id: Uuid;
  review_id: Uuid;
  business_id: Uuid;
  author_id: Uuid | null;
  body: string;
  created_at: string;
  updated_at: string;
}

// --- Business write payloads / composites ----------------------------------

export interface NewAccessRequest {
  business_name: string;
  website?: string | null;
  contact_email?: string | null;
  message?: string | null;
  locations_note?: string | null;
  requested_bathroom_ids?: string[];
  requested_new_locations?: string[];
}

/** The exact facts a business may edit on a claimed listing (never reviews). */
export type ListingUpdate = Pick<
  Bathroom,
  | 'name'
  | 'address'
  | 'description'
  | 'wheelchair_accessible'
  | 'gender_neutral'
  | 'changing_table'
  | 'requires_key'
>;

/** A business the caller belongs to, with their role and its subscription. */
export interface MyBusiness extends Business {
  role: BusinessRole;
  subscription: Subscription | null;
}

/** A claim joined to its bathroom + business, for the admin queue. */
export interface ClaimWithContext extends BathroomClaim {
  bathroom: Pick<Bathroom, 'id' | 'name' | 'address'> | null;
  business: Pick<Business, 'id' | 'name'> | null;
}

/** A bathroom a business has claimed, with the claim status, for the dashboard. */
export interface ClaimedListing {
  claim_id: Uuid;
  status: ClaimStatus;
  bathroom: Bathroom;
}
