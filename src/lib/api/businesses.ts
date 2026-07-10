import { supabase } from '@/lib/supabase';
import { sanitizeLine, sanitizeOptional, sanitizeText } from '@/lib/sanitize';
import type {
  Business,
  BusinessMember,
  BusinessRole,
  ClaimedListing,
  ListingUpdate,
  MyBusiness,
  Profile,
  ReviewResponse,
  Subscription,
} from '@/types/db';

const BATHROOM_COLUMNS =
  'id,name,address,lat,lng,description,wheelchair_accessible,gender_neutral,changing_table,requires_key,created_by,created_at,deleted_at,deleted_by';

/** Postgrest returns a one-to-one embed as either an object or a 1-element array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// --- Business membership / profile -----------------------------------------

export async function listMyBusinesses(userId: string): Promise<MyBusiness[]> {
  const { data, error } = await supabase
    .from('business_members')
    .select('role, business:businesses(*, subscription:subscriptions(*))')
    .eq('user_id', userId);
  if (error) throw error;
  return ((data ?? []) as unknown as {
    role: BusinessRole;
    business: Business & { subscription: Subscription | Subscription[] | null };
  }[]).map((row) => ({
    ...row.business,
    role: row.role,
    subscription: one(row.business.subscription),
  }));
}

export async function getBusiness(id: string): Promise<MyBusiness | null> {
  const { data, error } = await supabase
    .from('businesses')
    .select('*, subscription:subscriptions(*), members:business_members(role, user_id)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as Business & {
    subscription: Subscription | Subscription[] | null;
    members: { role: BusinessRole; user_id: string }[];
  };
  return { ...row, subscription: one(row.subscription), role: 'staff' } as MyBusiness;
}

export async function updateBusinessProfile(
  id: string,
  patch: Partial<Pick<Business, 'name' | 'website' | 'logo_url' | 'slug'>>,
): Promise<void> {
  const clean: typeof patch = {};
  if (patch.name !== undefined) clean.name = sanitizeLine(patch.name ?? '', 160);
  if (patch.website !== undefined) clean.website = sanitizeOptional(patch.website, 300);
  if (patch.logo_url !== undefined) clean.logo_url = sanitizeOptional(patch.logo_url, 500);
  if (patch.slug !== undefined) clean.slug = sanitizeOptional(patch.slug, 80);
  const { error } = await supabase.from('businesses').update(clean).eq('id', id);
  if (error) throw error;
}

// --- Claimed listings -------------------------------------------------------

export async function listBusinessListings(businessId: string): Promise<ClaimedListing[]> {
  const { data, error } = await supabase
    .from('bathroom_claims')
    .select(`id, status, bathroom:bathrooms(${BATHROOM_COLUMNS})`)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as {
    id: string;
    status: ClaimedListing['status'];
    bathroom: ClaimedListing['bathroom'];
  }[]).map((r) => ({ claim_id: r.id, status: r.status, bathroom: r.bathroom }));
}

/** Edit a claimed listing's facts. Server re-checks the caller manages it. */
export async function updateListing(bathroomId: string, patch: ListingUpdate): Promise<void> {
  const { error } = await supabase.rpc('business_update_listing', {
    p_bathroom_id: bathroomId,
    p_name: sanitizeLine(patch.name, 120),
    p_address: sanitizeLine(patch.address, 300),
    p_description: sanitizeOptional(patch.description, 2000),
    p_wheelchair_accessible: patch.wheelchair_accessible,
    p_gender_neutral: patch.gender_neutral,
    p_changing_table: patch.changing_table,
    p_requires_key: patch.requires_key,
  });
  if (error) throw error;
}

// --- Owner responses to reviews --------------------------------------------

export interface ReviewResponseWithBusiness extends ReviewResponse {
  business: Pick<Business, 'id' | 'name' | 'logo_url'> | null;
}

export async function getReviewResponse(
  reviewId: string,
): Promise<ReviewResponseWithBusiness | null> {
  const { data, error } = await supabase
    .from('review_responses')
    .select('*, business:businesses(id, name, logo_url)')
    .eq('review_id', reviewId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ReviewResponseWithBusiness | null) ?? null;
}

export async function respondToReview(reviewId: string, body: string): Promise<void> {
  const { error } = await supabase.rpc('business_respond_to_review', {
    p_review_id: reviewId,
    p_body: sanitizeText(body, 2000),
  });
  if (error) throw error;
}

// --- Team members -----------------------------------------------------------

export interface MemberWithProfile extends BusinessMember {
  profile: Pick<Profile, 'id' | 'username' | 'avatar_url'> | null;
}

export async function listBusinessMembers(businessId: string): Promise<MemberWithProfile[]> {
  const { data, error } = await supabase
    .from('business_members')
    .select('*, profile:profiles(id, username, avatar_url)')
    .eq('business_id', businessId)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as unknown as MemberWithProfile[];
}

export async function addMember(
  businessId: string,
  userId: string,
  role: Exclude<BusinessRole, 'owner'>,
): Promise<void> {
  const { error } = await supabase.rpc('business_add_member', {
    p_business_id: businessId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}

export async function removeMember(businessId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('business_remove_member', {
    p_business_id: businessId,
    p_user_id: userId,
  });
  if (error) throw error;
}
