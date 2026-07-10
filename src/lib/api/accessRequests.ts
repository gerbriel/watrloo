import { supabase } from '@/lib/supabase';
import type { BusinessAccessRequest, NewAccessRequest, AccessRequestStatus } from '@/types/db';

/**
 * File a "request business access" form and best-effort notify the admin by
 * email. The row is what matters (it shows in the admin queue); the email is a
 * convenience, so a failed invoke never blocks the request.
 */
export async function fileAccessRequest(
  input: NewAccessRequest,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('business_access_requests')
    .insert({ ...input, requester_id: userId });
  if (error) throw error;

  try {
    await supabase.functions.invoke('notify-access-request', {
      body: { business_name: input.business_name, contact_email: input.contact_email },
    });
  } catch {
    /* email is best-effort; the request is already recorded */
  }
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
