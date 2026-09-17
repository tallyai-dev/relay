// Server-side voice helpers shared by the bridge + inbound routes.
import { supabaseAdmin } from '@/lib/supabase';

export const BASE = process.env.PUBLIC_BASE_URL || 'https://tallyai-relay.netlify.app';

export const last10 = (p?: string | null) => (p || '').replace(/\D/g, '').slice(-10);

export type RepRow = { id: string; name: string; forward_to: string | null; phone_number: string | null; active: boolean | null; role?: string };

/** Escape a string for inclusion inside TwiML text. */
export function xmlText(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Look a caller up by phone: returns the lead + a display name, or null. */
export async function leadByPhone(from: string) {
  const db = supabaseAdmin();
  if (!db) return null;
  const tail = last10(from);
  if (tail.length < 7) return null;
  const { data } = await db
    .from('leads')
    .select('id, salon, phone, last_rep_id, last_rep_at, owner_rep_id, contacts(name, phone, is_primary)')
    .ilike('phone', `%${tail}%`)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const cs: any[] = (data as any).contacts || [];
  const c = cs.find((x) => x.is_primary) || cs[0];
  return { ...data, contactName: c?.name && c.name !== '—' ? String(c.name) : '' };
}

/** Active reps with a cell on file, in the order they should ring. */
export async function ringOrder(preferredIds: (string | null | undefined)[]): Promise<RepRow[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from('reps').select('id, name, forward_to, phone_number, active, role');
  const reps = ((data || []) as RepRow[]).filter((r) => r.active !== false && r.forward_to);
  const out: RepRow[] = [];
  for (const id of preferredIds) {
    if (!id) continue;
    const r = reps.find((x) => x.id === id);
    if (r && !out.some((o) => o.id === r.id)) out.push(r);
  }
  for (const r of reps) if (!out.some((o) => o.id === r.id)) out.push(r);
  return out;
}

/** Remember who dialed this salon last so her callback rings them first. */
export async function stampLastRep(leadId: string, repId: string) {
  const db = supabaseAdmin();
  if (!db || !leadId || !repId) return;
  await db.from('leads').update({ last_rep_id: repId, last_rep_at: new Date().toISOString() }).eq('id', leadId);
}

export function twimlResponse(xml: string) {
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } });
}

/** Record (or update) a call in the calls table, keyed on the Twilio CallSid.
 * Best-effort: a database hiccup must never break the TwiML a caller is waiting on. */
export async function recordCall(row: Record<string, unknown> & { twilio_sid: string }) {
  const db = supabaseAdmin();
  if (!db || !row.twilio_sid) return;
  try {
    const { error } = await db.from('calls').upsert(row, { onConflict: 'twilio_sid' });
    if (error) console.error('recordCall', error.message);
  } catch (e) { console.error('recordCall', e); }
}

/** Patch an existing call-history row by CallSid (never creates one). */
export async function updateCall(sid: string, patch: Record<string, unknown>) {
  const db = supabaseAdmin();
  if (!db || !sid) return;
  try {
    const { error } = await db.from('calls').update(patch).eq('twilio_sid', sid);
    if (error) console.error('updateCall', error.message);
  } catch (e) { console.error('updateCall', e); }
}
