import { supabase } from '@/lib/supabase';
import type { NewReport, ReportStatus, ReportWithTarget } from '@/types/db';

/**
 * File a report against exactly one target (a review or a bathroom). RLS
 * requires `reporter_id` to equal the caller, and the table's CHECK enforces
 * the exactly-one-target rule, so a malformed call fails at the database.
 */
export async function fileReport(
  input: NewReport,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('reports')
    .insert({ ...input, reporter_id: userId });
  if (error) throw error;
}

/**
 * The moderator queue. Embeds the reporter, and whichever target the report
 * points at, in one round-trip. Only moderators get rows back for statuses
 * other than their own reports — the "read own reports or all as moderator"
 * policy handles that server-side.
 */
export async function listReports(
  status: ReportStatus = 'open',
): Promise<ReportWithTarget[]> {
  const { data, error } = await supabase
    .from('reports')
    .select(
      `*,
       reporter:profiles!reports_reporter_id_fkey(username),
       review:reviews(id, body, rating, bathroom_id, deleted_at, author:profiles!reviews_author_id_fkey(username)),
       bathroom:bathrooms(id, name, address, deleted_at),
       ad_campaign:ad_campaigns(id, creative, status, business:businesses(name))`,
    )
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ReportWithTarget[];
}
