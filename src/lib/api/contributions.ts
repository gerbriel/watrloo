import { supabase } from '@/lib/supabase';
import { sanitizeLine, sanitizeOptional, sanitizeText } from '@/lib/sanitize';
import type { Bathroom, Review } from '@/types/db';

/**
 * A member's own contributions, and the edit-request flow for bathrooms
 * (migration 20260713080000). Creating a bathroom is a contribution;
 * changing it afterwards requires an admin-approved edit request. Reviews
 * are not part of this — authors always control their own reviews.
 */

export interface MyReview extends Review {
  bathroom: Pick<Bathroom, 'id' | 'name'> | null;
}

export async function myReviews(userId: string): Promise<MyReview[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*, bathroom:bathrooms(id, name)')
    .eq('author_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as MyReview[];
}

export async function myBathrooms(userId: string): Promise<Bathroom[]> {
  const { data, error } = await supabase
    .from('bathrooms')
    .select(
      'id,name,address,lat,lng,description,wheelchair_accessible,gender_neutral,changing_table,requires_key,created_by,created_at,deleted_at,deleted_by',
    )
    .eq('created_by', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as Bathroom[];
}

// --- Edit requests -------------------------------------------------------------

export interface ProposedEdit {
  name?: string;
  address?: string;
  description?: string | null;
  wheelchair_accessible?: boolean;
  gender_neutral?: boolean;
  changing_table?: boolean;
  requires_key?: boolean;
}

export interface EditRequest {
  id: string;
  bathroom_id: string;
  requester_id: string;
  proposed: ProposedEdit;
  note: string | null;
  status: 'open' | 'approved' | 'rejected';
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface EditRequestWithContext extends EditRequest {
  bathroom: Pick<Bathroom, 'id' | 'name' | 'address' | 'description'> | null;
  requester: { username: string } | null;
}

export async function fileBathroomEdit(
  bathroomId: string,
  proposed: ProposedEdit,
  note?: string,
): Promise<void> {
  const clean: ProposedEdit = {};
  if (proposed.name !== undefined) clean.name = sanitizeLine(proposed.name, 120);
  if (proposed.address !== undefined) clean.address = sanitizeLine(proposed.address, 300);
  if (proposed.description !== undefined)
    clean.description = sanitizeOptional(proposed.description, 2000);
  for (const k of [
    'wheelchair_accessible',
    'gender_neutral',
    'changing_table',
    'requires_key',
  ] as const) {
    if (proposed[k] !== undefined) clean[k] = proposed[k];
  }
  const { error } = await supabase.rpc('file_bathroom_edit', {
    p_bathroom_id: bathroomId,
    p_proposed: clean,
    p_note: note ? sanitizeText(note, 1000) : null,
  });
  if (error) throw error;
}

/** The caller's own edit requests (RLS scopes to self for non-moderators). */
export async function myEditRequests(): Promise<EditRequest[]> {
  const { data, error } = await supabase
    .from('bathroom_edit_requests')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EditRequest[];
}

// --- Admin queue -----------------------------------------------------------------

export async function listEditRequests(
  status: 'open' | 'approved' | 'rejected' = 'open',
): Promise<EditRequestWithContext[]> {
  const { data, error } = await supabase
    .from('bathroom_edit_requests')
    .select(
      `*,
       bathroom:bathrooms(id, name, address, description),
       requester:profiles!bathroom_edit_requests_requester_id_fkey(username)`,
    )
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as EditRequestWithContext[];
}

export async function decideBathroomEdit(
  requestId: string,
  approve: boolean,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_decide_bathroom_edit', {
    p_request_id: requestId,
    p_approve: approve,
    p_note: note ? sanitizeText(note, 1000) : null,
  });
  if (error) throw error;
}
