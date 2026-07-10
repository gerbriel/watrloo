import { supabase } from '@/lib/supabase';
import type { Business, ClaimStatus, ClaimWithContext } from '@/types/db';

/** File a pending claim on a bathroom for a business the caller manages. */
export async function fileClaim(
  bathroomId: string,
  businessId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.from('bathroom_claims').insert({
    bathroom_id: bathroomId,
    business_id: businessId,
    status: 'pending',
    requested_by: userId,
  });
  if (error) throw error;
}

/**
 * The verified owner of a listing, if any — public, for the "Official" badge.
 * Only verified claims are world-readable, so pending ones never leak here.
 */
export async function getVerifiedOwner(
  bathroomId: string,
): Promise<Pick<Business, 'id' | 'name' | 'logo_url' | 'website'> | null> {
  const { data, error } = await supabase
    .from('bathroom_claims')
    .select('business:businesses(id, name, logo_url, website)')
    .eq('bathroom_id', bathroomId)
    .eq('status', 'verified')
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as {
    business: Pick<Business, 'id' | 'name' | 'logo_url' | 'website'> | null;
  } | null;
  return row?.business ?? null;
}

// --- Admin claim queue ------------------------------------------------------

export async function listClaims(status: ClaimStatus = 'pending'): Promise<ClaimWithContext[]> {
  const { data, error } = await supabase
    .from('bathroom_claims')
    .select('*, bathroom:bathrooms(id, name, address), business:businesses(id, name)')
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ClaimWithContext[];
}

/** Admin: verify (hand over control) or reject a pending claim. */
export async function reviewClaim(claimId: string, verify: boolean): Promise<void> {
  const { error } = await supabase.rpc('admin_review_claim', {
    p_claim_id: claimId,
    p_verify: verify,
  });
  if (error) throw error;
}
