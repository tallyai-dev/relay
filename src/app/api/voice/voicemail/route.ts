import twilio from 'twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { leadByPhone, twimlResponse } from '@/lib/voice-server';

// POST /api/voice/voicemail?leadId=  — Relay voicemail landed (nobody picked
// up the callback). Logs it on the lead's timeline as an inbound call with the
// recording, and pushes the lead to the top of the queue by making it due now.
// Called twice by Twilio (Record action + recording status) — deduped on the
// recording URL.
export async function POST(req: Request) {
  const u = new URL(req.url);
  let leadId = u.searchParams.get('leadId') || '';
  let form: FormData;
  try { form = await req.formData(); } catch { form = new FormData(); }
  const recordingUrl = String(form.get('RecordingUrl') || '');
  const duration = parseInt(String(form.get('RecordingDuration') || '0'), 10) || null;
  const from = String(form.get('From') || '');

  const db = supabaseAdmin();
  if (db && recordingUrl) {
    if (!leadId && from) leadId = (await leadByPhone(from))?.id || '';
    const { data: dupe } = await db.from('activities').select('id').eq('recording_url', recordingUrl).maybeSingle();
    if (!dupe && leadId) {
      await db.from('activities').insert({
        lead_id: leadId, kind: 'call', direction: 'in', disposition: 'voicemail',
        ai_note: 'They called the Relay number back and left a voicemail — nobody could pick up.',
        body: 'Inbound voicemail.', recording_url: recordingUrl, duration_s: duration,
      });
      await db.from('leads').update({ next_action_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', leadId);
    } else if (!dupe && !leadId) {
      // Unknown caller: keep it in messages so it shows in the Inbox under the number.
      await db.from('messages').insert({
        lead_id: null, channel: 'text', direction: 'in', from_addr: from, to_addr: process.env.TWILIO_CALLER_ID || null,
        body: `Voicemail (${duration || 0}s): ${recordingUrl}.mp3`, is_read: false,
      });
    }
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Thanks — talk soon.');
  twiml.hangup();
  return twimlResponse(twiml.toString());
}
