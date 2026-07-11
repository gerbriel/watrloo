import { supabase } from '@/lib/supabase';
import { clientSeed, sessionSeed } from '@/lib/ads/session';

/**
 * Client API for the ad-serving foundation (migration
 * 20260713000000_ad_serving_foundation.sql). Selection and event integrity are
 * all server-side; this layer only carries ids around. An ad impression flows:
 * pickFeatured() -> render -> confirmAdView(offer) when actually visible ->
 * confirmAdClick(offer) on click -> recordAdViewTime(offer) on unmount.
 */

export interface AdOfferItem {
  offer_id: string;
  placement_id: string;
  campaign_id: string;
  business_id: string;
  business_name: string;
  bathroom_id: string | null;
  creative: { title?: string; body?: string; link?: string };
  region: string | null;
}

export async function pickFeatured(
  surface: 'browse' | 'map' | 'detail',
  opts: { region?: string; lat?: number; lng?: number } = {},
): Promise<AdOfferItem[]> {
  const { data, error } = await supabase.rpc('pick_featured', {
    p_surface: surface,
    p_region: opts.region ?? null,
    p_session_seed: sessionSeed(),
    p_client_seed: clientSeed(),
    p_lat: opts.lat ?? null,
    p_lng: opts.lng ?? null,
  });
  if (error) throw error;
  return (data ?? []) as AdOfferItem[];
}

/** Fire-and-forget: never let ad accounting break the page. */
export function confirmAdView(offerId: string): void {
  void supabase.rpc('confirm_ad_view', { p_offer_id: offerId }).then(
    () => undefined,
    () => undefined,
  );
}

export function confirmAdClick(offerId: string): void {
  void supabase.rpc('confirm_ad_click', { p_offer_id: offerId }).then(
    () => undefined,
    () => undefined,
  );
}

export function recordAdViewTime(offerId: string, seconds: number): void {
  void supabase
    .rpc('record_ad_view_time', { p_offer_id: offerId, p_seconds: Math.round(seconds) })
    .then(
      () => undefined,
      () => undefined,
    );
}

// --- Reporting ---------------------------------------------------------------

export interface AdDailyStat {
  campaign_id: string;
  business_id: string;
  day: string;
  surface: string;
  impressions: number;
  clicks: number;
  unique_sessions: number;
  invalid_events: number;
}

/**
 * Daily rollups for one business (all its campaigns), most recent first.
 * RLS restricts rows to the caller's businesses (admins see all).
 */
export async function listAdDailyStats(
  businessId: string,
  opts: { sinceDay?: string; surface?: string } = {},
): Promise<AdDailyStat[]> {
  let query = supabase
    .from('ad_daily_stats')
    .select('*')
    .eq('business_id', businessId)
    .order('day', { ascending: false });
  if (opts.sinceDay) query = query.gte('day', opts.sinceDay);
  if (opts.surface) query = query.eq('surface', opts.surface);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AdDailyStat[];
}
