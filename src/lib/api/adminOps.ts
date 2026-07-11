import { supabase } from '@/lib/supabase';

/**
 * Admin Control Room API (migration 20260713010000). Every write here hits an
 * is_admin-gated SECURITY DEFINER RPC that writes a moderation_actions audit
 * row; the reads are admin-gated in SQL. This module is ergonomics only.
 */

// --- Settings ----------------------------------------------------------------

export type GrowthSettingKey =
  | 'promotions_enabled'
  | 'featured_capacity'
  | 'ad_frequency_cap_per_day'
  | 'k_anonymity_floor'
  | 'promo_global_cap_per_week'
  | 'promo_advertiser_cap_per_week';

export interface GrowthSetting {
  key: string;
  value: unknown;
  updated_at: string;
}

/** growth_settings is world-readable by design (caps aren't secrets). */
export async function listGrowthSettings(): Promise<GrowthSetting[]> {
  const { data, error } = await supabase.from('growth_settings').select('*').order('key');
  if (error) throw error;
  return (data ?? []) as GrowthSetting[];
}

export async function setGrowthSetting(key: GrowthSettingKey, value: unknown): Promise<void> {
  const { error } = await supabase.rpc('admin_set_growth_setting', {
    p_key: key,
    p_value: value,
  });
  if (error) throw error;
}

// --- Placements (delivery knobs) ----------------------------------------------

export interface AdminPlacement {
  placement_id: string;
  campaign_id: string;
  business_id: string;
  business_name: string;
  campaign_title: string;
  surface: string;
  region: string | null;
  starts_at: string;
  ends_at: string;
  weight: number;
  daily_impression_cap: number | null;
  delivered_today: number;
  campaign_status: string;
}

export async function listPlacements(): Promise<AdminPlacement[]> {
  const { data, error } = await supabase.rpc('admin_list_placements');
  if (error) throw error;
  return (data ?? []) as AdminPlacement[];
}

export async function updatePlacementDelivery(
  placementId: string,
  weight: number,
  dailyCap: number | null,
): Promise<void> {
  const { error } = await supabase.rpc('admin_update_placement_delivery', {
    p_placement_id: placementId,
    p_weight: weight,
    p_daily_cap: dailyCap,
  });
  if (error) throw error;
}

// --- Ads overview / IVT --------------------------------------------------------

export interface AdminAdRow {
  campaign_id: string;
  campaign_title: string;
  campaign_status: string;
  business_id: string;
  business_name: string;
  day: string;
  surface: string;
  impressions: number;
  clicks: number;
  unique_sessions: number;
  invalid_events: number;
}

export async function adOverview(sinceDay?: string): Promise<AdminAdRow[]> {
  const { data, error } = await supabase.rpc('admin_ad_overview', {
    p_since: sinceDay ?? null,
  });
  if (error) throw error;
  return (data ?? []) as AdminAdRow[];
}

export interface IvtRow {
  day: string;
  campaign_id: string;
  campaign_title: string;
  business_name: string;
  flag_reason: string | null;
  events: number;
}

export async function ivtBreakdown(sinceDay?: string): Promise<IvtRow[]> {
  const { data, error } = await supabase.rpc('admin_ivt_breakdown', {
    p_since: sinceDay ?? null,
  });
  if (error) throw error;
  return (data ?? []) as IvtRow[];
}

// --- Ops snapshot ---------------------------------------------------------------

export interface CronStatus {
  jobname: string;
  schedule: string;
  active: boolean;
  last_status: string | null;
  last_start: string | null;
  last_end: string | null;
}

export interface OpsSnapshot {
  crons: CronStatus[];
  rollup_fresh_at: string | null;
  events_today: number;
  invalid_today: number;
  offers_open: number;
  offers_total: number;
  salt_today: boolean;
  partitions: string[];
  running_campaigns: number;
  promotions_enabled: boolean;
}

export async function opsSnapshot(): Promise<OpsSnapshot> {
  const { data, error } = await supabase.rpc('admin_ops_snapshot');
  if (error) throw error;
  return data as OpsSnapshot;
}

// --- Audit log --------------------------------------------------------------------

export interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  actor: { username: string } | null;
}

/** moderation_actions is readable by moderators/admins via RLS. */
export async function listAuditLog(
  opts: { action?: string; targetType?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  let query = supabase
    .from('moderation_actions')
    .select('*, actor:profiles!moderation_actions_actor_id_fkey(username)')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.action) query = query.eq('action', opts.action);
  if (opts.targetType) query = query.eq('target_type', opts.targetType);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AuditRow[];
}
