import twilio from 'twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { twimlResponse } from '@/lib/voice-server';

// POST /api/voice/call-status — the <Dial action> for outbound calls (in-app
// and cell bridge). Twilio posts what happened on the salon's side
// (DialCallStatus: completed / no-answer / busy / failed / canceled) and how long
// she was on the line. We store it on the call-history row, then hang up.
export async function POST(req: Request) {
  let form: FormData;
  try { form = await req.formData(); } catch { form = new FormData(); }
  const sid = String(form.get('CallSid') || '');
  const dialStatus = String(form.get('DialCallStatus') || '');
  const talk = parseInt(String(form.get('DialCallDuration') || '0'), 10);
  // Never let bookkeeping fail the call: Twilio plays an error if this route breaks.
  try {
    const db = supabaseAdmin();
    if (db && sid && dialStatus) {
      const { error } = await db.from('calls').update({ dial_status: dialStatus, talk_s: Number.isFinite(talk) ? talk : null }).eq('twilio_sid', sid);
      if (error) console.error('call-status', error.message);
    }
  } catch (e) { console.error('call-status', e); }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  return twimlResponse(twiml.toString());
}
