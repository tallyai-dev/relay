'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { Lead, Activity, Channel, Disposition, Stage, Message, Rep, Cadence } from '@/lib/types';
import { SEED_LEADS, SEED_ACTIVITIES, SEED_MESSAGES } from '@/lib/seedData';
import { planForStage, callAttempt, AI_NOTE, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from '@/lib/cadence';
import { repoEnabled, fetchLeads, fetchActivities, insertActivity, updateStage, attachLatestOwnNote, bulkInsertLeads, fetchMessages, markThreadRead, subscribeMessages, fetchMe, fetchReps, signOut as repoSignOut, fetchCadences, createCadence, renameCadence, deleteCadence, saveCadenceSteps, assignLeadCadence, createLeadQuick } from '@/lib/repo';
import { mapToImportRows } from '@/lib/csv';

export type View = 'leads' | 'dialer' | 'keypad' | 'inbox' | 'cadences' | 'reports' | 'mobile';

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
interface QueueItem { leadId: string; plan: Channel[]; step: number }
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

export function useRelay() {
  const [view, setView] = useState<View>('leads');
  const [leads, setLeads] = useState<Lead[]>(SEED_LEADS);
  const [activities, setActivities] = useState<Record<string, Activity[]>>(clone(SEED_ACTIVITIES));
  const [score, setScore] = useState({ calls: 27, texts: 15, emails: 22, demos: 3 });
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
      setScore({ calls: 0, texts: 0, emails: 0, demos: 0 }); // real session starts at zero
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

  // ── Flow control ───────────────────────────────────────────────────────────
  // Build the session queue from the rep's current book (RLS already scoped it).
  const startFlow = useCallback(() => {
    const queue: QueueItem[] = leadsRef.current
      .filter((l) => l.stage !== 'won')
      .map((l) => {
        // Run the lead's assigned cadence (its call/text/email steps, skipping waits);
        // fall back to the stage-based default plan when no cadence is set.
        const cad = cadencesRef.current.find((c) => c.id === l.cadenceId);
        const chans = (cad?.steps || []).filter((s) => s.channel !== 'wait').map((s) => s.channel as Channel);
        return { leadId: l.id, plan: chans.length ? chans : planForStage(l.stage), step: 0 };
      });
    if (!queue.length) return; // nothing to work
    setFlow({ on: true, queue, pos: 0, phase: 'action', actionCount: 0, pendingAdvance: null, noteActivityId: null, noteAiText: null, paused: false });
    setActiveLeadId(queue[0].leadId);
    setView('dialer');
  }, []);
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
          return { ...f, queue: q, phase: 'action' };
        }
        // fall through to next salon
      }
      const pos = f.pos + 1;
      const nextItem = f.queue[pos];
      if (nextItem) { nextItem.step = 0; setActiveLeadId(nextItem.leadId); }
      return { ...f, pos, phase: 'action', pendingAdvance: null };
    });
  }, []);

  const current = flow.queue[flow.pos];
  const currentLead = current ? leadById(current.leadId) : undefined;
  const currentChannel = current?.plan[current.step];
  const attemptInfo = current && currentChannel === 'call'
    ? callAttempt(current.plan, current.step)
    : { attempt: 1, totalCalls: 1 };

  const flowCall = useCallback(() => {
    if (!current) return;
    setScore((s) => ({ ...s, calls: s.calls + 1 }));
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
  const openThread = useCallback((leadId: string) => {
    setActiveThreadLead(leadId);
    setActiveLeadId(leadId);
    setMessages((prev) => prev.map((m) => (m.leadId === leadId ? { ...m, isRead: true } : m)));
    if (enabled) markThreadRead(leadId);
  }, [enabled]);

  const sendReply = useCallback((leadId: string, body: string) => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    const thread = messages.filter((m) => m.leadId === leadId);
    const channel = (thread.length ? thread[thread.length - 1].channel : 'text') as 'text' | 'email';
    setMessages((prev) => [...prev, { id: uid(), leadId, who: 'You', salon: lead?.salon || '', channel, direction: 'out', body, time: 'now', isRead: true }]);
    addActivity(leadId, { kind: channel, direction: 'out', ty: `${channel === 'email' ? 'Email' : 'Text'} reply sent`, time: 'Just now', body: `"${body}"` });
    const lid = enabled ? leadId : undefined;
    if (channel === 'text' && lead?.phone) fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: lead.phone, body, leadId: lid }) }).catch(() => {});
    if (channel === 'email' && lead?.email) fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: lead.email, subject: 'Re: Relay', body, leadId: lid }) }).catch(() => {});
  }, [messages, addActivity, enabled]);

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
    setScore((s) => ({ ...s, [channel]: (s as any)[channel] + 1 }));
    addActivity(current.leadId, {
      kind: channel, direction: 'out',
      ty: channel === 'text' ? 'Text sent · ⚡Flow' : 'Email sent · ⚡Flow',
      time: 'Just now', body: subject ? `${subject} — ${body}` : body,
    });
    // Best-effort real send (endpoints 503 when the provider isn't configured → ignored).
    const lid = enabled ? current.leadId : undefined;
    if (channel === 'text' && lead?.phone) {
      fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: lead.phone, body, leadId: lid }) }).catch(() => {});
    }
    if (channel === 'email' && lead?.email) {
      fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: lead.email, subject, body, leadId: lid }) }).catch(() => {});
    }
    setFlow((f) => ({ ...f, actionCount: f.actionCount + 1 }));
    advance('onward');
  }, [current, addActivity, advance, leadById, enabled]);

  const startNote = useCallback((activityId: string, aiText: string, adv: 'onward' | 'next_salon') => {
    setFlow((f) => ({ ...f, phase: 'note', pendingAdvance: adv, noteActivityId: activityId, noteAiText: aiText }));
  }, []);

  const flowDispo = useCallback((d: Disposition) => {
    if (!current) return;
    const lead = leadById(current.leadId)!;
    if (d === 'wrong_number') {
      addActivity(current.leadId, { kind: 'call', direction: 'out', ty: 'Call — wrong/dead number · ⚡Flow', time: 'Just now', body: AI_NOTE.wrong_number });
      setStage(current.leadId, 'cold');
      advance('next_salon');
      return;
    }
    if (d === 'connected') { setFlow((f) => ({ ...f, phase: 'connected' })); return; }
    const ai = d === 'voicemail' ? AI_NOTE.voicemail : AI_NOTE.no_answer;
    const id = addActivity(current.leadId, {
      kind: 'call', direction: 'out', disposition: d, ai: true,
      ty: d === 'voicemail' ? 'Call — left voicemail · ⚡Flow' : 'Call — no answer · ⚡Flow',
      time: 'Just now', aiNote: ai, body: ai,
    });
    if (d === 'voicemail') startNote(id, ai, 'onward');
    else advance('onward');
  }, [current, leadById, addActivity, setStage, advance, startNote]);

  const flowConnected = useCallback((kind: 'booked' | 'callback' | 'quote' | 'not_interested') => {
    if (!current) return;
    const label = { booked: 'Demo booked', callback: 'Callback scheduled', quote: 'Quote sent', not_interested: 'Not interested' }[kind];
    const ai = AI_NOTE[kind] || '';
    if (kind === 'booked') setScore((s) => ({ ...s, demos: s.demos + 1 }));
    setStage(current.leadId, kind === 'not_interested' ? 'cold' : kind === 'callback' ? 'working' : 'hot');
    const id = addActivity(current.leadId, {
      kind: kind === 'booked' ? 'book' : kind === 'quote' ? 'email' : 'call',
      direction: 'out', disposition: kind, ai: true,
      ty: `${label} · ⚡Flow`, time: 'Just now', aiNote: ai, body: ai,
    });
    startNote(id, ai, 'next_salon');
  }, [current, addActivity, setStage, startNote]);

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
    setScore((s) => ({ ...s, [kind === 'call' ? 'calls' : 'texts']: (s as any)[kind === 'call' ? 'calls' : 'texts'] + 1 }));
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
    fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: number, body, leadId: enabled ? lead?.id : undefined }) }).catch(() => {});
    logDial('text', number, body);
  }, [matchLeadByNumber, logDial, enabled]);

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
    view, setView, leads, activities, score, activeLeadId, setActiveLeadId, leadById,
    flow, current, currentLead, currentChannel, attemptInfo, enabled, importLeads,
    me, reps, signOut,
    startFlow, exitFlow, endCall, flowCall, flowSend, flowDispo, flowConnected, saveNote, skipNote, flowSkip,
    addActivity, setStage,
    messages, activeThreadLead, unreadCount, openThread, sendReply,
    activeCall, inbound, ringInbound, simInbound, answerInbound, declineInbound,
    cadences, cadenceById, newCadence, saveCadence, removeCadence, assignCadence,
    recentDials, matchLeadByNumber, logDial, sendKeypadText, saveNumberAsLead,
  };
}
