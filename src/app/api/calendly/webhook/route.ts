import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';

// POST /api/calendly/webhook — Calendly invitee.created / invitee.canceled.
// When a demo is booked (or canceled) in the embedded scheduler, Calendly pings
// here; we match the invitee to a lead by email (falling back to the leadId
// passed via UTM) and log it onto the timeline, set the stage, schedule the
// reminder, and bump the daily Demos count (a kind='book' activity with no call
// disposition counts as a demo but not a dial — see fetchTodayStats).
export const dynamic = 'force-dynamic';

// Verify Calendly's signature: header is "t=<ts>,v1=<hmac>", HMAC-SHA256 of
// "<ts>.<rawBody>" with the subscription's signing key.
function verify(raw: string, header: string | null, key: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = parts.t; const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', key).update(`${t}.${raw}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}

export async function POST(req: Request) {
  const raw = await req.text();
  const key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY || '';
  if (key && !verify(raw, req.headers.get('calendly-webhook-signature'), key)) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  if (!key) console.warn('calendly webhook: no signing key set — accepting unverified');

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const type = evt.event as string;
  const p = evt.payload || {};
  const email = String(p.email || '').trim().toLowerCase();
  const sched = p.scheduled_event || {};
  const startIso = sched.start_time || null;
  const eventName = sched.name || '15-minute demo';
  const leadIdHint = (p.tracking?.utm_content || '').trim();

  const db = supabaseAdmin();
  if (!db) return Response.json({ skipped: 'no db' });

  // Find the lead: by the UTM leadId first, then by invitee email.
  let leadId: string | null = null;
  if (leadIdHint) {
    const { data } = await db.from('leads').select('id').eq('id', leadIdHint).maybeSingle();
    leadId = data?.id ?? null;
  }
  if (!leadId && email) {
    const { data } = await db.from('leads').select('id').ilike('email', email).maybeSingle();
    leadId = data?.id ?? null;
  }
  if (!leadId) return Response.json({ ok: true, matched: false });

  const when = startIso ? new Date(startIso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'soon';

  if (type === 'invitee.created') {
    await db.from('activities').insert({
      lead_id: leadId, kind: 'book', direction: 'out',
      body: `Demo booked via Calendly — ${eventName} · ${when}`,
      ai_note: `Scheduled with ${p.name || email || 'the salon'}.`,
    });
    const patch: any = { stage: 'hot' };
    if (startIso) patch.next_action_at = startIso;
    await db.from('leads').update(patch).eq('id', leadId);
  } else if (type === 'invitee.canceled') {
    await db.from('activities').insert({
      lead_id: leadId, kind: 'note', direction: 'out',
      body: `Demo canceled in Calendly — ${eventName} (was ${when}).`,
    });
    await db.from('leads').update({ next_action_at: null }).eq('id', leadId);
  }

  return Response.json({ ok: true, matched: true, leadId });
}
