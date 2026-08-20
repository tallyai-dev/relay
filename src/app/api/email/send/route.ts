import { supabaseAdmin } from '@/lib/supabase';
import { gmailConfigured, sendGmail } from '@/lib/gmail';

// POST /api/email/send  { to, subject, body, leadId? }
// Prefers the Gmail API (sends AS the real mailbox, e.g. sales@gettallyai.com,
// with replies landing in that inbox where /api/email/sync reads them). Falls
// back to Postmark/SendGrid if those are configured instead. 503s cleanly when
// nothing is configured so the client shows "not delivered".
export async function POST(req: Request) {
  const { to, subject, body, leadId } = await req.json();
  if (!to) return Response.json({ error: 'No recipient.' }, { status: 400 });

  let from = '';
  let sendErr = '';
  let sent = false;

  if (gmailConfigured()) {
    from = process.env.GMAIL_SENDER || '';
    const r = await sendGmail(to, subject, body);
    sent = r.ok; sendErr = r.error || '';
  } else {
    const token = process.env.EMAIL_SERVER_TOKEN;
    from = process.env.EMAIL_FROM || '';
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
        sent = res.ok; if (!res.ok) sendErr = await res.text();
      } else {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: 'text/plain', value: body }] }),
        });
        sent = res.ok; if (!res.ok) sendErr = await res.text();
      }
    } catch (e: any) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  if (!sent) return Response.json({ error: sendErr || 'Send failed.' }, { status: 502 });

  let messageId: string | null = null;
  const db = supabaseAdmin();
  if (db) {
    const { data } = await db.from('messages').insert({
      lead_id: leadId ?? null, channel: 'email', direction: 'out',
      from_addr: from, to_addr: to, subject, body, is_read: true,
    }).select('id').single();
    messageId = data?.id ?? null;
  }
  return Response.json({ ok: true, messageId });
}
