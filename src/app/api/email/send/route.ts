import { supabaseAdmin } from '@/lib/supabase';
import { gmailConfigured, sendGmail } from '@/lib/gmail';

// POST /api/email/send  { to, subject, body, leadId? }
// Prefers the Gmail API (sends AS the real mailbox, e.g. sales@gettallyai.com,
// with replies landing in that inbox where /api/email/sync reads them). Falls
// back to Postmark/SendGrid if those are configured instead. 503s cleanly when
// nothing is configured so the client shows "not delivered".
//
// The outbound row is inserted BEFORE sending so its id can key the open/click
// tracking pixel + link redirects (Gmail path only). On send failure the row is
// removed so no phantom "sent" message lingers.
export async function POST(req: Request) {
  const { to, subject, body, leadId } = await req.json();
  if (!to) return Response.json({ error: 'No recipient.' }, { status: 400 });

  const usingGmail = gmailConfigured();
  const from = usingGmail ? (process.env.GMAIL_SENDER || '') : (process.env.EMAIL_FROM || '');
  const provider = process.env.EMAIL_PROVIDER || 'postmark';
  const token = process.env.EMAIL_SERVER_TOKEN;
  if (!usingGmail && (!token || !from)) {
    return Response.json({ error: 'Email not configured.' }, { status: 503 });
  }

  const db = supabaseAdmin();
  let messageId: string | null = null;
  if (db) {
    const { data } = await db.from('messages').insert({
      lead_id: leadId ?? null, channel: 'email', direction: 'out',
      from_addr: from, to_addr: to, subject, body, is_read: true,
    }).select('id').single();
    messageId = data?.id ?? null;
  }

  let sendErr = '';
  let sent = false;

  if (usingGmail) {
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://tallyai-relay.netlify.app';
    const track = messageId ? { id: messageId, baseUrl } : undefined;
    const r = await sendGmail(to, subject, body, track);
    sent = r.ok; sendErr = r.error || '';
  } else {
    try {
      if (provider === 'postmark') {
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': token! },
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
      if (db && messageId) await db.from('messages').delete().eq('id', messageId);
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  if (!sent) {
    if (db && messageId) await db.from('messages').delete().eq('id', messageId);
    return Response.json({ error: sendErr || 'Send failed.' }, { status: 502 });
  }

  return Response.json({ ok: true, messageId });
}
