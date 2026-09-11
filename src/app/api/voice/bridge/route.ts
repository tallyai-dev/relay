import { twilioClient } from '@/lib/twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { toE164 } from '@/lib/csv';
import { BASE, stampLastRep } from '@/lib/voice-server';
import { repFromRequest } from '@/lib/auth-server';

// POST /api/voice/bridge  { leadId, to, repId }
// "Call me, then them": Twilio rings the rep's CELL first; when they pick up,
// /api/voice/bridge/connect dials the salon from the Relay caller ID and joins
// the two legs. Real cellular audio on the go, still recorded and logged, and
// the salon only ever sees the Relay number — which is why her callback can be
// routed back to this rep (see /api/voice/inbound).
export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const leadId = String(body.leadId || '');
  const to = toE164(String(body.to || '')) ?? String(body.to || '').trim();
  // The rep is whoever is signed in — never trusted from the body (a bare POST
  // could otherwise ring any rep's cell and bridge it to any number on our bill).
  const me = await repFromRequest(req);
  if (!me) return Response.json({ error: 'Sign in again to place calls.', code: 'unauthorized' }, { status: 401 });
  const repId = me.id;

  const client = twilioClient();
  if (!client) return Response.json({ error: 'Twilio auth not configured.' }, { status: 503 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Database not configured.' }, { status: 503 });
  if (!to) return Response.json({ error: 'No number to dial.' }, { status: 400 });
  if (!repId) return Response.json({ error: 'No rep on this session.' }, { status: 400 });

  const rep = me;
  if (!rep?.forward_to) {
    return Response.json({ error: 'Add your cell number in Team first — that is the phone Relay rings.' , code: 'no_cell' }, { status: 400 });
  }
  const callerId = rep.phone_number || process.env.TWILIO_CALLER_ID || '';
  if (!callerId) return Response.json({ error: 'No caller ID set (TWILIO_CALLER_ID).' }, { status: 503 });

  if (leadId) await stampLastRep(leadId, repId);

  const q = new URLSearchParams({ to, leadId, repId }).toString();
  let call;
  try {
    call = await client.calls.create({
      to: rep.forward_to,
      from: callerId,
      url: `${BASE}/api/voice/bridge/connect?${q}`,
      method: 'POST',
      statusCallback: `${BASE}/api/voice/bridge/status?${q}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['answered', 'completed'],
      timeout: 25,
    });
  } catch (e: any) {
    console.error('bridge create', e?.code, e?.message);
    return Response.json({ error: e?.message || 'Twilio could not place the call.', code: e?.code }, { status: 502 });
  }

  await db.from('calls').insert({
    lead_id: leadId || null, rep_id: repId, twilio_sid: call.sid, direction: 'out',
    from_number: callerId, to_number: to, status: 'queued',
  });
  return Response.json({ sid: call.sid, ringing: rep.forward_to, callerId });
}
