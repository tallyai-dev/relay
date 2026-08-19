// GET /api/voice/media?sid=RE...  — streams a Twilio call recording.
// Twilio recording URLs require account Basic auth, so the browser can't hit
// them directly. This proxy fetches the audio server-side and streams it back
// to the in-app <audio> player. We reconstruct the URL from the account SID +
// a validated RecordingSid (never proxy an arbitrary URL — avoids SSRF).
//
// v1 note: the RecordingSid is an unguessable token and the app sits behind
// auth; a later hardening pass can swap this for short-lived signed URLs.

export async function GET(req: Request) {
  const sid = new URL(req.url).searchParams.get('sid') || '';
  if (!/^RE[0-9a-fA-F]{32}$/.test(sid)) {
    return new Response('Bad recording id', { status: 400 });
  }
  const acct = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!acct || !tok) return new Response('Not configured', { status: 503 });

  const url = `https://api.twilio.com/2010-04-01/Accounts/${acct}/Recordings/${sid}.mp3`;
  const res = await fetch(url, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${acct}:${tok}`).toString('base64') },
  });
  if (!res.ok || !res.body) return new Response('Recording unavailable', { status: 502 });

  return new Response(res.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
