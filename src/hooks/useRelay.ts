'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { Lead, Activity, Channel, Disposition, DispositionKey, CadenceStep, Stage, Message, Rep, Cadence } from '@/lib/types';
import { SEED_LEADS, SEED_ACTIVITIES, SEED_MESSAGES } from '@/lib/seedData';
import { planForStage, callAttempt, AI_NOTE, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, branchFor, DISPO_LABEL } from '@/lib/cadence';
import { repoEnabled, fetchLeads, fetchActivities, fetchTodayStats, fetchCadenceProgress, updateCadencePos, insertActivity, updateStage, attachLatestOwnNote, bulkInsertLeads, fetchMessages, markThreadRead, markMessagesRead, subscribeMessages, subscribeActivities, fetchMe, fetchReps, signOut as repoSignOut, fetchCadences, createCadence, renameCadence, deleteCadence, saveCadenceSteps, assignLeadCadence, createLeadQuick, setLeadNextAction, deployStagedLeads, updateLeadEnrichment, deleteLead as deleteLeadRepo } from '@/lib/repo';
import type { ImportRow } from '@/lib/repo';
import { mapToImportRows } from '@/lib/csv';

export type View = 'leads' | 'staging' | 'enrich' | 'dialer' | 'keypad' | 'inbox' | 'cadences' | 'reports' | 'mobile';
export interface EnrichResult { found: boolean; name?: string; phone?: string; email?: string; website?: string; bookingSystem?: string; city?: string; address?: string; hours?: string[]; error?: string }

const DEFAULT_CADENCE_ID = '11111111-1111-1111-1111-111111111111';
const SEED_CADENCES: Cadence[] = [
  {
    id: 'cad-default',
    name: 'Cold Salon Outbound',
    steps: [
      { position: 0, channel: 'call', waitMinutes: 0 },
      { position: 1, channel: 'call', waitMinutes: 1440 },
      { position: 2, channel: 'text', waitMinutes: 60, template: DEFAULT_SMS },
      { position: 3, channel: 'email', waitMinutes: 0, template: DEFAULT_EMAIL_BODY, subject: DEFAULT_EMAIL_SUBJECT },
    ],
  },
];
export interface RecentDial { id: string; number: string; kind: 'call' | 'text'; body?: string; time: string; leadId?: string; salon?: string }
export type FlowPhase = 'action' | 'incall' | 'dispo' | 'connected' | 'note';
interface QueueItem { leadId: string; plan: Channel[]; steps: CadenceStep[]; step: number }
interface FlowState {
  on: boolean;
  queue: QueueItem[];
  pos: number;
  phase: FlowPhase;
  actionCount: number;
  pendingAdvance: 'onward' | 'next_salon' | null;
  noteActivityId: string | null;
  noteAiText: string | null;
  paused: boolean;
}
interface ActiveCall { leadId: string; direction: 'out' | 'in'; viaFlow: boolean; incomingCall?: any }

const uid = () => 'x' + Math.random().toString(36).slice(2, 9);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const last10 = (p?: string) => (p || '').replace(/\D/g, '').slice(-10);

const DAY_MS = 864e5;
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
// A lead is "due" if it's deployed into a cadence, still in rotation, and either
// never scheduled or its snooze has expired. Staged leads are never due.
const leadIsDue = (l: Lead) =>
  l.deployed !== false && l.stage !== 'won' && l.stage !== 'cold' && (!l.nextActionAt || new Date(l.nextActionAt).getTime() <= endOfToday());
const leadIsScheduled = (l: Lead) =>
  l.deployed !== false && l.stage !== 'won' && l.stage !== 'cold' && !!l.nextActionAt && new Date(l.nextActionAt).getTime() > endOfToday();

export function useRelay() {
  const [view, setView] = useState<View>('leads');
  const [leads, setLeads] = useState<Lead[]>(SEED_LEADS);
  const [activities, setActivities] = useState<Record<string, Activity[]>>(clone(SEED_ACTIVITIES));
  // Daily activity counters shown in the top bar. Demo mode shows plausible
  // numbers; a real session seeds from today's logged activity (see hydrate).
  const [stats, setStats] = useState({ dials: 24, conversations: 7, voicemails: 9, texts: 15, emails: 22, demos: 3 });
  const [activeLeadId, setActiveLeadId] = useState<string>('l1');
  const [flow, setFlow] = useState<FlowState>({
    on: false, queue: [], pos: 0, phase: 'action', actionCount: 0,
    pendingAdvance: null, noteActivityId: null, noteAiText: null, paused: false,
  });
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  const [activeThreadLead, setActiveThreadLead] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [inbound, setInbound] = useState<{ leadId: string; call?: any } | null>(null);
  const [me, setMe] = useState<Rep | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [cadences, setCadences] = useState<Cadence[]>(SEED_CADENCES);
  const [recentDials, setRecentDials] = useState<RecentDial[]>([]);
  const leadsRef = useRef<Lead[]>(leads);
  leadsRef.current = leads;
  const cadencesRef = useRef<Cadence[]>(cadences);
  cadencesRef.current = cadences;
  const activitiesRef = useRef<Record<string, Activity[]>>(activities);
  activitiesRef.current = activities;

  const enabled = repoEnabled(); // Supabase-backed vs in-memory demo
  const loaded = useRef<Set<string>>(new Set());

  // Hydrate from Supabase when configured, + realtime inbound messages.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      const [rows, msgs, meRow, repRows, cadRows] = await Promise.all([fetchLeads(), fetchMessages(), fetchMe(), fetchReps(), fetchCadences()]);
      if (!alive) return;
      setLeads(rows);                 // may be empty for a brand-new rep — that's correct
      if (rows.length) setActiveLeadId(rows[0].id);
      setMessages(msgs);
      setMe(meRow);
      setReps(repRows);
      if (cadRows.length) setCadences(cadRows);
      fetchTodayStats().then((t) => { if (alive) setStats(t); }); // seed from today's real activity
    })();
    const unsub = subscribeMessages((m) => {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    });
    return () => { alive = false; unsub(); };
  }, [enabled]);

  // Register the Twilio inbound-call handler (real calls ring here).
  useEffect(() => {
    let cancelled = false;
    import('@/lib/voice').then((v) => {
      if (cancelled) return;
      v.onIncoming((call: any) => {
        const from = call?.parameters?.From || '';
        const digits = from.replace(/[^0-9]/g, '').slice(-10);
        const lead = leadsRef.current.find((l) => (l.phone || '').replace(/[^0-9]/g, '').slice(-10) === digits);
        setInbound({ leadId: lead?.id || leadsRef.current[0]?.id, call });
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Lazy-load a lead's activities from Supabase the first time it's viewed.
  useEffect(() => {
    if (!enabled || !activeLeadId || loaded.current.has(activeLeadId)) return;
    loaded.current.add(activeLeadId);
    fetchActivities(activeLeadId).then((rows) => {
      if (rows.length) setActivities((prev) => ({ ...prev, [activeLeadId]: rows }));
    });
  }, [enabled, activeLeadId]);

  // Live-merge activity inserts/updates for the active lead (a call's recording
  // + AI summary arrives via webhook seconds after hangup — this makes it pop in
  // without a refresh). Replace by id on UPDATE, prepend on INSERT.
  useEffect(() => {
    if (!enabled || !activeLeadId) return;
    const unsub = subscribeActivities(activeLeadId, (a) => {
      setActivities((prev) => {
        const list = prev[activeLeadId] || [];
        const i = list.findIndex((x) => x.id === a.id);
        const next = i >= 0 ? list.map((x) => (x.id === a.id ? { ...x, ...a } : x)) : [a, ...list];
        return { ...prev, [activeLeadId]: next };
      });
    });
    return unsub;
  }, [enabled, activeLeadId]);

  const leadById = useCallback((id: string) => leads.find((l) => l.id === id), [leads]);

  const addActivity = useCallback((leadId: string, a: Omit<Activity, 'id' | 'leadId'>) => {
    const id = uid();
    setActivities((prev) => {
      const next = { ...prev };
      next[leadId] = [{ id, leadId, ...a }, ...(prev[leadId] || [])];
      return next;
    });
    if (enabled) {
      insertActivity(leadId, {
        kind: a.kind, direction: a.direction, disposition: a.disposition,
        aiNote: a.aiNote, ownNote: a.ownNote, body: a.body,
      });
    }
    return id;
  }, [enabled]);

  const setStage = useCallback((leadId: string, stage: Stage) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, stage } : l)));
    if (enabled) updateStage(leadId, stage);
  }, [enabled]);

  // CSV import → Supabase bulk insert (or append locally in demo mode).
  const importLeads = useCallback(async (csv: string, ownerRepId?: string): Promise<number> => {
    const rows = mapToImportRows(csv);
    if (!rows.length) return 0;
    if (enabled) {
      const n = await bulkInsertLeads(rows, ownerRepId);
      const fresh = await fetchLeads();
      setLeads(fresh);
      return n;
    }
    setLeads((prev) => [
      ...prev,
      ...rows.map((r, i) => ({
        id: 'imp' + Date.now() + i,
        salon: r.salon, city: r.city || '', phone: r.phone || '',
        email: r.email, stage: 'new' as Stage, cadenceId: 'c1', cadencePos: 0,
        objection: 'Gatekeeper', lastTouch: 'New',
        contact: { id: 'c' + i, name: r.contactName || '—', role: r.role || 'Front desk', phone: r.phone },
      })),
    ]);
    return rows.length;
  }, [enabled]);

  // Import pre-cleaned/validated rows (from the smart-import preview).
  const importCleanRows = useCallback(async (rows: ImportRow[], ownerRepId?: string): Promise<number> => {
    if (!rows.length) return 0;
    if (enabled) {
      const n = await bulkInsertLeads(rows, ownerRepId);
      const fresh = await fetchLeads();
      setLeads(fresh);
      return n;
    }
    setLeads((prev) => [
      ...prev,
      ...rows.map((r, i) => ({
        id: 'imp' + Date.now() + i, salon: r.salon, city: r.city || '', phone: r.phone || '',
        email: r.email, stage: 'new' as Stage, cadenceId: DEFAULT_CADENCE_ID, cadencePos: 0, deployed: false,
        objection: 'Gatekeeper', lastTouch: 'New',
        contact: { id: 'c' + i, name: r.contactName || '—', role: r.role || 'Front desk', phone: r.phone },
      })),
    ]);
    return rows.length;
  }, [enabled]);

  // ── Flow control ───────────────────────────────────────────────────────────
  // Build the session queue from the rep's current book (RLS already scoped it).
  const startFlow = useCallback(async (onlyIds?: string[]) => {
    const idSet = onlyIds ? new Set(onlyIds) : null;
    const book = leadsRef.current
      .filter((l) => l.deployed !== false && l.stage !== 'won') // staged leads aren't worked
      .filter((l) => !idSet || idSet.has(l.id));
    if (!book.length) return; // nothing to work

    // How far each salon already is in its cadence, from real logged touches, so
    // the flow resumes instead of restarting at attempt 1. Real mode queries the
    // DB; demo mode counts the activities already in memory.
    let progress: Record<string, number> = {};
    if (enabled) {
      progress = await fetchCadenceProgress(book.map((l) => l.id));
    } else {
      for (const l of book) {
        progress[l.id] = (activitiesRef.current[l.id] || []).filter(
          (a) => (a.kind === 'call' || a.kind === 'book' || a.kind === 'text' || a.kind === 'email') && a.direction !== 'in'
        ).length;
      }
    }

    const resumeStep: Record<string, number> = {};
    const queue: QueueItem[] = book.map((l) => {
      // Run the lead's assigned cadence (its call/text/email steps, skipping waits);
      // fall back to the stage-based default plan when no cadence is set. `steps`
      // stays aligned with `plan` so each call can read its branch rules.
      const cad = cadencesRef.current.find((c) => c.id === l.cadenceId);
      const actionable = (cad?.steps || []).filter((s) => s.channel !== 'wait');
      const plan = actionable.length ? actionable.map((s) => s.channel as Channel) : planForStage(l.stage);
      const steps = actionable.length ? actionable : [];
      const done = progress[l.id] ?? l.cadencePos ?? 0;
      const step = Math.min(done, Math.max(0, plan.length - 1)); // resume where the touches left off
      resumeStep[l.id] = step;
      return { leadId: l.id, plan, steps, step };
    });

    // Reflect the resume point in the queue rail ("X/5") too.
    setLeads((prev) => prev.map((l) => (resumeStep[l.id] != null ? { ...l, cadencePos: resumeStep[l.id] } : l)));
    setFlow({ on: true, queue, pos: 0, phase: 'action', actionCount: 0, pendingAdvance: null, noteActivityId: null, noteAiText: null, paused: false });
    setActiveLeadId(queue[0].leadId);
    setView('dialer');
  }, [enabled]);
  const signOut = useCallback(() => { repoSignOut(); }, []);

  const exitFlow = useCallback(() => {
    setFlow((f) => ({ ...f, on: false, phase: 'action' }));
  }, []);

  const advance = useCallback((kind: 'onward' | 'next_salon') => {
    setFlow((f) => {
      const item = f.queue[f.pos];
      if (!item) return f;
      if (kind === 'onward') {
        const step = item.step + 1;
        if (step < item.plan.length) {
          const q = f.queue.slice();
          q[f.pos] = { ...item, step };
          setActiveLeadId(item.leadId);
          // Remember how far this salon has progressed (rail + durable).
          setLeads((prev) => prev.map((l) => (l.id === item.leadId ? { ...l, cadencePos: step } : l)));
          if (enabled) updateCadencePos(item.leadId, step);
          return { ...f, queue: q, phase: 'action' };
        }
        // fall through to next salon
      }
      const pos = f.pos + 1;
      const nextItem = f.queue[pos];
      // Keep the next salon's resume step (set at flow start) — don't reset to 0.
      if (nextItem) { setActiveLeadId(nextItem.leadId); }
      return { ...f, pos, phase: 'action', pendingAdvance: null };
    });
  }, [enabled]);

  const current = flow.queue[flow.pos];
  const currentLead = current ? leadById(current.leadId) : undefined;
  const currentChannel = current?.plan[current.step];
  const attemptInfo = current && currentChannel === 'call'
    ? callAttempt(current.plan, current.step)
    : { attempt: 1, totalCalls: 1 };

  const flowCall = useCallback(() => {
    if (!current) return;
    // Dials are counted when the call is dispositioned (see applyDispo), so a
    // ring that's abandoned before an outcome doesn't inflate the count.
    setActiveCall({ leadId: current.leadId, direction: 'out', viaFlow: true });
    setFlow((f) => ({ ...f, actionCount: f.actionCount + 1, phase: 'incall' }));
  }, [current]);

  // Called by the live CallPanel's "End & log" (both outbound-flow and inbound).
  const endCall = useCallback(() => {
    const ac = activeCall;
    setActiveCall(null);
    if (ac && ac.direction === 'in') {
      addActivity(ac.leadId, { kind: 'call', direction: 'in', ai: true, ty: 'Inbound call — connected', time: 'Just now', aiNote: 'They called us back. Logged from Relay.', body: 'Inbound return call.' });
      setStage(ac.leadId, 'hot');
    }
    setFlow((f) => {
      if (f.paused) { const cur = f.queue[f.pos]; if (cur) setActiveLeadId(cur.leadId); return { ...f, paused: false }; }
      if (ac?.viaFlow) return { ...f, phase: 'dispo' };
      return f;
    });
  }, [activeCall, addActivity, setStage]);

  // ── Inbox ──────────────────────────────────────────────────────────────────
  const unreadCount = messages.filter((m) => !m.isRead && m.direction === 'in').length;

  // A message threads under its lead when it has one; otherwise under the
  // counterpart phone number — and if that number matches a lead we already
  // have, it merges into that lead's thread (covers texts whose lead_id is null
  // because the inbound webhook couldn't match them at the time).
  const threadKeyForMessage = useCallback((m: Message): string | null => {
    if (m.leadId) return m.leadId;
    const d = last10(m.phone);
    if (d.length === 10) {
      const lead = leadsRef.current.find((l) => last10(l.phone) === d);
      return lead ? lead.id : 'tel:' + d;
    }
    return m.phone ? 'tel:' + (m.phone || '').trim() : null;
  }, []);

  const openThread = useCallback((key: string) => {
    setActiveThreadLead(key);
    if (!key.startsWith('tel:')) setActiveLeadId(key);
    const ids: string[] = [];
    setMessages((prev) => prev.map((m) => {
      if (threadKeyForMessage(m) === key && !m.isRead && m.direction === 'in') { ids.push(m.id); return { ...m, isRead: true }; }
      return m;
    }));
    // Persist read only for real DB rows (uuid ids; skip local temp 'x…' ids).
    if (enabled) { const dbIds = ids.filter((id) => id.length > 20); if (dbIds.length) markMessagesRead(dbIds); }
  }, [enabled, threadKeyForMessage]);
  const closeThread = useCallback(() => setActiveThreadLead(null), []);

  // Low-level senders. Return the provider result so callers can reconcile the
  // optimistic inbox bubble (swap in the DB id) or flag it as failed.
  const sendSms = useCallback(async (to: string, body: string, leadId?: string): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
    try {
      const res = await fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body, leadId }) });
      const j = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, messageId: j.messageId } : { ok: false, error: j.error || `Send failed (${res.status})` };
    } catch { return { ok: false, error: 'Network error — send did not go through.' }; }
  }, []);
  const sendEmailApi = useCallback(async (to: string, subject: string | undefined, body: string, leadId?: string): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
    try {
      const res = await fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject, body, leadId }) });
      const j = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, messageId: j.messageId } : { ok: false, error: j.error || `Send failed (${res.status})` };
    } catch { return { ok: false, error: 'Network error — send did not go through.' }; }
  }, []);

  // Reconcile an optimistic bubble once the provider responds: swap in the DB id
  // (so realtime doesn't double it), clear pending, or mark it failed.
  const reconcileSent = useCallback((tempId: string, r: { ok: boolean; messageId?: string }) => {
    setMessages((prev) => {
      if (r.ok && r.messageId && prev.some((m) => m.id === r.messageId)) return prev.filter((m) => m.id !== tempId);
      return prev.map((m) => (m.id === tempId ? { ...m, id: r.ok && r.messageId ? r.messageId : m.id, pending: false, failed: !r.ok } : m));
    });
  }, []);

  const sendReply = useCallback((leadId: string, body: string) => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    const thread = messages.filter((m) => m.leadId === leadId);
    const channel = (thread.length ? thread[thread.length - 1].channel : 'text') as 'text' | 'email';
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead?.salon || '', channel, direction: 'out', body, time: 'now', isRead: true, pending: true, phone: lead?.phone }]);
    addActivity(leadId, { kind: channel, direction: 'out', ty: `${channel === 'email' ? 'Email' : 'Text'} reply sent`, time: 'Just now', body: `"${body}"` });
    const lid = enabled ? leadId : undefined;
    (async () => {
      let r: { ok: boolean; messageId?: string; error?: string };
      if (channel === 'text') r = lead?.phone ? await sendSms(lead.phone, body, lid) : { ok: false, error: 'No phone on file for this lead.' };
      else r = lead?.email ? await sendEmailApi(lead.email, 'Re: Relay', body, lid) : { ok: false, error: 'No email on file for this lead.' };
      reconcileSent(tempId, r);
    })();
  }, [messages, addActivity, enabled, sendSms, sendEmailApi, reconcileSent]);

  // Reply within a thread. Lead threads go through sendReply; phone-only threads
  // (key "tel:<digits>") send straight to that number and thread by phone.
  const sendThreadReply = useCallback((key: string, body: string) => {
    if (!key.startsWith('tel:')) { sendReply(key, body); return; }
    const number = key.slice(4);
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId: undefined, who: 'You', salon: '', channel: 'text', direction: 'out', body, time: 'now', isRead: true, pending: true, phone: number }]);
    (async () => { const r = await sendSms(number, body, undefined); reconcileSent(tempId, r); })();
  }, [sendReply, sendSms, reconcileSent]);

  // Re-attempt a failed outbound message from the Inbox.
  const retrySend = useCallback((messageId: string) => {
    const m = messages.find((x) => x.id === messageId);
    if (!m || !m.leadId) return;
    const lead = leadsRef.current.find((l) => l.id === m.leadId);
    setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, failed: false, pending: true } : x)));
    const lid = enabled ? m.leadId : undefined;
    (async () => {
      let r: { ok: boolean; messageId?: string; error?: string };
      if (m.channel === 'text') r = lead?.phone ? await sendSms(lead.phone, m.body, lid) : { ok: false, error: 'No phone on file.' };
      else r = lead?.email ? await sendEmailApi(lead.email, m.subject, m.body, lid) : { ok: false, error: 'No email on file.' };
      reconcileSent(messageId, r);
    })();
  }, [messages, enabled, sendSms, sendEmailApi, reconcileSent]);

  // ── Inbound calls ──────────────────────────────────────────────────────────
  const ringInbound = useCallback((leadId: string, call?: any) => setInbound({ leadId, call }), []);
  const simInbound = useCallback(() => ringInbound('l3'), [ringInbound]); // Marisol returning the call
  const answerInbound = useCallback(() => {
    setInbound((cur) => {
      if (!cur) return null;
      setView('dialer');
      setActiveLeadId(cur.leadId);
      setFlow((f) => (f.on ? { ...f, paused: true } : f));
      setActiveCall({ leadId: cur.leadId, direction: 'in', viaFlow: false, incomingCall: cur.call });
      return null;
    });
  }, []);
  const declineInbound = useCallback(() => {
    setInbound((cur) => {
      if (!cur) return null;
      const lead = leadsRef.current.find((l) => l.id === cur.leadId);
      addActivity(cur.leadId, { kind: 'call', direction: 'in', ty: 'Missed inbound call', time: 'Just now', body: 'They called back — went to voicemail. Follow up.' });
      setMessages((prev) => [...prev, { id: uid(), leadId: cur.leadId, who: lead?.contact?.name || '—', salon: lead?.salon || '', channel: 'text', direction: 'in', body: '[Missed call] voicemail: "Hi, returning your call about the salon thing…"', time: 'now', isRead: false }]);
      return null;
    });
  }, [addActivity]);

  const flowSend = useCallback((channel: 'text' | 'email', body: string, subject?: string) => {
    if (!current) return;
    const lead = leadById(current.leadId);
    const leadId = current.leadId;
    setStats((s) => (channel === 'text' ? { ...s, texts: s.texts + 1 } : { ...s, emails: s.emails + 1 }));
    addActivity(leadId, {
      kind: channel, direction: 'out',
      ty: channel === 'text' ? 'Text sent · ⚡Flow' : 'Email sent · ⚡Flow',
      time: 'Just now', body: subject ? `${subject} — ${body}` : body,
    });
    // Optimistically thread it into the Inbox, then reconcile on the provider reply.
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead?.salon || '', channel, direction: 'out', subject, body, time: 'now', isRead: true, pending: true, phone: lead?.phone }]);
    const lid = enabled ? leadId : undefined;
    (async () => {
      let r: { ok: boolean; messageId?: string; error?: string };
      if (channel === 'text') r = lead?.phone ? await sendSms(lead.phone, body, lid) : { ok: false, error: 'No phone on file for this lead.' };
      else r = lead?.email ? await sendEmailApi(lead.email, subject, body, lid) : { ok: false, error: 'No email on file for this lead.' };
      reconcileSent(tempId, r);
    })();
    setFlow((f) => ({ ...f, actionCount: f.actionCount + 1 }));
    advance('onward');
  }, [current, addActivity, advance, leadById, enabled, sendSms, sendEmailApi, reconcileSent]);

  const startNote = useCallback((activityId: string, aiText: string, adv: 'onward' | 'next_salon') => {
    setFlow((f) => ({ ...f, phase: 'note', pendingAdvance: adv, noteActivityId: activityId, noteAiText: aiText }));
  }, []);

  // Route a call outcome per the current cadence step's branch rules (or the
  // sensible defaults). This is the "if statement on disposition" at runtime.
  const applyDispo = useCallback((key: DispositionKey) => {
    if (!current) return;
    const step = current.steps[current.step];
    const action = branchFor(step, key);
    const ai = AI_NOTE[key] || '';
    // Every dispositioned call is one dial; layer on the outcome buckets.
    setStats((s) => ({
      ...s,
      dials: s.dials + 1,
      conversations: s.conversations + (key === 'booked' || key === 'callback' || key === 'not_interested' ? 1 : 0),
      voicemails: s.voicemails + (key === 'voicemail' ? 1 : 0),
      demos: s.demos + (key === 'booked' ? 1 : 0),
    }));
    const id = addActivity(current.leadId, {
      kind: key === 'booked' ? 'book' : 'call', direction: 'out', disposition: key as Disposition, ai: true,
      ty: `${DISPO_LABEL[key]} · ⚡Flow`, time: 'Just now', aiNote: ai, body: ai,
    });
    const notable = key !== 'no_answer'; // pause for a note on everything except a plain no-answer

    if (action.type === 'send') {
      // Splice the branch channel in right after the current step, then continue onto it.
      setFlow((f) => {
        const q = f.queue.slice(); const it = q[f.pos]; if (!it) return f;
        const plan = it.plan.slice(); const steps = it.steps.slice();
        plan.splice(it.step + 1, 0, action.channel);
        steps.splice(it.step + 1, 0, { position: it.step + 1, channel: action.channel, waitMinutes: 0 });
        q[f.pos] = { ...it, plan, steps };
        return { ...f, queue: q };
      });
      if (notable) startNote(id, ai, 'onward'); else advance('onward');
      return;
    }
    if (action.type === 'stop') {
      setStage(current.leadId, action.stage);
      startNote(id, ai, 'next_salon');
      return;
    }
    if (action.type === 'wait') {
      const iso = new Date(Date.now() + action.days * DAY_MS).toISOString();
      setLeads((prev) => prev.map((l) => (l.id === current.leadId ? { ...l, nextActionAt: iso } : l)));
      if (enabled) setLeadNextAction(current.leadId, iso);
      addActivity(current.leadId, { kind: 'note', ty: `Snoozed ${action.days} day${action.days === 1 ? '' : 's'} · ⚡Flow`, time: 'Just now', body: `Re-touch this salon in ${action.days} day${action.days === 1 ? '' : 's'}.` });
      startNote(id, ai, 'next_salon');
      return;
    }
    // continue
    if (notable) startNote(id, ai, 'onward'); else advance('onward');
  }, [current, addActivity, setStage, advance, startNote, enabled]);

  const flowDispo = useCallback((d: Disposition) => {
    if (!current) return;
    if (d === 'connected') { setFlow((f) => ({ ...f, phase: 'connected' })); return; }
    applyDispo(d as DispositionKey);
  }, [current, applyDispo]);

  const flowConnected = useCallback((kind: 'booked' | 'callback' | 'not_interested') => {
    applyDispo(kind);
  }, [applyDispo]);

  const saveNote = useCallback((text: string) => {
    if (flow.noteActivityId && text.trim()) {
      const aid = flow.noteActivityId;
      setActivities((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = next[k].map((a) => (a.id === aid ? { ...a, ownNote: text.trim() } : a));
        }
        return next;
      });
      if (enabled && current) attachLatestOwnNote(current.leadId, text.trim());
    }
    advance(flow.pendingAdvance || 'onward');
  }, [flow.noteActivityId, flow.pendingAdvance, advance, enabled, current]);

  const skipNote = useCallback(() => advance(flow.pendingAdvance || 'onward'), [flow.pendingAdvance, advance]);

  const flowSkip = useCallback(() => {
    if (!current) return;
    addActivity(current.leadId, { kind: 'note', ty: 'Skipped salon · ⚡Flow', time: 'Just now', body: 'Re-queued for later.' });
    advance('next_salon');
  }, [current, addActivity, advance]);

  // Jump the flow to a specific queued lead so the rep can act on it right now.
  // Moves that lead to the current position (from its first action) and lets the
  // lead they were on resume immediately after — nothing gets skipped.
  const workLeadNow = useCallback((leadId: string) => {
    setActiveLeadId(leadId);
    setFlow((f) => {
      const idx = f.queue.findIndex((q) => q.leadId === leadId);
      if (idx < 0 || idx === f.pos) return { ...f, phase: 'action' };
      const item = { ...f.queue[idx], step: 0 };
      const rest = f.queue.filter((_, i) => i !== idx);
      const insertAt = Math.min(f.pos, rest.length);
      const queue = [...rest.slice(0, insertAt), item, ...rest.slice(insertAt)];
      return { ...f, queue, pos: insertAt, phase: 'action' };
    });
  }, []);

  // ── Cadences ────────────────────────────────────────────────────────────────
  const cadenceById = useCallback((id?: string) => cadences.find((c) => c.id === id), [cadences]);

  const newCadence = useCallback(async (name: string): Promise<Cadence> => {
    let id = 'cad' + Date.now();
    if (enabled) { const dbId = await createCadence(name); if (dbId) id = dbId; }
    const c: Cadence = { id, name, steps: [{ position: 0, channel: 'call', waitMinutes: 0 }] };
    setCadences((prev) => [...prev, c]);
    if (enabled) saveCadenceSteps(id, c.steps);
    return c;
  }, [enabled]);

  const saveCadence = useCallback(async (cad: Cadence) => {
    setCadences((prev) => prev.map((c) => (c.id === cad.id ? cad : c)));
    if (enabled) { await renameCadence(cad.id, cad.name); await saveCadenceSteps(cad.id, cad.steps); }
  }, [enabled]);

  const removeCadence = useCallback(async (id: string) => {
    setCadences((prev) => prev.filter((c) => c.id !== id));
    if (enabled) await deleteCadence(id);
  }, [enabled]);

  const assignCadence = useCallback((leadId: string, cadenceId: string) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, cadenceId, cadencePos: 0 } : l)));
    if (enabled) assignLeadCadence(leadId, cadenceId);
  }, [enabled]);

  // ── Staging pool ─────────────────────────────────────────────────────────────
  const stagedLeads = leads.filter((l) => l.deployed === false);
  const activeLeads = leads.filter((l) => l.deployed !== false);
  // Deploy the N oldest staged leads into a cadence (they become due now).
  const deployLeads = useCallback(async (count: number, cadenceId: string): Promise<number> => {
    const pool = leadsRef.current.filter((l) => l.deployed === false); // oldest-first (fetch order)
    const picked = pool.slice(0, Math.max(0, count)).map((l) => l.id);
    if (!picked.length) return 0;
    const idSet = new Set(picked);
    setLeads((prev) => prev.map((l) => (idSet.has(l.id) ? { ...l, deployed: true, cadenceId, cadencePos: 0, nextActionAt: undefined, lastTouch: 'New' } : l)));
    if (enabled) { const moved = await deployStagedLeads(picked.length, cadenceId, me?.id); return moved.length || picked.length; }
    return picked.length;
  }, [enabled, me]);

  // Permanently remove a lead (and its local activities/messages). If it was the
  // active lead, jump to the next available one.
  const deleteLead = useCallback((leadId: string) => {
    const remaining = leadsRef.current.filter((l) => l.id !== leadId);
    setLeads(remaining);
    setActivities((prev) => { const n = { ...prev }; delete n[leadId]; return n; });
    setMessages((prev) => prev.filter((m) => m.leadId !== leadId));
    setActiveThreadLead((cur) => (cur === leadId ? null : cur));
    setActiveLeadId((cur) => (cur === leadId ? (remaining.find((l) => l.deployed !== false)?.id || remaining[0]?.id || cur) : cur));
    if (enabled) deleteLeadRepo(leadId);
  }, [enabled]);

  // ── Enrichment (Google Places) ───────────────────────────────────────────────
  const enrichableLeads = leads.filter((l) => !l.phone || !l.email || !l.website || !l.bookingSystem);
  const DEMO_BOOKING = ['Vagaro', 'Square Appointments', 'Boulevard', 'Booksy', 'GlossGenius', 'Fresha'];
  // Look a lead up on Google Places; returns what was found (does not save).
  const enrichLead = useCallback(async (leadId: string): Promise<EnrichResult> => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    if (!lead) return { found: false };
    if (!enabled) {
      // Demo mode: fabricate a plausible result so the flow is demonstrable.
      const slug = lead.salon.toLowerCase().replace(/[^a-z0-9]/g, '');
      const bk = DEMO_BOOKING[slug.length % DEMO_BOOKING.length];
      return { found: true, name: lead.salon, phone: lead.phone || '(303) 555-0148', email: lead.email || `hello@${slug}.com`, website: lead.website || `${slug}.com`, bookingSystem: lead.bookingSystem || bk, city: lead.city || 'Denver, CO', address: `${lead.city || 'Denver, CO'}`, hours: ['Mon–Fri 9 AM–6 PM', 'Sat 9 AM–4 PM', 'Sun closed'] };
    }
    try {
      const res = await fetch('/api/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salon: lead.salon, city: lead.city }) });
      return await res.json();
    } catch { return { found: false, error: 'Lookup failed.' }; }
  }, [enabled]);
  // Apply accepted enrichment fields to a lead.
  const saveEnrichment = useCallback((leadId: string, fields: { phone?: string; email?: string; city?: string; website?: string; bookingSystem?: string }) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? {
      ...l,
      phone: fields.phone ?? l.phone,
      email: fields.email ?? l.email,
      website: fields.website ?? l.website,
      bookingSystem: fields.bookingSystem ?? l.bookingSystem,
      city: fields.city ?? l.city,
      contact: l.contact ? { ...l.contact, phone: fields.phone ?? l.contact.phone, email: fields.email ?? l.contact.email } : l.contact,
    } : l)));
    if (enabled) updateLeadEnrichment(leadId, fields);
    addActivity(leadId, { kind: 'note', ty: 'Enriched from Google', time: 'Just now', body: 'Filled missing info from Google Places.' });
  }, [enabled, addActivity]);

  // ── Due-today scheduler ──────────────────────────────────────────────────────
  const dueLeads = leads.filter(leadIsDue);
  const scheduledLeads = leads.filter(leadIsScheduled);
  const startDueFlow = useCallback(() => startFlow(dueLeads.map((l) => l.id)), [startFlow, dueLeads]);
  // Manually snooze/reschedule a lead N days out (days<=0 clears → due now).
  const snoozeLead = useCallback((leadId: string, days: number) => {
    const iso = days > 0 ? new Date(Date.now() + days * DAY_MS).toISOString() : null;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, nextActionAt: iso || undefined } : l)));
    if (enabled) setLeadNextAction(leadId, iso);
    addActivity(leadId, { kind: 'note', ty: days > 0 ? `Snoozed ${days} day${days === 1 ? '' : 's'}` : 'Marked due now', time: 'Just now', body: days > 0 ? `Re-touch in ${days} day${days === 1 ? '' : 's'}.` : 'Back in today’s queue.' });
  }, [enabled, addActivity]);

  // ── Keypad (type-a-number dialer) ────────────────────────────────────────────
  const matchLeadByNumber = useCallback((number: string): Lead | undefined => {
    const d = number.replace(/[^0-9]/g, '').slice(-10);
    if (d.length < 10) return undefined;
    return leadsRef.current.find((l) => (l.phone || '').replace(/[^0-9]/g, '').slice(-10) === d);
  }, []);

  const logDial = useCallback((kind: 'call' | 'text', number: string, body?: string) => {
    const lead = matchLeadByNumber(number);
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    setRecentDials((prev) => [{ id: uid(), number, kind, body, time, leadId: lead?.id, salon: lead?.salon }, ...prev].slice(0, 40));
    setStats((s) => (kind === 'call' ? { ...s, dials: s.dials + 1 } : { ...s, texts: s.texts + 1 }));
    if (lead) {
      addActivity(lead.id, {
        kind, direction: 'out',
        ty: kind === 'call' ? 'Call — from keypad' : 'Text — from keypad',
        time: 'Just now', body: body || `Dialed ${number}`,
      });
    }
  }, [matchLeadByNumber, addActivity]);

  const sendKeypadText = useCallback((number: string, body: string) => {
    const lead = matchLeadByNumber(number);
    // Always thread it into the Inbox — under the lead if the number matches one,
    // otherwise as a phone-only thread so it's never invisible.
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId: lead?.id, who: 'You', salon: lead?.salon || '', channel: 'text', direction: 'out', body, time: 'now', isRead: true, pending: true, phone: number }]);
    (async () => {
      const r = await sendSms(number, body, enabled ? lead?.id : undefined);
      reconcileSent(tempId, r);
    })();
    logDial('text', number, body);
  }, [matchLeadByNumber, logDial, enabled, sendSms, reconcileSent]);

  const saveNumberAsLead = useCallback(async (number: string, salon: string): Promise<Lead | null> => {
    const name = salon.trim() || number;
    if (enabled) {
      const lead = await createLeadQuick(name, number, me?.id);
      if (lead) { setLeads((prev) => [...prev, lead]); setActiveLeadId(lead.id); setView('dialer'); return lead; }
      return null;
    }
    const lead: Lead = {
      id: 'kp' + Date.now(), salon: name, city: '', phone: number, stage: 'new',
      cadenceId: DEFAULT_CADENCE_ID, cadencePos: 0, contact: { id: 'c', name: '—', role: '—' }, lastTouch: 'New',
    };
    setLeads((prev) => [...prev, lead]); setActiveLeadId(lead.id); setView('dialer');
    return lead;
  }, [enabled, me]);

  return {
    view, setView, leads, activities, stats, activeLeadId, setActiveLeadId, leadById,
    flow, current, currentLead, currentChannel, attemptInfo, enabled, importLeads, importCleanRows,
    me, reps, signOut,
    startFlow, exitFlow, endCall, flowCall, flowSend, flowDispo, flowConnected, saveNote, skipNote, flowSkip, workLeadNow,
    addActivity, setStage,
    messages, activeThreadLead, unreadCount, openThread, closeThread, sendReply, sendThreadReply, retrySend, threadKeyForMessage,
    activeCall, inbound, ringInbound, simInbound, answerInbound, declineInbound,
    cadences, cadenceById, newCadence, saveCadence, removeCadence, assignCadence,
    recentDials, matchLeadByNumber, logDial, sendKeypadText, saveNumberAsLead,
    dueLeads, scheduledLeads, startDueFlow, snoozeLead,
    stagedLeads, activeLeads, deployLeads,
    enrichableLeads, enrichLead, saveEnrichment, deleteLead,
  };
}
