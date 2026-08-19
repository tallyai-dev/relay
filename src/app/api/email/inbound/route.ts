import { supabaseAdmin } from '@/lib/supabase';

// POST /api/email/inbound — inbound-parse webhook (Postmark/SendGrid).
// Payload shape varies by provider; this handles Postmark's JSON and is easy to
// adapt. Stores the reply so it threads into the Inbox.
export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    const form = await req.formData().catch(() => null);
    if (form) payload = Object.fromEntries(form.entries());
  }

  const from = payload.From || payload.from || '';
  const subject = payload.Subject || payload.subject || '';
  const body =
    payload.TextBody || payload.text || payload.StrippedTextReply || payload['body-plain'] || '';

  const db = supabaseAdmin();
  if (db) {
    const { data: lead } = await db
      .from('leads')
      .select('id')
      .ilike('email', `%${from}%`)
      .maybeSingle();

    await db.from('messages').insert({
      lead_id: lead?.id ?? null,
      channel: 'email',
      direction: 'in',
      from_addr: from,
      subject,
      body,
      is_read: false,
    });
  }
  return Response.json({ ok: true });
}
