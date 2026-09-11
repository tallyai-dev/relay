import { repFromRequest } from '@/lib/auth-server';
import { supabaseAdmin } from '@/lib/supabase';
import { MAX_ATTEMPTS } from '@/lib/agent-server';

// Eryn's shift.
//   GET  /api/agent-shift                    { shift, live, today, queue, recent }
//   POST /api/agent-shift { action, cap? }   start | pause | resume | stop
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const rep = await repFromRequest(req);
  if (!rep) return Response.json({ error: 'Sign in first.', code: 'unauthorized' }, { status: 401 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const [shiftQ, liveQ, todayQ, queueQ, recentQ] = await Promise.all([
    db.from('agent_shifts').select('*').in('status', ['running', 'paused']).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('agent_calls').select('*, leads(salon, city)').in('status', ['queued', 'ringing', 'in_progress']).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('agent_calls').select('outcome, status').gte('created_at', dayStart.toISOString()),
    db.from('leads').select('id', { count: 'exact', head: true }).eq('owner', 'agent').eq('dnc', false).eq('deployed', true).in('stage', ['new', 'working']).neq('line_type', 'mobile').lt('agent_attempts', MAX_ATTEMPTS),
    db.from('agent_calls').select('*, leads(salon, city)').eq('status', 'ended').order('ended_at', { ascending: false }).limit(15),
  ]);
  const today = { dials: 0, answered: 0, voicemail: 0, noAnswer: 0, interested: 0 };
  for (const c of todayQ.data || []) {
    if (c.status === 'failed') continue;
    today.dials++;
    if (c.outcome === 'voicemail') today.voicemail++;
    else if (c.outcome === 'no_answer') today.noAnswer++;
    else if (c.outcome && c.outcome !== 'unknown') today.answered++;
    if (c.outcome === 'answered_interested' || c.outcome === 'callback') today.interested++;
  }
  return Response.json({ shift: shiftQ.data || null, live: liveQ.data || null, today, queue: queueQ.count ?? 0, recent: recentQ.data || [] });
}

export async function POST(req: Request) {
  const rep = await repFromRequest(req);
  if (!rep) return Response.json({ error: 'Sign in first.', code: 'unauthorized' }, { status: 401 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action || '');
  const { data: cur } = await db.from('agent_shifts').select('*').in('status', ['running', 'paused']).order('started_at', { ascending: false }).limit(1).maybeSingle();
  const now = new Date().toISOString();
  if (action === 'start') {
    const cap = Math.max(1, Math.min(200, Number(body.cap) || 60));
    if (cur) {
      await db.from('agent_shifts').update({ status: 'running', paused_note: null, cap }).eq('id', cur.id);
      return Response.json({ ok: true, shift: { ...cur, status: 'running', cap } });
    }
    const { data, error } = await db.from('agent_shifts').insert({ rep_id: rep.id, status: 'running', cap }).select('*').single();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, shift: data });
  }
  if (!cur) return Response.json({ error: 'No shift running.' }, { status: 400 });
  if (action === 'pause') await db.from('agent_shifts').update({ status: 'paused', paused_note: null }).eq('id', cur.id);
  else if (action === 'resume') await db.from('agent_shifts').update({ status: 'running', paused_note: null }).eq('id', cur.id);
  else if (action === 'stop') await db.from('agent_shifts').update({ status: 'done', ended_at: now }).eq('id', cur.id);
  else return Response.json({ error: 'action must be start | pause | resume | stop' }, { status: 400 });
  return Response.json({ ok: true });
}
