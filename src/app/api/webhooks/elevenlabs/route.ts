import { verifyElevenSignature } from '@/lib/elevenlabs';
import { handlePostCall } from '@/lib/agent-server';

// POST /api/webhooks/elevenlabs — the post-call webhook.
// ElevenLabs → Settings → Webhooks: URL = PUBLIC_BASE_URL + /api/webhooks/elevenlabs,
// copy its secret into ELEVENLABS_WEBHOOK_SECRET. We only act on
// post_call_transcription; everything else is acknowledged and dropped.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get('elevenlabs-signature');
  if (!verifyElevenSignature(raw, sig, process.env.ELEVENLABS_WEBHOOK_SECRET)) {
    console.error('elevenlabs webhook: bad signature');
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const type = payload?.type || '';
  if (type !== 'post_call_transcription') return Response.json({ ok: true, ignored: type });
  try {
    const r = await handlePostCall(payload.data || {});
    return Response.json(r);
  } catch (e: any) {
    console.error('elevenlabs webhook', e?.message);
    return Response.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
