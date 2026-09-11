import { supabaseAdmin } from '@/lib/supabase';
import { pushToRep, pushConfigured } from '@/lib/push-server';

// POST /api/reminders/tick   (header x-relay-cron: CRON_SECRET)
// Runs every minute from netlify/functions/reminders-tick.mjs. Finds callbacks
// due in the next 5 minutes (or up to an hour late — a missed tick still
// fires once) that haven't been notified, and pushes the rep who owes the
// call: the rep who last dialed her, else her owner, else every admin.
export const dynamic = 'force-dynamic';

const LEAD_MIN = 5;      // minutes before the callback
const LATE_MIN = 60;     // still fire if the tick was down for a while

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret || req.headers.get('x-relay-cron') !== secret) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });
  if (!pushConfigured()) return Response.json({ ok: true, sent: 0, note: 'push not configured' });

  const now = Date.now();
  const hi = new Date(now + LEAD_MIN * 60_000).toISOString();
  const lo = new Date(now - LATE_MIN * 60_000).toISOString();
  const { data: due, error } = await db
    .from('leads')
    .select('id, salon, callback_at, callback_note, last_rep_id, owner_rep_id, contacts(name, is_primary)')
    .is('callback_notified_at', null)
    .lte('callback_at', hi)
    .gte('callback_at', lo)
    .limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let sent = 0;
  const { data: admins } = await db.from('reps').select('id').eq('role', 'admin').eq('active', true);
  for (const l of due || []) {
    // Claim it first (atomic) so an overlapping tick can't push twice.
    const { data: claimed } = await db.from('leads').update({ callback_notified_at: new Date().toISOString() }).eq('id', l.id).is('callback_notified_at', null).select('id');
    if (!claimed || !claimed.length) continue;
    const cs: any[] = (l as any).contacts || [];
    const c = cs.find((x) => x.is_primary) || cs[0];
    const name = c?.name && c.name !== '—' ? c.name : l.salon;
    const at = new Date(l.callback_at as string);
    const when = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.RELAY_TZ || 'America/Denver' });
    const targets = Array.from(new Set([l.last_rep_id, l.owner_rep_id].filter(Boolean) as string[]));
    const reps = targets.length ? targets : (admins || []).map((a) => a.id);
    for (const repId of reps) {
      sent += await pushToRep(repId, {
        title: `Callback at ${when} · ${l.salon}`,
        body: `${name}${l.callback_note ? ` — ${l.callback_note}` : ''}. Tap to call.`,
        url: `/?lead=${l.id}&call=1`,
        tag: `callback-${l.id}`,
      });
    }
  }
  return Response.json({ ok: true, due: (due || []).length, sent });
}
