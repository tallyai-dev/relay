import { supabaseAdmin } from '@/lib/supabase';
import { repFromRequest } from '@/lib/auth-server';

// POST /api/push/subscribe { repId, subscription }   — add this device
// DELETE /api/push/subscribe { repId, endpoint }     — remove it
// Subscriptions live on the rep row (jsonb array), deduped by endpoint.
export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const me = await repFromRequest(req);
  if (!me) return Response.json({ error: 'Sign in again to turn on reminders.' }, { status: 401 });
  const repId = me.id;
  const sub = body.subscription;
  if (!sub?.endpoint) return Response.json({ error: 'subscription required.' }, { status: 400 });
  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });
  const { data } = await db.from('reps').select('push_subscriptions').eq('id', repId).maybeSingle();
  const subs: any[] = Array.isArray(data?.push_subscriptions) ? data!.push_subscriptions : [];
  const next = subs.filter((s) => s?.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null, added_at: new Date().toISOString() }]);
  const { error } = await db.from('reps').update({ push_subscriptions: next }).eq('id', repId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, devices: next.length });
}

export async function DELETE(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const me = await repFromRequest(req);
  const repId = me?.id || '';
  const endpoint = String(body.endpoint || '');
  const db = supabaseAdmin();
  if (!db || !repId || !endpoint) return Response.json({ ok: false }, { status: 400 });
  const { data } = await db.from('reps').select('push_subscriptions').eq('id', repId).maybeSingle();
  const subs: any[] = Array.isArray(data?.push_subscriptions) ? data!.push_subscriptions : [];
  await db.from('reps').update({ push_subscriptions: subs.filter((s) => s?.endpoint !== endpoint) }).eq('id', repId);
  return Response.json({ ok: true });
}
