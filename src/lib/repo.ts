'use client';
import { supabaseBrowser } from './supabase';
import { toE164 } from './csv';
import type { Lead, Activity, Stage, Message, Rep, Cadence, CadenceStep } from './types';

// Data access layer. Every function no-ops (returns empty / does nothing) when
// Supabase isn't configured, so the app keeps running on seeded mock data.

export function repoEnabled(): boolean {
  return !!supabaseBrowser();
}

// The logged-in rep (id + role). RLS lets a rep read their own row.
export async function fetchMe(): Promise<Rep | null> {
  const sb = supabaseBrowser();
  if (!sb) return null;
  const { data: u } = await sb.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return null;
  const { data } = await sb.from('reps').select('id,name,email,role').eq('auth_user_id', uid).maybeSingle();
  return data ? { id: data.id, name: data.name, email: data.email, role: data.role } : null;
}

// Reps visible to the current user (admins see all; reps see themselves).
export async function fetchReps(): Promise<Rep[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data } = await sb.from('reps').select('id,name,email,role').order('name');
  return (data || []).map((r: any) => ({ id: r.id, name: r.name, email: r.email, role: r.role }));
}

export async function signOut(): Promise<void> {
  await supabaseBrowser()?.auth.signOut();
}

const DEFAULT_CADENCE = '11111111-1111-1111-1111-111111111111';

function rowToLead(row: any): Lead {
  const cs = row.contacts || [];
  const c = cs.find((x: any) => x.is_primary) || cs[0];
  return {
    id: row.id,
    salon: row.salon,
    city: row.city || '',
    phone: row.phone || '',
    email: row.email || undefined,
    website: row.website || undefined,
    bookingSystem: row.booking_system || undefined,
    source: row.source || undefined,
    stage: row.stage as Stage,
    cadenceId: row.cadence_id || DEFAULT_CADENCE,
    cadencePos: row.cadence_pos ?? 0,
    deployed: row.deployed ?? true,
    nextActionAt: row.next_action_at || undefined,
    contact: c
      ? { id: c.id, name: c.name || '—', role: c.role || '—', phone: c.phone, email: c.email }
      : { id: 'c', name: '—', role: '—' },
    objection: '—',
    lastTouch: relTime(row.updated_at),
  };
}

function relTime(iso?: string): string {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  const h = Math.floor(d / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function fetchLeads(): Promise<Lead[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data, error } = await sb
    .from('leads')
    .select('*, contacts(id,name,role,phone,email,is_primary)')
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchLeads', error); return []; }
  return (data || []).map(rowToLead);
}

export async function fetchActivities(leadId: string): Promise<Activity[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data } = await sb
    .from('activities')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  return (data || []).map((r: any): Activity => ({
    id: r.id,
    leadId: r.lead_id,
    kind: r.kind,
    direction: r.direction || undefined,
    disposition: r.disposition || undefined,
    ty: r.kind,
    time: new Date(r.created_at).toLocaleString(),
    ai: !!r.ai_note,
    aiNote: r.ai_note || undefined,
    ownNote: r.own_note || undefined,
    body: r.body || undefined,
  }));
}

export async function insertActivity(
  leadId: string,
  a: { kind: string; direction?: string; disposition?: string; aiNote?: string; ownNote?: string; body?: string }
): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const { error } = await sb.from('activities').insert({
    lead_id: leadId,
    kind: a.kind,
    direction: a.direction,
    disposition: a.disposition,
    ai_note: a.aiNote,
    own_note: a.ownNote,
    body: a.body,
  });
  if (error) console.error('insertActivity', error);
}

export async function updateStage(leadId: string, stage: Stage): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('leads').update({ stage }).eq('id', leadId);
}

// Best-effort: attach a manual note to the most recent activity for a lead.
export async function attachLatestOwnNote(leadId: string, note: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const { data } = await sb
    .from('activities')
    .select('id')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1);
  const id = data?.[0]?.id;
  if (id) await sb.from('activities').update({ own_note: note }).eq('id', id);
}

export async function fetchMessages(): Promise<Message[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data } = await sb
    .from('messages')
    .select('*, leads(salon)')
    .order('created_at', { ascending: true });
  return (data || []).map((r: any): Message => ({
    id: r.id,
    leadId: r.lead_id || undefined,
    who: r.from_addr || r.leads?.salon || '—',
    salon: r.leads?.salon || '',
    channel: r.channel,
    direction: r.direction,
    subject: r.subject || undefined,
    body: r.body || '',
    time: new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    isRead: r.is_read,
    phone: (r.direction === 'in' ? r.from_addr : r.to_addr) || undefined,
  }));
}

export function rowToMessage(r: any): Message {
  return {
    id: r.id, leadId: r.lead_id || undefined, who: r.from_addr || '—', salon: '',
    channel: r.channel, direction: r.direction, subject: r.subject || undefined,
    body: r.body || '', time: 'just now', isRead: r.is_read,
    phone: (r.direction === 'in' ? r.from_addr : r.to_addr) || undefined,
  };
}

export async function markThreadRead(leadId: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('messages').update({ is_read: true }).eq('lead_id', leadId);
}

// Mark specific messages read by id (works for lead threads and phone-only threads).
export async function markMessagesRead(ids: string[]): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb || !ids.length) return;
  await sb.from('messages').update({ is_read: true }).in('id', ids);
}

// Subscribe to inbound messages in realtime. Returns an unsubscribe fn.
export function subscribeMessages(onInsert: (m: Message) => void): () => void {
  const sb = supabaseBrowser();
  if (!sb) return () => {};
  const ch = sb
    .channel('messages-inbound')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      onInsert(rowToMessage(payload.new));
    })
    .subscribe();
  return () => { sb.removeChannel(ch); };
}

export interface ImportRow {
  salon: string;
  city?: string;
  phone?: string;
  email?: string;
  contactName?: string;
  role?: string;
}

// ── Cadences (team-wide config; RLS: team_all) ──────────────────────────────
export async function fetchCadences(): Promise<Cadence[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data, error } = await sb
    .from('cadences')
    .select('id,name,cadence_steps(position,channel,wait_minutes,template,subject,branches)')
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchCadences', error); return []; }
  return (data || []).map((c: any): Cadence => ({
    id: c.id,
    name: c.name,
    steps: (c.cadence_steps || [])
      .slice()
      .sort((a: any, b: any) => a.position - b.position)
      .map((s: any): CadenceStep => ({
        position: s.position,
        channel: s.channel,
        waitMinutes: s.wait_minutes ?? 0,
        template: s.template || undefined,
        subject: s.subject || undefined,
        branches: s.branches || undefined,
      })),
  }));
}

export async function createCadence(name: string): Promise<string | null> {
  const sb = supabaseBrowser();
  if (!sb) return null;
  const { data, error } = await sb.from('cadences').insert({ name }).select('id').single();
  if (error) { console.error('createCadence', error); return null; }
  return data.id as string;
}

export async function renameCadence(id: string, name: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('cadences').update({ name }).eq('id', id);
}

export async function deleteCadence(id: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('cadences').delete().eq('id', id); // cadence_steps cascade
}

// Replace-all: wipe a cadence's steps and re-insert in order.
export async function saveCadenceSteps(cadenceId: string, steps: CadenceStep[]): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('cadence_steps').delete().eq('cadence_id', cadenceId);
  if (!steps.length) return;
  const payload = steps.map((s, i) => ({
    cadence_id: cadenceId,
    position: i,
    channel: s.channel,
    wait_minutes: s.waitMinutes || 0,
    template: s.template || null,
    subject: s.subject || null,
    branches: s.branches && Object.keys(s.branches).length ? s.branches : null,
  }));
  const { error } = await sb.from('cadence_steps').insert(payload);
  if (error) console.error('saveCadenceSteps', error);
}

export async function assignLeadCadence(leadId: string, cadenceId: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('leads').update({ cadence_id: cadenceId, cadence_pos: 0 }).eq('id', leadId);
}

// Deploy the N oldest staged leads into a cadence: flip deployed=true, assign the
// cadence, reset position, and make them due now. Returns the ids that moved.
export async function deployStagedLeads(count: number, cadenceId: string, ownerRepId?: string): Promise<string[]> {
  const sb = supabaseBrowser();
  if (!sb || count <= 0) return [];
  let q = sb.from('leads').select('id').eq('deployed', false).order('created_at', { ascending: true }).limit(count);
  if (ownerRepId) q = q.or(`owner_rep_id.eq.${ownerRepId},owner_rep_id.is.null`);
  const { data: picked, error: selErr } = await q;
  if (selErr || !picked?.length) { if (selErr) console.error('deployStagedLeads select', selErr); return []; }
  const ids = picked.map((r: any) => r.id);
  const { error } = await sb.from('leads')
    .update({ deployed: true, cadence_id: cadenceId, cadence_pos: 0, next_action_at: null })
    .in('id', ids);
  if (error) { console.error('deployStagedLeads update', error); return []; }
  return ids;
}

// Save enrichment results onto a lead (only the fields provided). Also mirrors a
// filled-in phone onto the primary contact so the dialer/keypad can match it.
export async function updateLeadEnrichment(
  leadId: string,
  fields: { phone?: string; city?: string; website?: string }
): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const patch: any = {};
  if (fields.phone) patch.phone = toE164(fields.phone) ?? fields.phone;
  if (fields.city) patch.city = fields.city;
  if (fields.website) patch.website = fields.website;
  if (!Object.keys(patch).length) return;
  const { error } = await sb.from('leads').update(patch).eq('id', leadId);
  if (error) { console.error('updateLeadEnrichment', error); return; }
  if (patch.phone) {
    await sb.from('contacts').update({ phone: patch.phone }).eq('lead_id', leadId).eq('is_primary', true);
  }
}

// Snooze a lead: set its next-due timestamp N days out (null clears / makes due now).
export async function setLeadNextAction(leadId: string, iso: string | null): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('leads').update({ next_action_at: iso }).eq('id', leadId);
}

// Quick-create a lead from the keypad (a dialed number the rep wants to keep).
export async function createLeadQuick(salon: string, phone: string, ownerRepId?: string): Promise<Lead | null> {
  const sb = supabaseBrowser();
  if (!sb) return null;
  const { data, error } = await sb
    .from('leads')
    .insert({ salon, phone: phone || null, stage: 'new', cadence_id: DEFAULT_CADENCE, cadence_pos: 0, owner_rep_id: ownerRepId ?? null })
    .select('*, contacts(id,name,role,phone,email,is_primary)')
    .single();
  if (error) { console.error('createLeadQuick', error); return null; }
  return rowToLead(data);
}

export async function bulkInsertLeads(rows: ImportRow[], ownerRepId?: string): Promise<number> {
  const sb = supabaseBrowser();
  if (!sb) return 0;
  const payload = rows
    .filter((r) => r.salon?.trim())
    .map((r) => ({
      salon: r.salon.trim(),
      city: r.city?.trim() || null,
      phone: toE164(r.phone) ?? (r.phone?.trim() || null),
      email: r.email?.trim() || null,
      stage: 'new',
      cadence_id: DEFAULT_CADENCE,
      cadence_pos: 0,
      deployed: false, // land in the staging pool, not the active pipeline
      owner_rep_id: ownerRepId ?? null,
    }));
  const { data, error } = await sb.from('leads').insert(payload).select('id');
  if (error) { console.error('bulkInsertLeads', error); return 0; }
  const contacts = (data || [])
    .map((d: any, i: number) => ({
      lead_id: d.id,
      name: rows[i].contactName?.trim() || '—',
      role: rows[i].role?.trim() || 'Front desk',
      phone: toE164(rows[i].phone) ?? (rows[i].phone?.trim() || null),
      email: rows[i].email?.trim() || null,
      is_primary: true,
    }))
    .filter((c: any) => c.name !== '—');
  if (contacts.length) await sb.from('contacts').insert(contacts);
  return (data || []).length;
}
