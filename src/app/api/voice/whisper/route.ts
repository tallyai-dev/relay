import twilio from 'twilio';
import { twimlResponse } from '@/lib/voice-server';

// POST /api/voice/whisper?who=&kind=  — plays to the REP's cell before the
// legs are joined. Requiring a keypress is what stops a cell-carrier voicemail
// from "answering" the call: no digit → this leg hangs up → Twilio moves on to
// the next rep / Relay voicemail.
export async function POST(req: Request) {
  const u = new URL(req.url);
  const who = (u.searchParams.get('who') || 'Unknown caller').slice(0, 120);
  const kind = u.searchParams.get('kind') === 'callback' ? 'calling back' : 'calling the Relay line';
  const form = await req.formData().catch(() => new FormData());
  const digits = String(form.get('Digits') || '');

  const twiml = new twilio.twiml.VoiceResponse();
  if (digits === '1') {
    twiml.say({ voice: 'Polly.Joanna' }, 'Connecting.');
    return twimlResponse(twiml.toString()); // returning without <Hangup> accepts the call
  }
  const g = twiml.gather({ numDigits: 1, timeout: 6, action: u.pathname + u.search, method: 'POST' });
  g.say({ voice: 'Polly.Joanna' }, `Relay: ${who}, ${kind}. Press 1 to answer.`);
  twiml.hangup();
  return twimlResponse(twiml.toString());
}
