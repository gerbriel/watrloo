import { supabase } from '@/lib/supabase';

/**
 * Growth platform API: consent, the in-app message center, featured placements,
 * and the campaign lifecycle. Everything here is a thin wrapper over RPCs and
 * RLS-scoped reads — the database enforces consent, caps, and roles; this layer
 * is ergonomics only.
 */

// --- Types (mirrors 20260712000000_growth_phase0_featured.sql) --------------

export interface UserConsent {
  user_id: string;
  marketing_opt_in: boolean;
  location_opt_in: boolean;
  analytics_opt_in: boolean;
  newsletter_opt_out: boolean;
  gpc_detected: boolean;
  consent_updated_at: string;
}

export interface InAppMessage {
  send_id: string;
  campaign_id: string;
  business_name: string;
  creative: { title?: string; body?: string; link?: string };
  status: 'queued' | 'delivered' | 'read' | 'failed';
  created_at: string;
  read_at: string | null;
}

export type CampaignType = 'in_app_blast' | 'featured';
export type CampaignStatus =
  | 'draft' | 'pending_review' | 'approved' | 'running'
  | 'paused' | 'done' | 'rejected';

export interface AdCampaign {
  id: string;
  business_id: string;
  type: CampaignType;
  status: CampaignStatus;
  creative: { title?: string; body?: string; link?: string };
  bathroom_id: string | null;
  target_region: string | null;
  surface: 'browse' | 'map' | 'detail' | 'newsletter' | null;
  starts_at: string | null;
  ends_at: string | null;
  reject_reason: string | null;
  created_at: string;
  submitted_at: string | null;
}

export interface FeaturedItem {
  placement_id: string;
  campaign_id: string;
  business_id: string;
  business_name: string;
  bathroom_id: string | null;
  creative: { title?: string; body?: string; link?: string };
  region: string | null;
}

// --- Consent -----------------------------------------------------------------

export async function getMyConsent(userId: string): Promise<UserConsent | null> {
  const { data, error } = await supabase
    .from('user_consents')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UserConsent | null) ?? null;
}

/** Nulls leave a toggle unchanged; the RPC stamps time + source server-side. */
export async function setConsent(patch: {
  marketing?: boolean;
  location?: boolean;
  analytics?: boolean;
  newsletterOptOut?: boolean;
  source?: string;
}): Promise<void> {
  const gpc =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true;
  const { error } = await supabase.rpc('set_consent', {
    p_marketing: patch.marketing ?? null,
    p_location: patch.location ?? null,
    p_analytics: patch.analytics ?? null,
    p_newsletter_opt_out: patch.newsletterOptOut ?? null,
    p_gpc: gpc,
    p_source: patch.source ?? 'settings',
  });
  if (error) throw error;
}

// --- Message center ----------------------------------------------------------

export async function listMyMessages(): Promise<InAppMessage[]> {
  const { data, error } = await supabase.rpc('my_messages');
  if (error) throw error;
  return (data ?? []) as InAppMessage[];
}

export async function markMessageRead(sendId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_message_read', { p_send_id: sendId });
  if (error) throw error;
}

// --- Featured placements (public, contextual, zero user data) ----------------

export async function activeFeatured(
  surface: 'browse' | 'map' | 'detail',
  region?: string,
): Promise<FeaturedItem[]> {
  const { data, error } = await supabase.rpc('active_featured', {
    p_surface: surface,
    p_region: region ?? null,
  });
  if (error) throw error;
  return (data ?? []) as FeaturedItem[];
}

// --- Campaigns: business side --------------------------------------------------

export async function listCampaigns(businessId: string): Promise<AdCampaign[]> {
  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AdCampaign[];
}

export async function createCampaign(input: {
  businessId: string;
  type: CampaignType;
  creative: { title: string; body: string; link?: string };
  bathroomId?: string;
  surface?: 'browse' | 'map' | 'detail';
  region?: string;
  startsAt?: string;
  endsAt?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_campaign', {
    p_business_id: input.businessId,
    p_type: input.type,
    p_creative: input.creative,
    p_bathroom_id: input.bathroomId ?? null,
    p_surface: input.surface ?? null,
    p_region: input.region ?? null,
    p_starts_at: input.startsAt ?? null,
    p_ends_at: input.endsAt ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function submitCampaign(campaignId: string): Promise<void> {
  const { error } = await supabase.rpc('submit_campaign', {
    p_campaign_id: campaignId,
  });
  if (error) throw error;
}

// --- Campaigns: admin side -----------------------------------------------------

export async function listPendingCampaigns(): Promise<
  (AdCampaign & { business: { name: string } | null })[]
> {
  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('*, business:businesses(name)')
    .eq('status', 'pending_review')
    .order('submitted_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as (AdCampaign & { business: { name: string } | null })[];
}

export async function reviewCampaign(
  campaignId: string,
  approve: boolean,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_review_campaign', {
    p_campaign_id: campaignId,
    p_approve: approve,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}
