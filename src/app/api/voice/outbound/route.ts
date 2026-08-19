import twilio from 'twilio';

// POST /api/voice/outbound  — TwiML App Voice URL.
// When the browser SDK places a call it hits this; we return TwiML that dials
// the target number from the rep's Relay caller ID.
export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get('To') || '');
  const callerId = process.env.TWILIO_CALLER_ID || '';

  const twiml = new twilio.twiml.VoiceResponse();
  if (to && callerId) {
    const dial = twiml.dial({ callerId, answerOnBridge: true });
    dial.number(to);
  } else {
    twiml.say('Relay is not fully configured. Set your caller ID.');
  }
  return new Response(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}
