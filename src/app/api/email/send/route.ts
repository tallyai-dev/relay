import { supabaseAdmin } from '@/lib/supabase';

// POST /api/email/send  { to, subject, body, leadId? }
// Sends via Postmark (default) or SendGrid depending on EMAIL_PROVIDER.
// 503s cleanly when unconfigured so the client falls through.
export async function POST(req: Request) {
  const { to, subject, body, leadId } = await req.json();
  const token = process.env.EMAIL_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  const provider = process.env.EMAIL_PROVIDER || 'postmark';
  if (!token || !from) {
    return Response.json({ error: 'Email not configured.' }, { status: 503 });
  }

  try {
    if (provider === 'postmark') {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: body, MessageStream: 'outbound' }),
      });
      if (!res.ok) return Response.json({ error: await res.text() }, { status: 502 });
    } else {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject,
          content: [{ type: 'text/plain', value: body }],
        }),
      });
      if (!res.ok) return Response.json({ error: await res.text() }, { status: 502 });
    }

    const db = supabaseAdmin();
    if (db) {
      await db.from('messages').insert({
        lead_id: leadId ?? null, channel: 'email', direction: 'out',
        from_addr: from, to_addr: to, subject, body, is_read: true,
      });
    }
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
