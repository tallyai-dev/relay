import { supabaseAdmin } from '@/lib/supabase';

// POST /api/sms/inbound — set as the Messaging webhook on your Relay number.
// Stores the inbound text so it threads into the Inbox, then returns empty TwiML.
export async function POST(req: Request) {
  const form = await req.formData();
  const from = String(form.get('From') || '');
  const to = String(form.get('To') || '');
  const body = String(form.get('Body') || '');
  const sid = String(form.get('MessageSid') || '');

  const db = supabaseAdmin();
  if (db) {
    // Match the sender to a lead by phone (best-effort; normalize in production).
    const { data: lead } = await db
      .from('leads')
      .select('id')
      .ilike('phone', `%${from.replace(/[^0-9]/g, '').slice(-10)}%`)
      .maybeSingle();

    await db.from('messages').insert({
      lead_id: lead?.id ?? null,
      channel: 'text',
      direction: 'in',
      from_addr: from,
      to_addr: to,
      body,
      provider_id: sid,
      is_read: false,
    });
  }

  return new Response('<Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });
}
