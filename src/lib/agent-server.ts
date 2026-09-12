// Eryn, the AI cold caller — server-side brain.
//
//   placeAgentCall()  one lead → one ElevenLabs call (rules, lookup, dial, row)
//   handlePostCall()  the ElevenLabs post-call webhook → outcome, timeline,
//                     lead routing, the no-answer text
//   runShiftTick()    called from the minute tick: if a shift is running and
//                     Eryn is idle, dial the next eligible lead
//
// Rules Eryn runs under (the prompt can't enforce these, Relay does):
//   • warm Instagram leads are never hers — owner stays 'rep'
//   • anyone who ever talked to a human is a rep's from then on
//   • business lines only: Twilio Lookup 'mobile' → back to the rep's list
//   • her local hours 10a–4p, never Sunday; one call at a time; shift cap
//   • one try a day, three tries total, then she's the rep's with the transcript
//   • "stop" → dnc, instantly, everywhere
import { supabaseAdmin } from '@/lib/supabase';
import { twilioClient } from '@/lib/twilio';
import { toE164 } from '@/lib/csv';
import { startOutboundCall, getConversation, ERYN } from '@/lib/elevenlabs';
import { sendSmsServer } from '@/lib/sms-server';
import { TEXT_TEMPLATES, renderTpl, withOverrides } from '@/lib/templates';
import { loadTemplateOverrides } from '@/lib/templates-server';
import type { AgentOutcome, Lead } from '@/lib/types';

export const MAX_ATTEMPTS = 3;
const RETRY_HOURS = 22;          // "one try a day" — next-day, a bit earlier
const STALE_MIN = 20;            // a call with no webhook after this is over
const HOURS = { start: 10, end: 16 }; // her local time, [start, end)
const WRONG_ICP_PAUSE = 3;

// ── helpers ──────────────────────────────────────────────────────────────────
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York',
  HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago',
  MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York',
  VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  DC: 'America/New_York',
};
// Two-party consent states: the prompt says "this call may be recorded" there.
const TWO_PARTY = new Set(['CA', 'CT', 'DE', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'OR', 'PA', 'WA']);

export function stateFromCity(city?: string | null): string {
  const m = String(city || '').trim().match(/,\s*([A-Za-z]{2})\s*$/);
  return m ? m[1].toUpperCase() : '';
}
export function leadTz(city?: string | null): string {
  return STATE_TZ[stateFromCity(city)] || process.env.RELAY_TZ || 'America/Denver';
}
export function inCallingWindow(city?: string | null, now = new Date()): boolean {
  const tz = leadTz(city);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  if (wd === 'Sun') return false;
  return hour >= HOURS.start && hour < HOURS.end;
}

/** Twilio Lookup v2 line type, cached on the lead. */
export async function lookupLineType(phoneE164: string): Promise<'landline' | 'mobile' | 'voip' | 'unknown'> {
  const client = twilioClient();
  if (!client) return 'unknown';
  try {
    const r: any = await client.lookups.v2.phoneNumbers(phoneE164).fetch({ fields: 'line_type_intelligence' });
    const t = String(r?.lineTypeIntelligence?.type || '').toLowerCase();
    if (t === 'mobile') return 'mobile';
    if (t === 'landline') return 'landline';
    if (t.includes('voip')) return 'voip';
    return t ? 'unknown' : 'unknown';
  } catch (e: any) {
    console.error('lookup', e?.code, e?.message);
    return 'unknown';
  }
}

function firstName(cs: any[]): string {
  const c = cs.find((x) => x.is_primary) || cs[0];
  const n = c?.name && c.name !== '—' ? String(c.name) : '';
  return n.split(' ')[0] || '';
}

function toLead(row: any): Lead {
  const cs: any[] = row.contacts || [];
  const c = cs.find((x) => x.is_primary) || cs[0];
  return {
    id: row.id, salon: row.salon, city: row.city || '', phone: row.phone || '', email: row.email || undefined,
    bookingSystem: row.booking_system || undefined, source: row.source || undefined, stage: row.stage,
    cadenceId: row.cadence_id || '', cadencePos: row.cadence_pos ?? 0,
    contact: c ? { id: c.id, name: c.name || '—', role: c.role || '—', phone: c.phone, email: c.email } : { id: 'c', name: '—', role: '—' },
  };
}

// ── place a call ─────────────────────────────────────────────────────────────
export type PlaceResult = { ok: true; callId: string; conversationId: string } | { ok: false; error: string; reason?: string; lineType?: string };

export async function placeAgentCall(leadId: string, opts: { repId?: string | null; force?: boolean; kind?: 'cold' | 'warm'; shiftId?: string | null } = {}): Promise<PlaceResult> {
  const db = supabaseAdmin();
  if (!db) return { ok: false, error: 'Not configured.' };
  const { data: lead } = await db.from('leads').select('*, contacts(id,name,role,phone,email,is_primary)').eq('id', leadId).maybeSingle();
  if (!lead) return { ok: false, error: 'Lead not found.' };
  if (lead.dnc) return { ok: false, error: `${lead.salon} asked us to stop (DNC).`, reason: 'dnc' };
  const to = toE164(lead.phone);
  if (!to) return { ok: false, error: 'No phone number on the lead.', reason: 'no_phone' };
  if (!opts.force && lead.source === 'instagram') return { ok: false, error: 'Instagram leads are yours — Eryn only takes cold lists.', reason: 'warm' };

  // Never dial while another Eryn call is live.
  const { data: live } = await db.from('agent_calls').select('id').in('status', ['queued', 'ringing', 'in_progress'])
    .gte('started_at', new Date(Date.now() - STALE_MIN * 60_000).toISOString()).limit(1);
  if (live && live.length) return { ok: false, error: 'Eryn is on another call.', reason: 'busy' };

  // Business lines only. Cache the lookup on the lead.
  let lineType: string = lead.line_type || '';
  if (!lineType) {
    lineType = await lookupLineType(to);
    await db.from('leads').update({ line_type: lineType, line_checked_at: new Date().toISOString() }).eq('id', leadId);
  }
  if (lineType === 'mobile' && !opts.force) {
    await db.from('leads').update({ owner: 'rep' }).eq('id', leadId);
    return { ok: false, error: 'That number is a cell phone — moved to your hand-dial list.', reason: 'mobile', lineType };
  }

  // Who does she transfer to / sign for? The rep who pressed the button, else the owner, else the first admin with a cell.
  let rep: any = null;
  const repId = opts.repId || lead.owner_rep_id || lead.last_rep_id || null;
  if (repId) ({ data: rep } = await db.from('reps').select('id, name, forward_to, phone_number').eq('id', repId).maybeSingle());
  if (!rep?.forward_to) {
    const { data: admins } = await db.from('reps').select('id, name, forward_to, phone_number').eq('role', 'admin').eq('active', true).not('forward_to', 'is', null).limit(1);
    if (admins && admins[0]) rep = admins[0];
  }
  const repName = (rep?.name || 'Seth').split(' ')[0];
  const state = stateFromCity(lead.city);

  const { data: row, error: insErr } = await db.from('agent_calls').insert({
    lead_id: leadId, rep_id: opts.repId || null, kind: opts.kind || 'cold', agent_id: ERYN.agentId(),
    to_number: to, from_number: ERYN.fromNumber() || null, status: 'queued',
  }).select('id').single();
  if (insErr || !row) return { ok: false, error: insErr?.message || 'Could not create the call row.' };

  const attempt = (lead.agent_attempts ?? 0) + 1;
  const vars: Record<string, string | number | boolean> = {
    lead_id: leadId,
    call_id: row.id,
    salon_name: lead.salon,
    first_name: firstName(lead.contacts || []),
    city: lead.city || '',
    booking_system: lead.booking_system || '',
    rep_name: repName,
    rep_cell: rep?.forward_to || '',
    attempt,
    recording_notice: TWO_PARTY.has(state) ? 'yes' : 'no',
    why_here: lead.source === 'instagram' ? `engaged with Tally on Instagram${lead.notes ? `: ${lead.notes}` : ''}` : '',
  };
  const r = await startOutboundCall(to, vars);
  if (!r.ok) {
    await db.from('agent_calls').update({ status: 'failed', error: r.error, ended_at: new Date().toISOString() }).eq('id', row.id);
    return { ok: false, error: r.error, reason: 'provider' };
  }
  await db.from('agent_calls').update({ conversation_id: r.conversationId || null, call_sid: r.callSid || null, status: 'ringing' }).eq('id', row.id);
  await db.from('leads').update({ agent_attempts: attempt, agent_last_at: new Date().toISOString(), agent_next_at: null }).eq('id', leadId);
  if (opts.shiftId) {
    const { data: sh } = await db.from('agent_shifts').select('dials').eq('id', opts.shiftId).maybeSingle();
    await db.from('agent_shifts').update({ dials: (sh?.dials ?? 0) + 1, last_dial_at: new Date().toISOString() }).eq('id', opts.shiftId);
  }
  return { ok: true, callId: row.id, conversationId: r.conversationId };
}

// ── post-call ────────────────────────────────────────────────────────────────
const OUTCOMES: AgentOutcome[] = ['answered_interested', 'callback', 'gatekeeper', 'not_interested', 'wrong_icp', 'dnc', 'voicemail', 'no_answer', 'unknown'];

export function outcomeFrom(analysis: any, transcript: any[], durationS: number, status?: string): AgentOutcome {
  const dc = analysis?.data_collection_results || {};
  const raw = String(dc.outcome?.value ?? dc.outcome ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (OUTCOMES.includes(raw as AgentOutcome)) return raw as AgentOutcome;
  const userTurns = (transcript || []).filter((t) => t.role === 'user' && String(t.message || '').trim()).length;
  const text = (transcript || []).map((t) => String(t.message || '')).join(' ').toLowerCase();
  if (/\b(stop calling|remove me|do not call|don't call|take me off)\b/.test(text)) return 'dnc';
  if (userTurns === 0) return durationS >= 12 ? 'voicemail' : 'no_answer';
  if (/\b(voicemail|leave a message|after the tone|not available)\b/.test(text) && userTurns <= 1) return 'voicemail';
  if (analysis?.call_successful === 'success') return 'answered_interested';
  return 'unknown';
}

const OUTCOME_LABEL: Record<AgentOutcome, string> = {
  answered_interested: 'answered · interested', callback: 'callback promised', gatekeeper: 'front desk took a message',
  not_interested: 'not interested', wrong_icp: 'not a hair salon', dnc: 'asked us to stop', voicemail: 'voicemail',
  no_answer: 'no answer', unknown: 'ended',
};
const OUTCOME_DISPO: Record<AgentOutcome, string> = {
  answered_interested: 'connected', callback: 'callback', gatekeeper: 'connected', not_interested: 'not_interested',
  wrong_icp: 'not_interested', dnc: 'not_interested', voicemail: 'voicemail', no_answer: 'no_answer', unknown: 'connected',
};

function dcValue(dc: any, key: string): string {
  const v = dc?.[key];
  const s = v && typeof v === 'object' ? v.value : v;
  return s == null || s === 'null' || s === 'unknown' ? '' : String(s).trim();
}

/** Process one ElevenLabs post_call_transcription payload (webhook or backfill). */
export async function handlePostCall(data: any): Promise<{ ok: boolean; outcome?: AgentOutcome; note?: string }> {
  const db = supabaseAdmin();
  if (!db) return { ok: false, note: 'no db' };
  const conversationId: string = data?.conversation_id || '';
  const vars = data?.conversation_initiation_client_data?.dynamic_variables || {};
  let { data: call } = conversationId
    ? await db.from('agent_calls').select('*').eq('conversation_id', conversationId).maybeSingle()
    : { data: null as any };
  if (!call && vars.call_id) ({ data: call } = await db.from('agent_calls').select('*').eq('id', vars.call_id).maybeSingle());
  if (!call) return { ok: false, note: 'no matching agent_call' };
  if (call.status === 'ended') return { ok: true, outcome: call.outcome, note: 'already processed' };

  const transcript = (data?.transcript || []).map((t: any) => ({ role: t.role, message: t.message || '', t: t.time_in_call_secs })).filter((t: any) => t.message);
  const durationS = Number(data?.metadata?.call_duration_secs ?? 0) || Math.round(Number(transcript.at(-1)?.t || 0));
  const analysis = data?.analysis || {};
  const dc = analysis.data_collection_results || {};
  const outcome = outcomeFrom(analysis, transcript, durationS, data?.status);
  const summary: string = analysis.transcript_summary || '';
  const collected = {
    owner_name: dcValue(dc, 'owner_name'), hours: dcValue(dc, 'hours'), mobile: dcValue(dc, 'mobile'),
    callback_time: dcValue(dc, 'callback_time'), product_interest: dcValue(dc, 'product_interest'), notes: dcValue(dc, 'notes'),
  };
  const now = new Date().toISOString();
  await db.from('agent_calls').update({
    status: 'ended', outcome, summary: summary || null, transcript, data: collected, duration_s: durationS, ended_at: now,
    conversation_id: call.conversation_id || conversationId || null,
  }).eq('id', call.id);

  const { data: lead } = await db.from('leads').select('*, contacts(id,name,role,phone,email,is_primary)').eq('id', call.lead_id).maybeSingle();
  if (!lead) return { ok: true, outcome, note: 'lead gone' };

  // Timeline entry on the lead.
  const who = ERYN.name();
  const transcriptText = transcript.map((t: any) => `${t.role === 'agent' ? who : 'Her'}: ${t.message}`).join('\n');
  await db.from('activities').insert({
    lead_id: lead.id, rep_id: call.rep_id || null, kind: 'call', direction: 'out',
    disposition: OUTCOME_DISPO[outcome], body: `${who} · ${OUTCOME_LABEL[outcome]}${durationS ? ` · ${Math.floor(durationS / 60)}:${String(durationS % 60).padStart(2, '0')}` : ''}`,
    ai_note: summary || null, transcript: transcriptText || null, duration_s: durationS || null,
  });

  // Contact facts she captured.
  const cp: any = {};
  if (collected.owner_name) cp.name = collected.owner_name;
  if (collected.mobile && toE164(collected.mobile)) cp.phone = toE164(collected.mobile);
  if (Object.keys(cp).length) {
    const { data: existing } = await db.from('contacts').select('id').eq('lead_id', lead.id).eq('is_primary', true).maybeSingle();
    if (existing) await db.from('contacts').update({ ...cp, role: cp.name ? 'Owner' : undefined }).eq('id', existing.id);
    else await db.from('contacts').insert({ lead_id: lead.id, is_primary: true, role: 'Owner', ...cp });
  }
  const noteBits = [collected.hours && `Hours: ${collected.hours}`, collected.product_interest && `Interested in: ${collected.product_interest}`, collected.notes].filter(Boolean);

  // Route the lead.
  const lp: any = {};
  const repOwner = () => { lp.owner = 'rep'; };
  if (noteBits.length) lp.notes = [lead.notes, `${who}: ${noteBits.join(' · ')}`].filter(Boolean).join('\n');
  switch (outcome) {
    case 'dnc':
      lp.dnc = true; lp.dnc_at = now; lp.stage = 'cold'; repOwner(); break;
    case 'wrong_icp':
      lp.stage = 'cold'; repOwner(); break;
    case 'not_interested':
      lp.stage = 'cold'; lp.next_action_at = new Date(Date.now() + 90 * 864e5).toISOString(); repOwner(); break;
    case 'answered_interested':
      lp.stage = 'hot'; lp.next_action_at = now; repOwner(); break;
    case 'callback':
      lp.stage = 'working'; lp.callback_note = collected.callback_time ? `${who}: she asked for ${collected.callback_time}` : `${who}: callback promised`;
      lp.next_action_at = now; repOwner(); break;
    case 'gatekeeper':
      lp.stage = 'working'; lp.next_action_at = now; repOwner(); break;
    case 'voicemail':
    case 'no_answer': {
      const attempts = lead.agent_attempts ?? 0;
      if (attempts >= MAX_ATTEMPTS) { repOwner(); lp.next_action_at = now; }
      else lp.agent_next_at = new Date(Date.now() + RETRY_HOURS * 3600e3).toISOString();
      break;
    }
    default:
      repOwner(); lp.next_action_at = now;
  }
  await db.from('leads').update(lp).eq('id', lead.id);

  // The text. Eryn promised "Seth will text you" — Relay keeps the promise, from the Relay number, signed by the rep.
  let textKey: string | null = null;
  if (outcome === 'no_answer') textKey = (lead.agent_attempts ?? 1) <= 1 ? 'na1' : 'vm';
  else if (outcome === 'voicemail') textKey = 'vm';
  else if (outcome === 'gatekeeper') textKey = 'gate';
  if (textKey && !lp.dnc) {
    // Never two texts in one day.
    const { data: recent } = await db.from('messages').select('id').eq('lead_id', lead.id).eq('channel', 'text').eq('direction', 'out')
      .gte('created_at', new Date(Date.now() - 20 * 3600e3).toISOString()).limit(1);
    if (!recent || !recent.length) {
      const tpl = withOverrides(TEXT_TEMPLATES, 'text', await loadTemplateOverrides()).find((t) => t.key === textKey);
      let me: any = null;
      const repId = call.rep_id || lead.owner_rep_id || lead.last_rep_id || null;
      if (repId) ({ data: me } = await db.from('reps').select('id, name, forward_to, phone_number').eq('id', repId).maybeSingle());
      if (tpl) {
        const body = renderTpl(tpl.body, { lead: toLead({ ...lead, contacts: cp.name ? [{ ...(lead.contacts?.[0] || {}), name: cp.name, is_primary: true }] : lead.contacts }), me: me ? { id: me.id, name: me.name, role: 'rep', forwardTo: me.forward_to, phoneNumber: me.phone_number } : null });
        const sent = await sendSmsServer({ to: lead.phone, body, leadId: lead.id, repId: null });
        if (sent.ok) await db.from('activities').insert({ lead_id: lead.id, kind: 'text', direction: 'out', body });
        else console.error('agent post-call text failed', sent.error);
      }
    }
  }

  // Shift bookkeeping: count answers, pause after N wrong-ICP in a row.
  const { data: shift } = await db.from('agent_shifts').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (shift) {
    const sp: any = {};
    if (['answered_interested', 'callback', 'gatekeeper', 'not_interested', 'wrong_icp', 'dnc'].includes(outcome)) sp.answered = (shift.answered ?? 0) + 1;
    if (outcome === 'wrong_icp') {
      const { data: last } = await db.from('agent_calls').select('outcome').eq('status', 'ended').order('ended_at', { ascending: false }).limit(WRONG_ICP_PAUSE);
      if (last && last.length === WRONG_ICP_PAUSE && last.every((c) => c.outcome === 'wrong_icp')) { sp.status = 'paused'; sp.paused_note = `${WRONG_ICP_PAUSE} wrong-ICP calls in a row — check the list`; }
    }
    if (outcome === 'dnc') { sp.status = 'paused'; sp.paused_note = `${lead.salon} asked us to stop — have a look before continuing`; }
    if ((shift.dials ?? 0) >= shift.cap) { sp.status = 'done'; sp.ended_at = now; }
    if (Object.keys(sp).length) await db.from('agent_shifts').update(sp).eq('id', shift.id);
  }
  return { ok: true, outcome };
}

/** Mark a lead DNC right now (the agent's mark_dnc tool, or a rep). */
export async function markDnc(leadId: string, why?: string) {
  const db = supabaseAdmin();
  if (!db) return false;
  const now = new Date().toISOString();
  await db.from('leads').update({ dnc: true, dnc_at: now, owner: 'rep', stage: 'cold' }).eq('id', leadId);
  await db.from('activities').insert({ lead_id: leadId, kind: 'system', body: `Do not contact${why ? ` — ${why}` : ''}` });
  return true;
}

// ── shift runner ─────────────────────────────────────────────────────────────
/** Called every minute. Returns what it did. */
export async function runShiftTick(): Promise<{ dialed?: string; skipped?: string; note?: string }> {
  const db = supabaseAdmin();
  if (!db) return { note: 'no db' };

  // Close out calls that never got a webhook (try a backfill first).
  const staleBefore = new Date(Date.now() - STALE_MIN * 60_000).toISOString();
  const { data: stale } = await db.from('agent_calls').select('id, conversation_id').in('status', ['queued', 'ringing', 'in_progress']).lt('started_at', staleBefore).limit(5);
  for (const c of stale || []) {
    const conv = c.conversation_id ? await getConversation(c.conversation_id) : null;
    if (conv && conv.status && conv.status !== 'in-progress' && conv.status !== 'processing') await handlePostCall(conv);
    else await db.from('agent_calls').update({ status: 'failed', error: 'no post-call webhook received', ended_at: new Date().toISOString() }).eq('id', c.id);
  }

  const { data: shift } = await db.from('agent_shifts').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!shift) return { note: 'no shift' };
  if ((shift.dials ?? 0) >= shift.cap) { await db.from('agent_shifts').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', shift.id); return { note: 'cap reached' }; }

  const { data: live } = await db.from('agent_calls').select('id').in('status', ['queued', 'ringing', 'in_progress']).gte('started_at', staleBefore).limit(1);
  if (live && live.length) return { note: 'on a call' };
  // A breath between calls so the webhook + text land before the next dial.
  if (shift.last_dial_at && Date.now() - new Date(shift.last_dial_at).getTime() < 45_000) return { note: 'cooldown' };

  const now = new Date().toISOString();
  const { data: cands } = await db.from('leads').select('id, salon, city, line_type, agent_attempts, agent_next_at')
    .eq('owner', 'agent').eq('dnc', false).eq('deployed', true).in('stage', ['new', 'working'])
    .not('phone', 'is', null).neq('line_type', 'mobile').lt('agent_attempts', MAX_ATTEMPTS)
    .or(`agent_next_at.is.null,agent_next_at.lte.${now}`)
    .order('agent_attempts', { ascending: true }).order('created_at', { ascending: true }).limit(25);
  const next = (cands || []).find((l) => inCallingWindow(l.city));
  if (!next) return { note: (cands || []).length ? 'outside her hours' : 'queue empty' };
  const r = await placeAgentCall(next.id, { kind: 'cold', shiftId: shift.id });
  if (!r.ok) {
    // Mobile / dnc / etc. already re-routed the lead; a provider failure pauses the shift so it can't burn the list.
    if (r.reason === 'provider') await db.from('agent_shifts').update({ status: 'paused', paused_note: `ElevenLabs: ${r.error}` }).eq('id', shift.id);
    return { skipped: `${next.salon}: ${r.error}` };
  }
  return { dialed: next.salon };
}
