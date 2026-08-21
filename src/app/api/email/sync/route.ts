import { supabaseAdmin } from '@/lib/supabase';
import { gmailConfigured, fetchReplies } from '@/lib/gmail';

// GET/POST /api/email/sync — pull recent Gmail replies into the Inbox.
// Called when the Inbox opens (and can be hit by a scheduled task). Dedupes on
// the Gmail message id (stored in provider_id) so replies never double-insert.
export const maxDuration = 26;

async function sync() {
  if (!gmailConfigured()) return Response.json({ skipped: 'gmail not configured' });
  const db = supabaseAdmin();
  if (!db) return Response.json({ skipped: 'no db' });

  const replies = await fetchReplies(25);
  if (!replies.length) return Response.json({ synced: 0 });

  // Skip anything already stored (by Gmail message id).
  const ids = replies.map((r) => r.id);
  const { data: existing } = await db.from('messages').select('provider_id').in('provider_id', ids);
  const seen = new Set((existing || []).map((r: any) => r.provider_id));

  let synced = 0;
  for (const rep of replies) {
    if (!rep.from || seen.has(rep.id)) continue;
    const { data: lead } = await db.from('leads').select('id').ilike('email', rep.from).maybeSingle();
    // Only pull mail that's part of a Relay conversation — the sender must be a
    // lead in the book. Newsletters, DMARC reports, and service mail stay in
    // Gmail instead of cluttering the Relay Inbox.
    if (!lead?.id) continue;
    const { error } = await db.from('messages').insert({
      lead_id: lead.id,
      channel: 'email',
      direction: 'in',
      from_addr: rep.from,
      subject: rep.subject,
      body: rep.body,
      provider_id: rep.id,
      is_read: false,
    });
    if (!error) synced++;
  }
  return Response.json({ synced });
}

export async function POST() { return sync(); }
export async function GET() { return sync(); }
