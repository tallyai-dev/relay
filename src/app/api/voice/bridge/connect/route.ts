import twilio from 'twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { BASE, twimlResponse } from '@/lib/voice-server';

// POST /api/voice/bridge/connect?to=&leadId=&repId=
// Twilio hits this the moment the rep answers their cell. We say who we're
// connecting them to, then dial the salon from the Relay caller ID, recording
// both legs; the recording callback attaches the transcript + AI summary to the
// lead (same path as the in-app dialer).
export async function POST(req: Request) {
  const u = new URL(req.url);
  const to = u.searchParams.get('to') || '';
  const leadId = u.searchParams.get('leadId') || '';
  const repId = u.searchParams.get('repId') || '';

  let callerId = process.env.TWILIO_CALLER_ID || '';
  let salon = '';
  const db = supabaseAdmin();
  if (db) {
    if (repId) {
      const { data } = await db.from('reps').select('phone_number').eq('id', repId).maybeSingle();
      if (data?.phone_number) callerId = data.phone_number;
    }
    if (leadId) {
      const { data } = await db.from('leads').select('salon').eq('id', leadId).maybeSingle();
      salon = data?.salon || '';
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  if (!to || !callerId) {
    twiml.say('Relay could not place this call. Check the caller ID setting.');
    return twimlResponse(twiml.toString());
  }
  twiml.say({ voice: 'Polly.Joanna' }, salon ? `Connecting you to ${salon}.` : 'Connecting your call.');
  const disclosure = (process.env.RECORDING_DISCLOSURE || '').trim();
  if (disclosure) twiml.say(disclosure);
  const recCb = `${BASE}/api/voice/recording${leadId ? `?leadId=${encodeURIComponent(leadId)}` : ''}`;
  const dial = twiml.dial({
    callerId,
    answerOnBridge: true,
    timeout: 30,
    record: 'record-from-answer-dual',
    recordingStatusCallback: recCb,
    recordingStatusCallbackEvent: ['completed'],
    recordingStatusCallbackMethod: 'POST',
  });
  dial.number(to);
  return twimlResponse(twiml.toString());
}
