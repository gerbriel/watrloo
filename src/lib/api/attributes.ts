import { supabase } from '@/lib/supabase';
import { sanitizeLine } from '@/lib/sanitize';

/**
 * Standardized attribute taxonomy (migration 20260713020000): admin-defined
 * amenities ("good") and cautions ("cons"), attachable to any bathroom by its
 * creator, a verified claiming business manager, or a moderator. The four
 * legacy boolean amenities are separate and unchanged.
 */

export type AttributeKind = 'amenity' | 'caution' | 'category';

export interface AttributeDef {
  slug: string;
  label: string;
  kind: AttributeKind;
  description: string | null;
  active: boolean;
  sort: number;
  created_at: string;
}

/** Active defs for pickers/badges; pass activeOnly=false in the admin editor. */
export async function listAttributeDefs(activeOnly = true): Promise<AttributeDef[]> {
  let query = supabase
    .from('attribute_defs')
    .select('*')
    .order('kind')
    .order('sort')
    .order('label');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AttributeDef[];
}

/** The attribute slugs currently on one bathroom. */
export async function bathroomAttributes(bathroomId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('bathroom_attributes')
    .select('attribute_slug')
    .eq('bathroom_id', bathroomId);
  if (error) throw error;
  return ((data ?? []) as { attribute_slug: string }[]).map((r) => r.attribute_slug);
}

/** Replace-set the bathroom's attributes. Authorization is in the RPC. */
export async function setBathroomAttributes(
  bathroomId: string,
  slugs: string[],
): Promise<void> {
  const { error } = await supabase.rpc('set_bathroom_attributes', {
    p_bathroom_id: bathroomId,
    p_slugs: slugs,
  });
  if (error) throw error;
}

/**
 * Community upkeep: any signed-in user flips ONE tag on a live bathroom
 * (migration 20260714000000). Publishes immediately, logged server-side in
 * attribute_edits — same reactive trust model as reviews. Wholesale rewrites
 * stay with setBathroomAttributes and its stricter gate.
 */
export async function toggleBathroomAttribute(
  bathroomId: string,
  slug: string,
  add: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('toggle_bathroom_attribute', {
    p_bathroom_id: bathroomId,
    p_slug: slug,
    p_add: add,
  });
  if (error) throw error;
}

/** Admin: create or update a taxonomy entry (audited). */
export async function upsertAttribute(def: {
  slug: string;
  label: string;
  kind: AttributeKind;
  description?: string | null;
  active?: boolean;
  sort?: number;
}): Promise<void> {
  const { error } = await supabase.rpc('admin_upsert_attribute', {
    p_slug: def.slug.trim().toLowerCase(),
    p_label: sanitizeLine(def.label, 60),
    p_kind: def.kind,
    p_description: def.description ? sanitizeLine(def.description, 200) : null,
    p_active: def.active ?? true,
    p_sort: def.sort ?? 100,
  });
  if (error) throw error;
}
