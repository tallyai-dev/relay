import { supabaseAdmin } from '@/lib/supabase';
import { repFromRequest } from '@/lib/auth-server';

// GET  /api/calls            — call history for the keypad's Recent tab (last 14 days).
// POST /api/calls {action}   — 'note': save a note/outcome on a call
//                               'link': attach a call to a lead
// Admins see every call; reps see their own calls, calls on leads they own,
// and every inbound call (the Relay number is shared — callbacks ring the team).

const DAYS = 14;
const OUTCOMES = ['no_answer', 'voicemail', 'front_desk', 'connected', 'callback', 'booked', 'not_interested', 'wrong_number'];
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request) {
  const me = await repFromRequest(req);
  if (!me) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Database not configured.' }, { status: 503 });

  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data, error } = await db
    .from('calls')
    .select('id, created_at, direction, status, dial_status, duration_s, talk_s, from_number, to_number, recording_url, note, outcome, noted_at, lead_id, rep_id, leads(id, salon, city, phone, owner_rep_id), reps(name)')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(600);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const admin = me.role === 'admin';
  const rows = (data || []).filter((c: any) => admin || c.rep_id === me.id || c.leads?.owner_rep_id === me.id || c.direction === 'in').slice(0, 200);

  // A call already logged from the call panel doesn't need a second note:
  // look for a call/note activity on the same lead around the same time.
  const leadIds = Array.from(new Set(rows.map((c: any) => c.lead_id).filter(Boolean)));
  const acts: { lead_id: string; t: number }[] = [];
  if (leadIds.length) {
    // Only a person's entry counts (the recording webhook's auto-summary has no rep).
    const { data: a } = await db.from('activities').select('lead_id, created_at').in('lead_id', leadIds).in('kind', ['call', 'note', 'book']).not('rep_id', 'is', null).gte('created_at', since);
    for (const x of a || []) acts.push({ lead_id: x.lead_id, t: new Date(x.created_at).getTime() });
  }
  const calls = rows.map((c: any) => {
    const t = new Date(c.created_at).getTime();
    const logged = !!c.noted_at || acts.some((a) => a.lead_id === c.lead_id && a.t >= t - 60_000 && a.t <= t + 30 * 60_000);
    return {
      id: c.id, at: c.created_at, direction: c.direction, status: c.status, dialStatus: c.dial_status,
      durationS: c.duration_s, talkS: c.talk_s, from: c.from_number, to: c.to_number,
      recordingUrl: c.recording_url, note: c.note, outcome: c.outcome, notedAt: c.noted_at, logged,
      leadId: c.lead_id, salon: c.leads?.salon || null, city: c.leads?.city || null,
      repId: c.rep_id, repName: c.reps?.name || null,
    };
  });
  return Response.json({ calls });
}

export async function POST(req: Request) {
  const me = await repFromRequest(req);
  if (!me) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Database not configured.' }, { status: 503 });
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const callId = String(body.callId || '');
  if (!UUID.test(callId)) return Response.json({ error: 'Unknown call.' }, { status: 400 });
  const { data: call } = await db.from('calls').select('id, lead_id, rep_id, direction, leads(owner_rep_id)').eq('id', callId).maybeSingle();
  if (!call) return Response.json({ error: 'Unknown call.' }, { status: 404 });
  const c: any = call;
  const mayEdit = me.role === 'admin' || c.rep_id === me.id || c.leads?.owner_rep_id === me.id || c.direction === 'in';
  if (!mayEdit) return Response.json({ error: 'Not your call.' }, { status: 403 });

  if (body.action === 'link') {
    const leadId = String(body.leadId || '');
    if (!UUID.test(leadId)) return Response.json({ error: 'Pick a lead.' }, { status: 400 });
    const { data: lead } = await db.from('leads').select('id, owner_rep_id').eq('id', leadId).maybeSingle();
    if (!lead) return Response.json({ error: 'That lead no longer exists.' }, { status: 404 });
    if (me.role !== 'admin' && lead.owner_rep_id && lead.owner_rep_id !== me.id) return Response.json({ error: 'That lead belongs to another rep.' }, { status: 403 });
    const { error } = await db.from('calls').update({ lead_id: leadId }).eq('id', callId);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (body.action === 'note') {
    const note = String(body.note || '').trim().slice(0, 4000);
    const outcome = OUTCOMES.includes(body.outcome) ? body.outcome : null;
    if (!note && !outcome) return Response.json({ error: 'Add a note or pick how it went.' }, { status: 400 });
    const { error } = await db.from('calls').update({ note: note || null, outcome, noted_at: new Date().toISOString(), noted_by: me.id }).eq('id', callId);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'Unknown action.' }, { status: 400 });
}
