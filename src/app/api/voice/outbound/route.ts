import twilio from 'twilio';
import { supabaseAdmin } from '@/lib/supabase';

// POST /api/voice/outbound  — TwiML App Voice URL.
// When the browser SDK places a call it hits this; we return TwiML that dials
// the target number from the rep's Relay caller ID.
//
// Recording: the call is recorded (both legs) and, when it ends, Twilio pings
// /api/voice/recording, which stores the audio and runs the AI transcript +
// summary onto the lead's timeline. leadId rides through as a query param on
// the recording callback so we know which lead to attach it to.
//
// Disclosure: OFF by default. Set RECORDING_DISCLOSURE to a spoken sentence
// (e.g. "This call may be recorded for quality.") to have Twilio announce it at
// the top of every call — a one-line change when you expand beyond one-party
// consent states like Utah.

// Public origin for Twilio callbacks (must be an absolute URL).
const BASE = process.env.PUBLIC_BASE_URL || 'https://tallyai-relay.netlify.app';

export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get('To') || '');
  const leadId = String(form.get('leadId') || '');
  const repId = String(form.get('repId') || '');
  // Dial from the rep's own number when assigned, else the shared caller ID.
  let callerId = process.env.TWILIO_CALLER_ID || '';
  if (repId) {
    const db = supabaseAdmin();
    if (db) {
      const { data } = await db.from('reps').select('phone_number').eq('id', repId).maybeSingle();
      if (data?.phone_number) callerId = data.phone_number;
    }
  }
  const disclosure = (process.env.RECORDING_DISCLOSURE || '').trim();

  const twiml = new twilio.twiml.VoiceResponse();
  if (to && callerId) {
    if (disclosure) twiml.say(disclosure);
    const recCb = `${BASE}/api/voice/recording${leadId ? `?leadId=${encodeURIComponent(leadId)}` : ''}`;
    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
      record: 'record-from-answer-dual',
      recordingStatusCallback: recCb,
      recordingStatusCallbackEvent: ['completed'],
      recordingStatusCallbackMethod: 'POST',
    });
    dial.number(to);
  } else {
    twiml.say('Relay is not fully configured. Set your caller ID.');
  }
  return new Response(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}
