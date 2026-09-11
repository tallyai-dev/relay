import { supabaseAdmin } from '@/lib/supabase';
import { dmWindowOpen, igSendDm, metaConfigured } from '@/lib/social';

// POST /api/social/dm/send { leadId, body, repId?, humanAgent? }
// Sends an Instagram DM to the lead (needs her IGSID from a prior inbound DM or
// comment). Enforces Meta's 24-hour window — outside it, the client falls back
// to a text automatically. `humanAgent: true` uses the HUMAN_AGENT tag (7 days)
// once the app has that permission.
export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const leadId = String(body.leadId || '');
  const text = String(body.body || '').trim();
  const humanAgent = Boolean(body.humanAgent);
  if (!leadId || !text) return Response.json({ error: 'leadId and body required.' }, { status: 400 });
  if (!metaConfigured()) return Response.json({ error: 'Instagram is not connected yet (META_PAGE_TOKEN / META_IG_ACCOUNT_ID).', code: 'not_configured' }, { status: 503 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });

  const { data: lead } = await db.from('leads').select('id, ig_user_id, last_social_at').eq('id', leadId).maybeSingle();
  if (!lead?.ig_user_id) return Response.json({ error: 'No Instagram conversation with this lead yet — she has to DM or comment first.', code: 'no_igsid' }, { status: 400 });
  if (!humanAgent && !dmWindowOpen(lead.last_social_at)) {
    return Response.json({ error: 'Her 24-hour DM window is closed. Text her instead.', code: 'window_closed' }, { status: 409 });
  }

  let res: any;
  try {
    res = await igSendDm(lead.ig_user_id, text, humanAgent);
  } catch (e: any) {
    console.error('dm send', e?.code, e?.message);
    return Response.json({ error: e?.message || 'Instagram rejected the message.', code: e?.code }, { status: 502 });
  }
  const { data: row } = await db.from('messages').insert({
    lead_id: leadId, channel: 'dm', direction: 'out', from_addr: process.env.META_IG_ACCOUNT_ID || null, to_addr: lead.ig_user_id,
    body: text, provider_id: res?.message_id || null, is_read: true,
  }).select('id').single();
  return Response.json({ ok: true, messageId: row?.id || null, providerId: res?.message_id || null });
}
