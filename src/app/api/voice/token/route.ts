import { voiceAccessToken } from '@/lib/twilio';

// GET /api/voice/token?identity=rep_seth
// The browser Voice SDK calls this to authorize placing/receiving calls.
export async function GET(req: Request) {
  const identity = new URL(req.url).searchParams.get('identity') || 'rep';
  const token = voiceAccessToken(identity);
  if (!token) {
    return Response.json(
      { error: 'Twilio Voice not configured. Set TWILIO_API_KEY_SID/SECRET and TWILIO_TWIML_APP_SID.' },
      { status: 503 }
    );
  }
  return Response.json({ identity, token });
}
