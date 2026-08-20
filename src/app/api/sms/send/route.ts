import { twilioClient } from '@/lib/twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { toE164 } from '@/lib/csv';

// POST /api/sms/send  { to, body, leadId? }
// Returns { sid, status, messageId } on success, or { error } with a 4xx/5xx so
// the client can surface a real failure instead of silently dropping it.
export async function POST(req: Request) {
  const { to, body, leadId, repId } = await req.json();
  const client = twilioClient();
  if (!client) return Response.json({ error: 'Twilio auth not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).' }, { status: 503 });
  // Send from the rep's own number when they have one assigned, else the shared line.
  let from = process.env.TWILIO_CALLER_ID || '';
  if (repId) {
    const dbn = supabaseAdmin();
    if (dbn) {
      const { data } = await dbn.from('reps').select('phone_number').eq('id', repId).maybeSingle();
      if (data?.phone_number) from = data.phone_number;
    }
  }
  if (!from) return Response.json({ error: 'No sending number set (assign the rep a number, or set TWILIO_CALLER_ID).' }, { status: 503 });

  const toE = toE164(to) ?? String(to || '').trim();
  if (!toE) return Response.json({ error: 'No destination number.' }, { status: 400 });

  let msg;
  try {
    msg = await client.messages.create({ to: toE, from, body });
  } catch (e: any) {
    // Twilio rejected the send (bad number, unverified trial recipient, geo/permissions, etc.)
    console.error('sms/send twilio error', e?.code, e?.message);
    return Response.json({ error: e?.message || 'Twilio rejected the message.', code: e?.code }, { status: 502 });
  }

  let messageId: string | null = null;
  const db = supabaseAdmin();
  if (db) {
    const { data, error } = await db.from('messages').insert({
      lead_id: leadId ?? null,
      channel: 'text',
      direction: 'out',
      from_addr: from,
      to_addr: toE,
      body,
      provider_id: msg.sid,
      is_read: true,
    }).select('id').single();
    if (error) console.error('sms/send db insert', error);
    messageId = data?.id ?? null;
  }
  return Response.json({ sid: msg.sid, status: msg.status, messageId });
}
