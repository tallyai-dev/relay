// Server-side text sending shared by /api/sms/send, the Eryn no-answer texts,
// and anything else that texts a lead without a browser in the loop.
// One place for the from-number rule and the DNC guard.
import { twilioClient } from '@/lib/twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { toE164 } from '@/lib/csv';

export type SmsResult =
  | { ok: true; sid: string; status: string; messageId: string | null; from: string }
  | { ok: false; error: string; status: number; code?: string | number };

export async function sendSmsServer(opts: { to: string; body: string; leadId?: string | null; repId?: string | null }): Promise<SmsResult> {
  const client = twilioClient();
  if (!client) return { ok: false, status: 503, error: 'Twilio auth not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).' };
  const db = supabaseAdmin();

  // Never text a salon that said stop.
  if (db && opts.leadId) {
    const { data: l } = await db.from('leads').select('dnc').eq('id', opts.leadId).maybeSingle();
    if (l?.dnc) return { ok: false, status: 400, error: 'This salon asked us to stop (DNC).' };
  }

  // Send from the rep's own number when they have one assigned, else the shared line.
  let from = process.env.TWILIO_CALLER_ID || '';
  if (opts.repId && db) {
    const { data } = await db.from('reps').select('phone_number').eq('id', opts.repId).maybeSingle();
    if (data?.phone_number) from = data.phone_number;
  }
  if (!from) return { ok: false, status: 503, error: 'No sending number set (assign the rep a number, or set TWILIO_CALLER_ID).' };

  const toE = toE164(opts.to) ?? String(opts.to || '').trim();
  if (!toE) return { ok: false, status: 400, error: 'No destination number.' };

  let msg;
  try {
    msg = await client.messages.create({ to: toE, from, body: opts.body });
  } catch (e: any) {
    console.error('sms-server twilio error', e?.code, e?.message);
    return { ok: false, status: 502, error: e?.message || 'Twilio rejected the message.', code: e?.code };
  }

  let messageId: string | null = null;
  if (db) {
    const { data, error } = await db.from('messages').insert({
      lead_id: opts.leadId ?? null,
      channel: 'text',
      direction: 'out',
      from_addr: from,
      to_addr: toE,
      body: opts.body,
      provider_id: msg.sid,
      is_read: true,
    }).select('id').single();
    if (error) console.error('sms-server db insert', error);
    messageId = data?.id ?? null;
  }
  return { ok: true, sid: msg.sid, status: msg.status, messageId, from };
}
