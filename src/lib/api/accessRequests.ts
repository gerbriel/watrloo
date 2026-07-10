import { supabase } from '@/lib/supabase';
import type { BusinessAccessRequest, NewAccessRequest, AccessRequestStatus } from '@/types/db';
import { sanitizeLine, sanitizeOptional } from '@/lib/sanitize';

/**
 * File a "request business access" form. Works with or without an account:
 * `userId` is null for anonymous submissions (the RLS "anyone can file" policy
 * requires a null requester_id in that case). All free-text is sanitized here so
 * nothing hostile is stored regardless of which form called us. Admins are
 * notified in-app (the open-request badge + the /admin/requests queue), so there
 * is no email dependency.
 */
export async function fileAccessRequest(
  input: NewAccessRequest,
  userId: string | null,
): Promise<void> {
  const clean = {
    business_name: sanitizeLine(input.business_name, 160),
    website: sanitizeOptional(input.website, 300),
    contact_email: sanitizeOptional(input.contact_email, 200),
    message: sanitizeOptional(input.message, 2000),
    locations_note: sanitizeOptional(input.locations_note, 4000),
  };
  const { error } = await supabase
    .from('business_access_requests')
    .insert({ ...clean, requester_id: userId });
  if (error) throw error;
}

// --- Admin access-request queue --------------------------------------------

export async function listAccessRequests(
  status: AccessRequestStatus = 'open',
): Promise<BusinessAccessRequest[]> {
  const { data, error } = await supabase
    .from('business_access_requests')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BusinessAccessRequest[];
}

/** Count of open requests — powers the in-app admin notification badge. */
export async function countOpenAccessRequests(): Promise<number> {
  const { count, error } = await supabase
    .from('business_access_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open');
  if (error) throw error;
  return count ?? 0;
}

/** Admin: approve a request. Creates the business + owner + subscription. */
export async function approveAccessRequest(
  requestId: string,
  plan = 'standard',
): Promise<string> {
  const { data, error } = await supabase.rpc('admin_approve_access_request', {
    p_request_id: requestId,
    p_plan: plan,
  });
  if (error) throw error;
  return data as string;
}

export async function rejectAccessRequest(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_reject_access_request', {
    p_request_id: requestId,
  });
  if (error) throw error;
}
