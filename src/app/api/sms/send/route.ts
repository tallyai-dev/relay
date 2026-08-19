import { twilioClient } from '@/lib/twilio';
import { supabaseAdmin } from '@/lib/supabase';

// POST /api/sms/send  { to, body, leadId? }
export async function POST(req: Request) {
  const { to, body, leadId } = await req.json();
  const client = twilioClient();
  const from = process.env.TWILIO_CALLER_ID;
  if (!client || !from) {
    return Response.json({ error: 'Twilio SMS not configured.' }, { status: 503 });
  }

  const msg = await client.messages.create({ to, from, body });

  const db = supabaseAdmin();
  if (db) {
    await db.from('messages').insert({
      lead_id: leadId ?? null,
      channel: 'text',
      direction: 'out',
      from_addr: from,
      to_addr: to,
      body,
      provider_id: msg.sid,
      is_read: true,
    });
  }
  return Response.json({ sid: msg.sid, status: msg.status });
}
