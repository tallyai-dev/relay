import twilio from 'twilio';

// POST /api/voice/inbound — set this as the Voice webhook on your Relay number.
// Behavior: ring the rep's in-app client first; if unanswered, forward to their
// cell (FORWARD_TO_NUMBER). That's the MVP path — reliable inbound without a
// native app. Swap the identity for a real per-number → rep lookup later.
export async function POST(_req: Request) {
  const identity = 'rep'; // TODO: map the dialed number to a rep identity
  const forwardTo = process.env.FORWARD_TO_NUMBER || '';

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({ timeout: 12, answerOnBridge: true });
  dial.client(identity);

  if (forwardTo) {
    // If the in-app client didn't pick up, fall through to the cell.
    twiml.dial({ timeout: 20 }).number(forwardTo);
  } else {
    twiml.say('Sorry, no one is available. Please leave a message after the tone.');
    twiml.record({ maxLength: 120, transcribe: true });
  }
  return new Response(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}
