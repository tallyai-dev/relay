import { repFromRequest } from '@/lib/auth-server';
import { supabaseAdmin } from '@/lib/supabase';
import { placeAgentCall } from '@/lib/agent-server';

// Eryn dials one lead.
//   POST /api/agent-call  { leadId, force? }   (Bearer rep session, or x-agent-key for the Grok bot)
//   GET  /api/agent-call?leadId=…              her calls for that lead, newest first
export const dynamic = 'force-dynamic';

function keyOk(req: Request) {
  const k = process.env.AGENT_CALL_API_KEY || '';
  return !!k && req.headers.get('x-agent-key') === k;
}

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const rep = await repFromRequest(req);
  if (!rep && !keyOk(req)) return Response.json({ error: 'Sign in first.', code: 'unauthorized' }, { status: 401 });
  const leadId = String(body.leadId || body.lead_id || '');
  if (!leadId) return Response.json({ error: 'leadId required.' }, { status: 400 });
  const r = await placeAgentCall(leadId, { repId: rep?.id || null, force: !!body.force && !!rep, kind: body.kind === 'warm' ? 'warm' : 'cold' });
  if (!r.ok) return Response.json({ error: r.error, reason: r.reason, lineType: r.lineType }, { status: r.reason === 'provider' ? 502 : 400 });
  return Response.json({ ok: true, callId: r.callId, conversationId: r.conversationId });
}

export async function GET(req: Request) {
  const rep = await repFromRequest(req);
  if (!rep && !keyOk(req)) return Response.json({ error: 'Sign in first.', code: 'unauthorized' }, { status: 401 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });
  const url = new URL(req.url);
  const leadId = url.searchParams.get('leadId');
  const id = url.searchParams.get('id');
  let q = db.from('agent_calls').select('*').order('created_at', { ascending: false }).limit(20);
  if (id) q = q.eq('id', id);
  else if (leadId) q = q.eq('lead_id', leadId);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ calls: data || [] });
}
