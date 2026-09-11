import { markDnc } from '@/lib/agent-server';

// POST /api/agent-call/dnc  { lead_id, reason? }   header x-agent-key
// Eryn's mark_dnc tool hits this the moment someone says "stop" — before the
// call even ends — so no text goes out and no dialer ever picks her up again.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const k = process.env.AGENT_CALL_API_KEY || '';
  if (!k || req.headers.get('x-agent-key') !== k) return Response.json({ error: 'forbidden' }, { status: 403 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const leadId = String(body.lead_id || body.leadId || '');
  if (!leadId) return Response.json({ error: 'lead_id required.' }, { status: 400 });
  const ok = await markDnc(leadId, body.reason ? String(body.reason) : 'she asked on the call');
  return Response.json({ ok, message: ok ? 'Done — we will not contact this salon again.' : 'Could not update.' });
}
