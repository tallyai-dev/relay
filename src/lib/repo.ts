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
  const { data } = await sb.from('reps').select('id,name,email,role,phone_number,active').eq('auth_user_id', uid).maybeSingle();
  return data ? { id: data.id, name: data.name, email: data.email, role: data.role, phoneNumber: data.phone_number || undefined, active: data.active ?? true } : null;
}

// Reps visible to the current user (admins see all; reps see themselves).
export async function fetchReps(): Promise<Rep[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data } = await sb.from('reps').select('id,name,email,role,phone_number,active').order('name');
  return (data || []).map((r: any) => ({ id: r.id, name: r.name, email: r.email, role: r.role, phoneNumber: r.phone_number || undefined, active: r.active ?? true }));
}

// How many leads each rep owns (admin Team screen). One grouped read.
export async function fetchRepLeadCounts(): Promise<Record<string, number>> {
  const sb = supabaseBrowser();
  if (!sb) return {};
  const counts: Record<string, number> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('leads').select('owner_rep_id').not('owner_rep_id', 'is', null).range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    for (const r of data as any[]) counts[r.owner_rep_id] = (counts[r.owner_rep_id] || 0) + 1;
    if (data.length < PAGE) break;
  }
  return counts;
}

// Admin edits to a rep row (number, role, active, name). Allowed by the reps
// RLS update policy for admins; no server endpoint needed.
export async function updateRep(repId: string, patch: { name?: string; role?: 'admin' | 'rep'; phoneNumber?: string; active?: boolean }): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const row: any = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.phoneNumber !== undefined) row.phone_number = patch.phoneNumber || null;
  if (patch.active !== undefined) row.active = patch.active;
  const { error } = await sb.from('reps').update(row).eq('id', repId);
  if (error) console.error('updateRep', error);
}

// Assign many leads to a rep (or null to unassign). Chunked. Admin-only via RLS.
export async function assignOwnerMany(leadIds: string[], ownerRepId: string | null): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb || !leadIds.length) return;
  const CHUNK = 200;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const batch = leadIds.slice(i, i + CHUNK);
    const { error } = await sb.from('leads').update({ owner_rep_id: ownerRepId }).in('id', batch);
    if (error) console.error('assignOwnerMany', error);
  }
}

// Post to an admin team endpoint with the caller's access token attached.
async function adminTeamPost(path: string, payload: any): Promise<{ ok: boolean; inviteLink?: string; error?: string }> {
  const sb = supabaseBrowser();
  if (!sb) return { ok: false, error: 'Not connected.' };
  const { data: sess } = await sb.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'Not signed in.' };
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!res.ok) return { ok: false, error: j.error || 'Request failed.' };
    return { ok: true, inviteLink: j.inviteLink };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

// Invite a new SDR: create the auth login (server, service role) and get back a
// set-password link to hand them.
export async function inviteRep(email: string, name: string, phoneNumber?: string) {
  return adminTeamPost('/api/team/create', { email, name, phoneNumber });
}

// Generate a fresh set-password link for an existing user (reset / expired invite).
export async function resetRepPassword(email: string) {
  return adminTeamPost('/api/team/reset', { email });
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
    cadenceCompletedAt: row.cadence_completed_at || undefined,
    cadenceCompletedName: row.cadence_completed_name || undefined,
    deployed: row.deployed ?? true,
    nextActionAt: row.next_action_at || undefined,
    ownerRepId: row.owner_rep_id || undefined,
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
  // Supabase/PostgREST caps a single response at 1000 rows. With more leads than
  // that, a plain select silently drops the overflow (the newest leads, given the
  // ascending sort) — which made the "due today" count wrong and inconsistent
  // between devices. Page through in 1000-row chunks so we always load them all.
  const PAGE = 1000;
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('leads')
      .select('*, contacts(id,name,role,phone,email,is_primary)')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('fetchLeads', error); break; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all.map(rowToLead);
}

export interface DailyStats {
  dials: number; conversations: number; voicemails: number; texts: number; emails: number; demos: number;
}
const EMPTY_STATS: DailyStats = { dials: 0, conversations: 0, voicemails: 0, texts: 0, emails: 0, demos: 0 };

// Roll up today's activity into the top-bar counters. Bounded to today (local
// midnight) so it naturally resets each day. Derives from real logged
// activities, so it's accurate and survives reloads.
export async function fetchTodayStats(): Promise<DailyStats> {
  const sb = supabaseBrowser();
  if (!sb) return { ...EMPTY_STATS };
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const { data, error } = await sb
    .from('activities')
    .select('kind, disposition, direction')
    .gte('created_at', start.toISOString());
  if (error || !data) return { ...EMPTY_STATS };
  const s: DailyStats = { ...EMPTY_STATS };
  const talked = new Set(['booked', 'callback', 'not_interested', 'quote']);
  for (const r of data as any[]) {
    if (r.kind === 'text' && r.direction === 'out') s.texts++;
    else if (r.kind === 'email' && r.direction === 'out') s.emails++;
    else if ((r.kind === 'call' || r.kind === 'book') && r.disposition) {
      s.dials++; // a dispositioned call attempt = one dial
      if (r.disposition === 'voicemail') s.voicemails++;
      if (talked.has(r.disposition)) s.conversations++;
      if (r.disposition === 'booked') s.demos++;
    }
    // A demo booked via Calendly is logged as kind='book' with no call
    // disposition — count it as a demo, but not as a dial/conversation.
    else if (r.kind === 'book' && !r.disposition) s.demos++;
  }
  return s;
}

// How many cadence touches (outbound calls/texts/emails) each lead already has —
// so the flow can resume a salon where it left off instead of restarting at
// attempt 1. Chunked to stay under URL length limits on big books.
export async function fetchCadenceProgress(leadIds: string[]): Promise<Record<string, number>> {
  const sb = supabaseBrowser();
  if (!sb || !leadIds.length) return {};
  const out: Record<string, number> = {};
  const CHUNK = 50;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const batch = leadIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from('activities').select('lead_id, kind, direction').in('lead_id', batch);
    if (error || !data) continue;
    for (const r of data as any[]) {
      if ((r.kind === 'call' || r.kind === 'book' || r.kind === 'text' || r.kind === 'email') && r.direction !== 'in') {
        out[r.lead_id] = (out[r.lead_id] || 0) + 1;
      }
    }
  }
  return out;
}

export async function updateCadencePos(leadId: string, pos: number): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('leads').update({ cadence_pos: pos }).eq('id', leadId);
}

export async function fetchActivities(leadId: string): Promise<Activity[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  const { data } = await sb
    .from('activities')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  return (data || []).map(rowToActivity);
}

// Cross-lead activity feed for the Reports screen / Team drill-in. Admins see
// everyone (RLS); pass repId to scope to one rep's work. Joins the salon name.
export type FeedActivity = Activity & { salon?: string };
export async function fetchActivityFeed(sinceIso: string, repId?: string, limit = 500): Promise<FeedActivity[]> {
  const sb = supabaseBrowser();
  if (!sb) return [];
  let q = sb.from('activities')
    .select('*, leads(salon)')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (repId) q = q.eq('rep_id', repId);
  const { data, error } = await q;
  if (error) { console.error('fetchActivityFeed', error); return []; }
  return (data || []).map((r: any) => ({ ...rowToActivity(r), salon: r.leads?.salon || undefined }));
}

// Friendly timeline label for a persisted activity (the fancy "· ⚡Flow" labels
// only live in-session; a reloaded row rebuilds a readable one from its fields).
const DISPO_TY: Record<string, string> = {
  booked: 'Demo booked', callback: 'Callback scheduled', not_interested: 'Not interested',
  voicemail: 'Voicemail left', no_answer: 'Call — no answer', connected: 'Call — connected',
  quote: 'Quote', wrong_number: 'Wrong number',
};
function activityTy(r: any): string {
  const inbound = r.direction === 'in';
  switch (r.kind) {
    case 'call': return (r.disposition && DISPO_TY[r.disposition]) || (inbound ? 'Inbound call' : 'Call');
    case 'book': return 'Demo booked';
    case 'email': return inbound ? 'Email received' : 'Email sent';
    case 'text': return inbound ? 'Text received' : 'Text sent';
    case 'quote': return 'Quote sent';
    case 'note': return 'Note';
    default: return r.kind || 'Activity';
  }
}
function rowToActivity(r: any): Activity {
  return {
    id: r.id,
    leadId: r.lead_id,
    kind: r.kind,
    direction: r.direction || undefined,
    disposition: r.disposition || undefined,
    ty: activityTy(r),
    time: new Date(r.created_at).toLocaleString(),
    at: r.created_at,
    repId: r.rep_id || undefined,
    ai: !!r.ai_note,
    aiNote: r.ai_note || undefined,
    ownNote: r.own_note || undefined,
    body: r.body || undefined,
    recordingUrl: r.recording_url || undefined,
    transcript: r.transcript || undefined,
    durationS: r.duration_s ?? undefined,
  };
}

// Subscribe to a lead's activity inserts + updates in realtime (so a call's
// recording/AI summary lands live when the webhook finishes). Returns unsub.
export function subscribeActivities(leadId: string, onChange: (a: Activity) => void): () => void {
  const sb = supabaseBrowser();
  if (!sb) return () => {};
  const ch = sb
    .channel(`activities-${leadId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activities', filter: `lead_id=eq.${leadId}` }, (p) => onChange(rowToActivity(p.new)))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activities', filter: `lead_id=eq.${leadId}` }, (p) => onChange(rowToActivity(p.new)))
    .subscribe();
  return () => { sb.removeChannel(ch); };
}

export async function insertActivity(
  leadId: string,
  a: { id?: string; kind: string; direction?: string; disposition?: string; aiNote?: string; ownNote?: string; body?: string; repId?: string }
): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const row: any = {
    lead_id: leadId,
    kind: a.kind,
    direction: a.direction,
    disposition: a.disposition,
    ai_note: a.aiNote,
    own_note: a.ownNote,
    body: a.body,
    rep_id: a.repId ?? null, // who did it — powers the admin Team/Reports views
  };
  if (a.id) row.id = a.id; // share the client id so realtime echoes de-duplicate
  const { error } = await sb.from('activities').insert(row);
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
    openCount: r.open_count ?? 0,
    clickCount: r.click_count ?? 0,
  }));
}

export function rowToMessage(r: any): Message {
  return {
    id: r.id, leadId: r.lead_id || undefined, who: r.from_addr || '—', salon: '',
    channel: r.channel, direction: r.direction, subject: r.subject || undefined,
    body: r.body || '', time: 'just now', isRead: r.is_read,
    phone: (r.direction === 'in' ? r.from_addr : r.to_addr) || undefined,
    openCount: r.open_count ?? 0, clickCount: r.click_count ?? 0,
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

// Hard-delete a lead. Contacts + activities cascade; messages/calls null out.
export async function deleteLead(leadId: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const { error } = await sb.from('leads').delete().eq('id', leadId);
  if (error) console.error('deleteLead', error);
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
  // New cadence → reset progress and clear any prior completion badge.
  await sb.from('leads').update({ cadence_id: cadenceId, cadence_pos: 0, cadence_completed_at: null, cadence_completed_name: null }).eq('id', leadId);
}

// Move many leads onto a cadence at once: fresh at day 0, due now, badge cleared.
// Chunked so a whole book (thousands) updates without hitting URL limits.
export async function bulkAssignCadence(leadIds: string[], cadenceId: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb || !leadIds.length) return;
  const CHUNK = 200;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const batch = leadIds.slice(i, i + CHUNK);
    const { error } = await sb.from('leads')
      .update({ cadence_id: cadenceId, cadence_pos: 0, cadence_completed_at: null, cadence_completed_name: null, next_action_at: null })
      .in('id', batch);
    if (error) console.error('bulkAssignCadence', error);
  }
}

// Stamp a lead as having finished its cadence (badge on the salon view).
export async function markCadenceComplete(leadId: string, name: string, iso: string): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  await sb.from('leads').update({ cadence_completed_at: iso, cadence_completed_name: name }).eq('id', leadId);
}

// Deploy the N oldest staged leads into a cadence: flip deployed=true, assign the
// cadence, reset position, and make them due now. assignToRepId (when given) sets
// owner_rep_id so the batch lands in that rep's name. Returns the ids that moved.
export async function deployStagedLeads(count: number, cadenceId: string, assignToRepId?: string): Promise<string[]> {
  const sb = supabaseBrowser();
  if (!sb || count <= 0) return [];
  const { data: picked, error: selErr } = await sb.from('leads').select('id')
    .eq('deployed', false).order('created_at', { ascending: true }).limit(count);
  if (selErr || !picked?.length) { if (selErr) console.error('deployStagedLeads select', selErr); return []; }
  const ids = picked.map((r: any) => r.id);
  const patch: Record<string, unknown> = { deployed: true, cadence_id: cadenceId, cadence_pos: 0, next_action_at: null, cadence_completed_at: null, cadence_completed_name: null };
  if (assignToRepId) patch.owner_rep_id = assignToRepId;
  const { error } = await sb.from('leads').update(patch).in('id', ids);
  if (error) { console.error('deployStagedLeads update', error); return []; }
  return ids;
}

// Save enrichment results onto a lead (only the fields provided). Also mirrors a
// filled-in phone onto the primary contact so the dialer/keypad can match it.
export async function updateLeadEnrichment(
  leadId: string,
  fields: { phone?: string; email?: string; city?: string; website?: string; bookingSystem?: string }
): Promise<void> {
  const sb = supabaseBrowser();
  if (!sb) return;
  const patch: any = {};
  if (fields.phone) patch.phone = toE164(fields.phone) ?? fields.phone;
  if (fields.email) patch.email = fields.email;
  if (fields.city) patch.city = fields.city;
  if (fields.website) patch.website = fields.website;
  if (fields.bookingSystem) patch.booking_system = fields.bookingSystem;
  if (!Object.keys(patch).length) return;
  const { error } = await sb.from('leads').update(patch).eq('id', leadId);
  if (error) { console.error('updateLeadEnrichment', error); return; }
  if (patch.phone || patch.email) {
    const cpatch: any = {};
    if (patch.phone) cpatch.phone = patch.phone;
    if (patch.email) cpatch.email = patch.email;
    await sb.from('contacts').update(cpatch).eq('lead_id', leadId).eq('is_primary', true);
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
