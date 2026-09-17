'use client';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Lead, Activity, Channel, Disposition, DispositionKey, CadenceStep, Stage, Message, Rep, Cadence } from '@/lib/types';
import { SEED_LEADS, SEED_ACTIVITIES, SEED_MESSAGES } from '@/lib/seedData';
import { planForStage, callAttempt, AI_NOTE, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, branchFor, DISPO_LABEL, INSTAGRAM_CADENCE_ID, IG_SMS, IG_DM, IG_EMAIL_BODY, IG_EMAIL_SUBJECT, resolveChannel, dmOpen } from '@/lib/cadence';
import { authHeaders, setLeadCallback, repoEnabled, fetchLeads, fetchActivities, fetchTodayStats, fetchCadenceProgress, updateCadencePos, insertActivity, updateStage, attachLatestOwnNote, bulkInsertLeads, fetchMessages, markThreadRead, markMessagesRead, subscribeMessages, subscribeActivities, fetchMe, fetchReps, signOut as repoSignOut, fetchCadences, createCadence, renameCadence, deleteCadence, saveCadenceSteps, assignLeadCadence, createLeadQuick, createLead, setLeadNextAction, deployStagedLeads, importInstagramLeads, updateLeadEnrichment, updateLeadFields, markCadenceComplete, bulkAssignCadence, deleteLead as deleteLeadRepo, fetchRepLeadCounts, updateRep as updateRepRepo, assignOwnerMany as assignOwnerManyRepo, setAgentOwnerMany as setAgentOwnerManyRepo, fetchTemplateOverrides, saveTemplateOverride, deleteTemplateOverride, inviteRep as inviteRepRepo, resetRepPassword as resetRepPasswordRepo, sendPasswordResetEmail } from '@/lib/repo';
import type { ImportRow } from '@/lib/repo';
import { TEXT_TEMPLATES, EMAIL_TEMPLATES_LIB, PRODUCT_TEMPLATES, withOverrides, type TplOverrides, type TplKind } from '@/lib/templates';
import { mapToImportRows } from '@/lib/csv';

export type View = 'leads' | 'staging' | 'enrich' | 'dialer' | 'keypad' | 'inbox' | 'cadences' | 'reports' | 'mobile' | 'team' | 'agent' | 'templates';

// Eryn's screen: what /api/agent-shift returns.
export interface AgentStatus { shift: any | null; live: any | null; today: { dials: number; answered: number; voicemail: number; noAnswer: number; interested: number }; queue: number; recent: any[] }
export interface EnrichCandidate { placeId: string; name: string; phone?: string; website?: string; address?: string; city?: string; score: number }
export interface EnrichResult { found: boolean; sure?: boolean; placeId?: string; candidates?: EnrichCandidate[]; websiteSource?: 'places' | 'instagram' | 'guess' | 'search'; name?: string; phone?: string; email?: string; website?: string; bookingSystem?: string; city?: string; address?: string; hours?: string[]; error?: string }

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
  {
    id: INSTAGRAM_CADENCE_ID,
    name: 'Instagram \u2014 warm demo',
    steps: [
      { position: 0, channel: 'dm', waitMinutes: 0, template: IG_DM },
      { position: 1, channel: 'call', waitMinutes: 120 },
      { position: 2, channel: 'text', waitMinutes: 1440, template: IG_SMS },
      { position: 3, channel: 'email', waitMinutes: 1440, template: IG_EMAIL_BODY, subject: IG_EMAIL_SUBJECT },
      { position: 4, channel: 'call', waitMinutes: 1440 },
    ],
  },
];
export interface RecentDial { id: string; number: string; kind: 'call' | 'text'; body?: string; time: string; leadId?: string; salon?: string }
export type FlowPhase = 'action' | 'incall' | 'dispo' | 'connected' | 'callback' | 'note';
// What the share sheet / a pasted link handed us (Add-to-Relay from Instagram or TikTok).
export interface ShareIntent { platform: 'instagram' | 'tiktok' | null; handle: string; text: string; url: string }
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
  notice: string | null; // transient "salon done → next" nudge
  done: boolean;         // whole due list worked for the day
}
interface ActiveCall { leadId: string; direction: 'out' | 'in'; viaFlow: boolean; incomingCall?: any; bridge?: boolean }

// A real UUID so an optimistic activity and its Supabase row can share one id —
// that's what lets the realtime echo (and the recording's later UPDATE) merge
// into the row we already show instead of prepending a duplicate.
const uid = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
  ? (crypto as any).randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const last10 = (p?: string) => (p || '').replace(/\D/g, '').slice(-10);

const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Advance `n` business days (Mon–Fri), landing at the start of that day. Used to
// space cadence steps out by their day gap while skipping weekends.
function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  let added = 0;
  while (added < Math.max(1, n)) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) added++; }
  return d;
}
const fmtDueLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const isOverdue = (l: Lead) => !!l.nextActionAt && new Date(l.nextActionAt).getTime() < startOfToday();
// A lead is "due" if it's deployed into a cadence, still in rotation, and either
// never scheduled or its snooze has expired. Staged leads are never due.
const callbackDueToday = (l: Lead) => !!l.callbackAt && new Date(l.callbackAt).getTime() <= endOfToday();
const leadIsDue = (l: Lead) =>
  l.deployed !== false && l.stage !== 'won' && l.stage !== 'cold' && (callbackDueToday(l) || (!l.cadenceCompletedAt && (!l.nextActionAt || new Date(l.nextActionAt).getTime() <= endOfToday())));
// Ranking helpers for the daily queue: callbacks that are due right now first,
// then fresh social (DM'd/commented in the last 24h), then Instagram, then warm.
const callbackHot = (l: Lead) => !!l.callbackAt && new Date(l.callbackAt).getTime() <= Date.now() + 15 * 60_000;
const socialHot = (l: Lead) => !!l.lastSocialAt && Date.now() - new Date(l.lastSocialAt).getTime() < 24 * 3_600_000;
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
    pendingAdvance: null, noteActivityId: null, noteAiText: null, paused: false, notice: null, done: false,
  });
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  const [activeThreadLead, setActiveThreadLead] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [inbound, setInbound] = useState<{ leadId: string; call?: any } | null>(null);
  const [me, setMe] = useState<Rep | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [cadences, setCadences] = useState<Cadence[]>(SEED_CADENCES);
  const [recentDials, setRecentDials] = useState<RecentDial[]>([]);
  const [shareIntent, setShareIntent] = useState<ShareIntent | null>(null);
  const [pendingCallLead, setPendingCallLead] = useState<string | null>(null); // from a reminder tap (?lead=&call=1)
  const leadsRef = useRef<Lead[]>(leads);
  leadsRef.current = leads;
  const cadencesRef = useRef<Cadence[]>(cadences);
  cadencesRef.current = cadences;
  const activitiesRef = useRef<Record<string, Activity[]>>(activities);
  activitiesRef.current = activities;

  // "Warm" leads: someone who clicked a tracked link, or opened an outbound
  // email 2+ times. These float to the top of the daily queue. Clicks count
  // more than opens because pixel opens are noisy (Apple Mail / Gmail proxying).
  const warmLeadIds = useMemo(() => {
    const s = new Set<string>();
    for (const m of messages) {
      if (m.leadId && m.direction === 'out' && m.channel === 'email' &&
          ((m.clickCount || 0) > 0 || (m.openCount || 0) >= 2)) s.add(m.leadId);
    }
    return s;
  }, [messages]);
  const warmRef = useRef<Set<string>>(warmLeadIds);
  warmRef.current = warmLeadIds;
  const meRef = useRef<Rep | null>(me);
  meRef.current = me;

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

  // Deep links: a reminder push opens /?lead=<id>&call=1 (jump to that lead with
  // Call primed); the PWA share target opens /?text=…&url=… from Instagram or
  // TikTok (Add-to-Relay prefilled). Both are one-shot and scrubbed from the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const leadId = q.get('lead');
    const text = q.get('text') || '';
    const url = q.get('url') || '';
    const title = q.get('title') || '';
    if (!leadId && !text && !url && !title) return;
    if (leadId) {
      setActiveLeadId(leadId); setView('dialer');
      if (q.get('call') === '1') setPendingCallLead(leadId);
    } else {
      const blob = [url, text, title].join(' ');
      const m = blob.match(/instagram\.com\/(?!(?:p|reel|reels|explore|stories|accounts)\/)([A-Za-z0-9._]{1,30})/i) || blob.match(/tiktok\.com\/@([A-Za-z0-9._]{1,30})/i) || blob.match(/(?:^|\s)@([A-Za-z0-9._]{2,30})/);
      const platform = /tiktok\.com/i.test(blob) ? 'tiktok' : (/instagram\.com/i.test(blob) || m ? 'instagram' : null);
      setShareIntent({ platform, handle: m ? m[1] : '', text: text || title, url });
    }
    try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ }
  }, []);
  const clearShareIntent = useCallback(() => setShareIntent(null), []);
  const clearPendingCall = useCallback(() => setPendingCallLead(null), []);

  // Pull Gmail replies into the Inbox whenever it's opened (no-op unless Gmail is
  // configured). New inbound rows arrive via the realtime messages subscription.
  useEffect(() => {
    if (!enabled || view !== 'inbox') return;
    fetch('/api/email/sync', { method: 'POST' }).catch(() => {});
  }, [enabled, view]);

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
        if (i < 0) return { ...prev, [activeLeadId]: [a, ...list] };
        // We already have this row (our own optimistic copy, or an earlier
        // version). Keep the friendly optimistic display, but pull in anything
        // the server added — most importantly the recording, transcript, and the
        // real AI summary that the /api/voice/recording webhook attaches later.
        const next = list.map((x) => (x.id === a.id ? {
          ...a, ...x,
          recordingUrl: a.recordingUrl ?? x.recordingUrl,
          transcript: a.transcript ?? x.transcript,
          durationS: a.durationS ?? x.durationS,
          aiNote: a.aiNote ?? x.aiNote,
          disposition: x.disposition ?? a.disposition,
          ai: !!(a.ai || x.ai),
        } : x));
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
        id, // share the id so the realtime echo merges instead of duplicating
        kind: a.kind, direction: a.direction, disposition: a.disposition,
        aiNote: a.aiNote, ownNote: a.ownNote, body: a.body,
        repId: meRef.current?.id, // stamp who did it for the Team/Reports views
      });
    }
    return id;
  }, [enabled]);

  const setStage = useCallback((leadId: string, stage: Stage) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, stage } : l)));
    if (enabled) updateStage(leadId, stage);
  }, [enabled]);

  // Pull a salon out of the cadence (not interested). Marks it Cold so it drops
  // out of the flow + due list, logs a note, and if we're on it in a live flow,
  // moves to the next salon.
  const removeFromCadence = useCallback((leadId: string) => {
    setStage(leadId, 'cold');
    addActivity(leadId, { kind: 'note', ty: 'Removed from cadence', time: 'Just now', body: 'Not interested — removed from the cadence.' });
    setFlow((f) => {
      if (f.on && f.queue[f.pos]?.leadId === leadId) {
        const pos = f.pos + 1;
        const nextItem = f.queue[pos];
        if (nextItem) { setActiveLeadId(nextItem.leadId); return { ...f, pos, phase: 'action', pendingAdvance: null }; }
        // That was the last salon of the day → show the day-cleared screen
        // instead of leaving the flow stranded past the end of the queue.
        return { ...f, pos, phase: 'action', pendingAdvance: null, done: true };
      }
      return f;
    });
  }, [setStage, addActivity]);

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

  // Instagram demo-requesters: reachable rows (phone/email) deploy onto the warm
  // cadence; no-contact rows stay in staging, flagged for enrichment.
  const importInstagramRows = useCallback(async (rows: ImportRow[], ownerRepId?: string): Promise<{ deployed: number; staged: number; total: number }> => {
    if (!rows.length) return { deployed: 0, staged: 0, total: 0 };
    if (enabled) {
      const res = await importInstagramLeads(rows, ownerRepId);
      const fresh = await fetchLeads();
      setLeads(fresh);
      return res;
    }
    const emailOk = (e?: string) => !!(e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()));
    let deployed = 0;
    setLeads((prev) => [
      ...prev,
      ...rows.map((r, i) => {
        const dialable = !!((r.phone || '').trim() || emailOk(r.email));
        if (dialable) deployed++;
        return {
          id: 'ig' + Date.now() + i, salon: r.salon, city: r.city || '', phone: r.phone || '',
          email: r.email, source: 'instagram', handle: r.handle, notes: r.notes, bookingSystem: r.bookingSystem,
          stage: (dialable ? 'working' : 'new') as Stage,
          cadenceId: INSTAGRAM_CADENCE_ID, cadencePos: 0, deployed: dialable,
          objection: 'Instagram', lastTouch: 'New',
          contact: { id: 'c' + i, name: r.contactName || r.handle || '\u2014', role: 'Owner', phone: r.phone },
        };
      }),
    ]);
    return { deployed, staged: rows.length - deployed, total: rows.length };
  }, [enabled]);

  // ── Flow control ───────────────────────────────────────────────────────────
  // Which book the queue + pipeline show: your own ('mine'), one rep's (their
  // id), or the whole team ('all'). Admins can toggle it from the top bar; reps
  // always work their own book (RLS scopes their data to that anyway). A book is
  // the rep's assigned leads plus the unassigned pool.
  const [book, setBook] = useState<'mine' | 'all' | string>('mine');
  const bookRef = useRef(book);
  bookRef.current = book;
  const bookMatch = useCallback((l: Lead) => {
    const bf = bookRef.current;
    if (bf === 'all') return true;
    const id = bf === 'mine' ? meRef.current?.id : bf;
    return !l.ownerRepId || l.ownerRepId === id;
  }, []);

  // Build the session queue from the current book.
  const startFlow = useCallback(async (onlyIds?: string[]) => {
    const idSet = onlyIds ? new Set(onlyIds) : null;
    // Today's worklist = only salons with something DUE (or overdue). Skips
    // staged, won, removed (cold), completed, anything scheduled for a future
    // day, and anything outside the current book. Most-overdue first.
    const worklist = leadsRef.current
      .filter((l) => leadIsDue(l) && bookMatch(l))
      .filter((l) => !idSet || idSet.has(l.id))
      .sort((a, b) => {
        // Callbacks due now, then fresh social, then Instagram, then warm, then most-overdue.
        const ca = callbackHot(a) ? 0 : 1; const cb = callbackHot(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        const sa = socialHot(a) ? 0 : 1; const sb = socialHot(b) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const ia = a.source === 'instagram' ? 0 : 1;
        const ib = b.source === 'instagram' ? 0 : 1;
        if (ia !== ib) return ia - ib;
        const wa = warmRef.current.has(a.id) ? 0 : 1;
        const wb = warmRef.current.has(b.id) ? 0 : 1;
        if (wa !== wb) return wa - wb;
        return (a.nextActionAt ? new Date(a.nextActionAt).getTime() : startOfToday()) - (b.nextActionAt ? new Date(b.nextActionAt).getTime() : startOfToday());
      });
    if (!worklist.length) {
      // Nothing due — show the "all caught up" screen instead of a stale queue.
      setFlow((f) => ({ ...f, on: true, done: true, queue: [], pos: 0, phase: 'action', notice: null }));
      setView('dialer');
      return;
    }

    // How far each salon already is in its cadence, from real logged touches, so
    // the flow resumes instead of restarting at attempt 1. Real mode queries the
    // DB; demo mode counts the activities already in memory.
    let progress: Record<string, number> = {};
    if (enabled) {
      progress = await fetchCadenceProgress(worklist.map((l) => l.id));
    } else {
      for (const l of worklist) {
        progress[l.id] = (activitiesRef.current[l.id] || []).filter(
          (a) => (a.kind === 'call' || a.kind === 'book' || a.kind === 'text' || a.kind === 'email') && a.direction !== 'in'
        ).length;
      }
    }

    const resumeStep: Record<string, number> = {};
    const queue: QueueItem[] = worklist.map((l) => {
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
    setFlow({ on: true, queue, pos: 0, phase: 'action', actionCount: 0, pendingAdvance: null, noteActivityId: null, noteAiText: null, paused: false, notice: null, done: false });
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
      let notice: string | null = null;
      if (kind === 'onward') {
        const step = item.step + 1;
        if (step < item.plan.length) {
          // Day gap sits BEFORE the next step: 0 = same-day (keep working this
          // salon now); >0 = this salon's work for today is done — schedule the
          // next touch that many business days out and move on.
          const gapDays = Math.round((item.steps[step]?.waitMinutes || 0) / 1440);
          if (gapDays <= 0) {
            const q = f.queue.slice();
            q[f.pos] = { ...item, step };
            setActiveLeadId(item.leadId);
            setLeads((prev) => prev.map((l) => (l.id === item.leadId ? { ...l, cadencePos: step } : l)));
            if (enabled) updateCadencePos(item.leadId, step);
            return { ...f, queue: q, phase: 'action' };
          }
          const due = addBusinessDays(new Date(), gapDays);
          const dueIso = due.toISOString();
          const salon = leadsRef.current.find((l) => l.id === item.leadId)?.salon || 'Salon';
          setLeads((prev) => prev.map((l) => (l.id === item.leadId ? { ...l, cadencePos: step, nextActionAt: dueIso } : l)));
          if (enabled) { updateCadencePos(item.leadId, step); setLeadNextAction(item.leadId, dueIso); }
          notice = `✓ ${salon} — today's steps done. Next touch ${fmtDueLabel(due)}.`;
        } else {
          // Whole cadence finished → completion badge, then move on.
          const lead = leadsRef.current.find((l) => l.id === item.leadId);
          const cadName = cadencesRef.current.find((c) => c.id === lead?.cadenceId)?.name || 'Cadence';
          const iso = new Date().toISOString();
          setLeads((prev) => prev.map((l) => (l.id === item.leadId ? { ...l, cadenceCompletedAt: iso, cadenceCompletedName: cadName } : l)));
          if (enabled) markCadenceComplete(item.leadId, cadName, iso);
          notice = `✓ ${lead?.salon || 'Salon'} completed ${cadName}.`;
        }
      }
      const pos = f.pos + 1;
      const nextItem = f.queue[pos];
      if (nextItem) { setActiveLeadId(nextItem.leadId); return { ...f, pos, phase: 'action', pendingAdvance: null, notice }; }
      // No salons left → today's list is cleared.
      return { ...f, pos, phase: 'action', pendingAdvance: null, notice, done: true };
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
    setFlow((f) => ({ ...f, actionCount: f.actionCount + 1, phase: 'incall', notice: null }));
  }, [current]);

  // Manual click-to-call from a lead card's phone number: jump to that lead in
  // the dialer and open the call panel (which places the real call).
  // mode (optional) overrides this device's cell/computer default for one call.
  const startCall = useCallback((leadId: string, mode?: 'bridge' | 'app') => {
    setActiveLeadId(leadId);
    setView('dialer');
    setActiveCall({ leadId, direction: 'out', viaFlow: false, bridge: mode ? mode === 'bridge' : undefined });
  }, []);

  // Cell bridge: Relay rings MY cell, then dials her from the Relay number.
  // Returns the server's answer so the call panel can show "ringing your cell".
  const bridgeCall = useCallback(async (leadId: string): Promise<{ ok: boolean; error?: string; code?: string }> => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    if (!lead?.phone) return { ok: false, error: 'No phone on file for this lead.' };
    if (!meRef.current?.id) return { ok: false, error: 'Sign in to place calls.' };
    try {
      const res = await fetch('/api/voice/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ leadId, to: lead.phone }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: j.error || `Could not place the call (${res.status})`, code: j.code };
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, lastRepId: meRef.current?.id } : l)));
      return { ok: true };
    } catch { return { ok: false, error: 'Network error — the call was not placed.' }; }
  }, []);
  // Does Call ring my cell (bridge) or the in-app dialer? Bridge is the default
  // for anyone with a cell on file; the Team screen sets it per rep, and each
  // device can override it (laptop = this computer, phone = my cell) — kept in
  // localStorage so it's per browser and survives reloads.
  const [deviceCallMode, setDeviceCallModeState] = useState<'bridge' | 'app' | null>(null);
  useEffect(() => {
    try { const v = localStorage.getItem('relay.callMode'); if (v === 'bridge' || v === 'app') setDeviceCallModeState(v); } catch { /* storage blocked */ }
  }, []);
  const setDeviceCallMode = useCallback((m: 'bridge' | 'app') => {
    setDeviceCallModeState(m);
    try { localStorage.setItem('relay.callMode', m); } catch { /* storage blocked */ }
  }, []);
  const callMode: 'bridge' | 'app' = deviceCallMode || me?.callMode || 'bridge';
  const canBridge = !!me?.forwardTo;
  const useBridge = canBridge && callMode !== 'app';

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
      const res = await fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body, leadId, repId: meRef.current?.id }) });
      const j = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, messageId: j.messageId } : { ok: false, error: j.error || `Send failed (${res.status})` };
    } catch { return { ok: false, error: 'Network error — send did not go through.' }; }
  }, []);
  const sendDmApi = useCallback(async (leadId: string, body: string): Promise<{ ok: boolean; messageId?: string; error?: string; code?: string }> => {
    try {
      const res = await fetch('/api/social/dm/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId, body, repId: meRef.current?.id }) });
      const j = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, messageId: j.messageId } : { ok: false, error: j.error || `DM failed (${res.status})`, code: j.code };
    } catch { return { ok: false, error: 'Network error — DM did not go through.' }; }
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

  const sendReply = useCallback((leadId: string, body: string, force?: 'text' | 'email' | 'dm') => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    const thread = messages.filter((m) => m.leadId === leadId);
    let channel = (force || (thread.length ? thread[thread.length - 1].channel : 'text')) as 'text' | 'email' | 'dm';
    // A DM thread whose 24h window closed answers by text (or email) instead.
    if (channel === 'dm' && lead && !dmOpen(lead)) channel = lead.phone ? 'text' : 'email';
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead?.salon || '', channel, direction: 'out', body, time: 'now', isRead: true, pending: true, phone: lead?.phone }]);
    addActivity(leadId, { kind: channel === 'dm' ? 'text' : channel, direction: 'out', ty: `${channel === 'email' ? 'Email' : channel === 'dm' ? 'Instagram DM' : 'Text'} reply sent`, time: 'Just now', body: `"${body}"` });
    const lid = enabled ? leadId : undefined;
    (async () => {
      let r: { ok: boolean; messageId?: string; error?: string };
      if (channel === 'dm') r = enabled ? await sendDmApi(leadId, body) : { ok: true };
      else if (channel === 'text') r = lead?.phone ? await sendSms(lead.phone, body, lid) : { ok: false, error: 'No phone on file for this lead.' };
      else r = lead?.email ? await sendEmailApi(lead.email, 'Re: Relay', body, lid) : { ok: false, error: 'No email on file for this lead.' };
      reconcileSent(tempId, r);
    })();
  }, [messages, addActivity, enabled, sendSms, sendDmApi, sendEmailApi, reconcileSent]);

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
      if (m.channel === 'dm') r = m.leadId ? await sendDmApi(m.leadId, m.body) : { ok: false, error: 'No lead.' };
      else if (m.channel === 'text') r = lead?.phone ? await sendSms(lead.phone, m.body, lid) : { ok: false, error: 'No phone on file.' };
      else r = lead?.email ? await sendEmailApi(lead.email, m.subject, m.body, lid) : { ok: false, error: 'No email on file.' };
      reconcileSent(messageId, r);
    })();
  }, [messages, enabled, sendSms, sendDmApi, sendEmailApi, reconcileSent]);

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

  const flowSend = useCallback((channelIn: 'text' | 'email' | 'dm', body: string, subject?: string) => {
    if (!current) return;
    const lead = leadById(current.leadId);
    const leadId = current.leadId;
    // A DM step silently becomes a text when her Instagram window is closed.
    const channel = (lead ? resolveChannel(channelIn, lead) : channelIn) as 'text' | 'email' | 'dm';
    if (channel === 'dm' && lead && !dmOpen(lead)) {
      // Window closed and nothing to fall back to — skip the step, say why, move on.
      addActivity(leadId, { kind: 'note', ty: 'DM step skipped · ⚡Flow', time: 'Just now', body: 'Her Instagram window is closed and there is no phone or email on file.' });
      setFlow((f) => ({ ...f, notice: null }));
      advance('onward');
      return;
    }
    setStats((s) => (channel === 'email' ? { ...s, emails: s.emails + 1 } : { ...s, texts: s.texts + 1 }));
    addActivity(leadId, {
      kind: channel === 'dm' ? 'text' : channel, direction: 'out',
      ty: channel === 'text' ? 'Text sent · ⚡Flow' : channel === 'dm' ? 'Instagram DM sent · ⚡Flow' : 'Email sent · ⚡Flow',
      time: 'Just now', body: subject ? `${subject} — ${body}` : body,
    });
    // Optimistically thread it into the Inbox, then reconcile on the provider reply.
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead?.salon || '', channel, direction: 'out', subject, body, time: 'now', isRead: true, pending: true, phone: lead?.phone }]);
    const lid = enabled ? leadId : undefined;
    (async () => {
      let r: { ok: boolean; messageId?: string; error?: string };
      if (channel === 'dm') r = enabled ? await sendDmApi(leadId, body) : { ok: true };
      else if (channel === 'text') r = lead?.phone ? await sendSms(lead.phone, body, lid) : { ok: false, error: 'No phone on file for this lead.' };
      else r = lead?.email ? await sendEmailApi(lead.email, subject, body, lid) : { ok: false, error: 'No email on file for this lead.' };
      reconcileSent(tempId, r);
    })();
    setFlow((f) => ({ ...f, actionCount: f.actionCount + 1, notice: null }));
    advance('onward');
  }, [current, addActivity, advance, leadById, enabled, sendSms, sendDmApi, sendEmailApi, reconcileSent]);

  // One-off Instagram DM from the lead card. Threads into the Inbox + logs it.
  const sendLeadDm = useCallback(async (leadId: string, body: string): Promise<{ ok: boolean; error?: string; code?: string }> => {
    const lead = leadById(leadId);
    if (!lead) return { ok: false, error: 'Lead not found.' };
    if (!dmOpen(lead)) return { ok: false, error: lead.igUserId ? 'Her 24-hour DM window is closed — text her instead.' : 'No Instagram conversation yet — she has to DM or comment first.', code: 'window_closed' };
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead.salon || '', channel: 'dm', direction: 'out', body, time: 'now', isRead: true, pending: true, phone: lead.phone }]);
    const res = enabled ? await sendDmApi(leadId, body) : { ok: true };
    reconcileSent(tempId, res);
    if (res.ok) {
      setStats((s) => ({ ...s, texts: s.texts + 1 }));
      addActivity(leadId, { kind: 'text', direction: 'out', ty: 'Instagram DM sent', time: 'Just now', body: `"${body}"` });
    }
    return res;
  }, [leadById, enabled, sendDmApi, reconcileSent, addActivity]);

  // Send a one-off email to a lead from the salon card (via Gmail). Threads it
  // into the Inbox + logs it, and only counts/logs on a successful send.
  const sendLeadEmail = useCallback(async (leadId: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }> => {
    const lead = leadById(leadId);
    if (!lead?.email) return { ok: false, error: 'No email on file for this lead.' };
    const tempId = uid();
    setMessages((prev) => [...prev, { id: tempId, leadId, who: 'You', salon: lead.salon || '', channel: 'email', direction: 'out', subject, body, time: 'now', isRead: true, pending: true, phone: lead.phone }]);
    const res = await sendEmailApi(lead.email, subject, body, enabled ? leadId : undefined);
    reconcileSent(tempId, res);
    if (res.ok) {
      setStats((s) => ({ ...s, emails: s.emails + 1 }));
      addActivity(leadId, { kind: 'email', direction: 'out', ty: 'Email sent', time: 'Just now', body: subject ? `${subject} — ${body}` : body });
    }
    return res;
  }, [leadById, enabled, sendEmailApi, reconcileSent, addActivity]);

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
      // Business days (M–F), matching the rest of the scheduler — a Friday
      // "snooze 2 days" lands Tuesday, not Sunday.
      const iso = addBusinessDays(new Date(), action.days).toISOString();
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
    if (kind === 'callback') { setFlow((f) => ({ ...f, phase: 'callback' })); return; } // pick a time first
    applyDispo(kind);
  }, [applyDispo]);

  // A promised callback = a real reminder. Stores the time on the lead (the
  // minute tick pushes the rep 5 min before), then runs the normal "callback"
  // branch. Outside Flow (the lead card) it just sets/clears the reminder.
  const setCallback = useCallback((leadId: string, iso: string | null, note?: string) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, callbackAt: iso || undefined, callbackNote: iso ? note : undefined } : l)));
    if (enabled) setLeadCallback(leadId, iso, note);
    if (iso) {
      const when = new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      addActivity(leadId, { kind: 'note', ty: `Callback set · ${when}`, time: 'Just now', body: note ? `Reminder: ${note}` : 'Reminder set — Relay pushes your phone 5 min before.' });
    }
  }, [enabled, addActivity]);
  const confirmFlowCallback = useCallback((iso: string, note?: string) => {
    if (!current) return;
    setCallback(current.leadId, iso, note);
    applyDispo('callback');
  }, [current, setCallback, applyDispo]);
  const cancelFlowCallback = useCallback(() => setFlow((f) => ({ ...f, phase: 'connected' })), []);
  const callbackLeads = useMemo(() => leads.filter((l) => !!l.callbackAt && l.stage !== 'won' && bookMatch(l)).sort((a, b) => new Date(a.callbackAt!).getTime() - new Date(b.callbackAt!).getTime()), [leads, bookMatch]);

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
      const item = { ...f.queue[idx] }; // keep its resume step — don't restart the cadence at attempt 1
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
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, cadenceId, cadencePos: 0, cadenceCompletedAt: undefined, cadenceCompletedName: undefined } : l)));
    if (enabled) assignLeadCadence(leadId, cadenceId);
  }, [enabled]);

  // Move many leads onto a cadence at once — fresh at day 0, due now, badge cleared.
  const assignCadenceMany = useCallback((ids: string[], cadenceId: string) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setLeads((prev) => prev.map((l) => (idSet.has(l.id)
      ? { ...l, cadenceId, cadencePos: 0, cadenceCompletedAt: undefined, cadenceCompletedName: undefined, nextActionAt: undefined }
      : l)));
    if (enabled) bulkAssignCadence(ids, cadenceId);
  }, [enabled]);

  // Move EVERY lead currently on one cadence over to another (staged included).
  // Returns how many moved.
  const moveCadenceLeads = useCallback((fromCadenceId: string, toCadenceId: string): number => {
    const ids = leadsRef.current.filter((l) => l.cadenceId === fromCadenceId).map((l) => l.id);
    if (ids.length) assignCadenceMany(ids, toCadenceId);
    return ids.length;
  }, [assignCadenceMany]);

  // ── Team (admin) ─────────────────────────────────────────────────────────────
  const isAdmin = enabled ? me?.role === 'admin' : true; // demo mode shows everything
  const [repLeadCounts, setRepLeadCounts] = useState<Record<string, number>>({});

  // Refresh the roster + owned-lead counts for the Team screen.
  const loadTeam = useCallback(async () => {
    if (!enabled) return;
    const [rs, counts] = await Promise.all([fetchReps(), fetchRepLeadCounts()]);
    setReps(rs);
    setRepLeadCounts(counts);
  }, [enabled]);

  // Create a new SDR login; returns a set-password link to hand them.
  const inviteRep = useCallback(async (email: string, name: string, phoneNumber?: string) => {
    if (!enabled) return { ok: false, error: 'Connect Supabase to add users.' };
    const r = await inviteRepRepo(email, name, phoneNumber);
    if (r.ok) await loadTeam();
    return r;
  }, [enabled, loadTeam]);

  // Generate a fresh set-password link for an existing rep.
  const resetRepPassword = useCallback(async (email: string) => {
    if (!enabled) return { ok: false, error: 'Connect Supabase first.' };
    return resetRepPasswordRepo(email);
  }, [enabled]);

  // Email a set/reset-password link straight to the user (Supabase sends it).
  const emailPasswordReset = useCallback(async (email: string) => {
    if (!enabled) return { ok: false, error: 'Connect Supabase first.' };
    return sendPasswordResetEmail(email);
  }, [enabled]);

  // Edit a rep (number, role, active, name) with optimistic local update.
  const updateRep = useCallback((repId: string, patch: { name?: string; role?: 'admin' | 'rep'; phoneNumber?: string; active?: boolean; forwardTo?: string; callMode?: 'bridge' | 'app'; signName?: string }) => {
    setReps((prev) => prev.map((rp) => (rp.id === repId ? { ...rp, ...patch } : rp)));
    setMe((m) => (m && m.id === repId ? { ...m, ...patch } : m));
    if (enabled) updateRepRepo(repId, patch);
  }, [enabled]);

  // Assign many leads to a rep (or null to unassign), optimistic.
  // ── Editable templates ───────────────────────────────────────────────────────
  const [tplOverrides, setTplOverrides] = useState<TplOverrides>({});
  useEffect(() => { if (enabled) fetchTemplateOverrides().then(setTplOverrides); }, [enabled]);
  const textTemplates = useMemo(() => withOverrides(TEXT_TEMPLATES, 'text', tplOverrides), [tplOverrides]);
  const emailTemplates = useMemo(() => withOverrides(EMAIL_TEMPLATES_LIB, 'email', tplOverrides), [tplOverrides]);
  const productTemplates = useMemo(() => withOverrides(PRODUCT_TEMPLATES, 'product', tplOverrides), [tplOverrides]);
  const saveTemplate = useCallback(async (kind: TplKind, key: string, patch: { subject?: string | null; body: string }) => {
    const k = `${kind}:${key}`;
    setTplOverrides((o) => ({ ...o, [k]: { ...patch, updatedAt: new Date().toISOString() } }));
    if (!enabled) return null;
    return saveTemplateOverride(k, kind, patch, meRef.current?.id);
  }, [enabled]);
  const resetTemplate = useCallback(async (kind: TplKind, key: string) => {
    const k = `${kind}:${key}`;
    setTplOverrides((o) => { const n = { ...o }; delete n[k]; return n; });
    if (!enabled) return null;
    return deleteTemplateOverride(k);
  }, [enabled]);

  // ── Eryn (AI cold caller) ────────────────────────────────────────────────────
  const setAgentOwnerMany = useCallback((ids: string[], owner: 'rep' | 'agent') => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setLeads((prev) => prev.map((l) => (idSet.has(l.id) ? { ...l, owner } : l)));
    if (enabled) setAgentOwnerManyRepo(ids, owner);
  }, [enabled]);

  const DEMO_AGENT: AgentStatus = {
    shift: { id: 'demo', status: 'running', cap: 60, dials: 12, answered: 3, started_at: new Date(Date.now() - 50 * 60000).toISOString() },
    live: { id: 'demo-live', status: 'in_progress', started_at: new Date(Date.now() - 70000).toISOString(), leads: { salon: 'Lush & Co', city: 'Lehi, UT' }, to_number: '+13855550142' },
    today: { dials: 12, answered: 3, voicemail: 6, noAnswer: 3, interested: 1 },
    queue: 38,
    recent: [
      { id: 'd1', status: 'ended', outcome: 'gatekeeper', duration_s: 108, ended_at: new Date(Date.now() - 9 * 60000).toISOString(), leads: { salon: 'Studio Hue', city: 'Draper, UT' }, summary: 'Spoke with Bri (front desk). Owner is Marisa, in with clients till 3. Mornings are better. Hair-only, on Vagaro.', data: { owner_name: 'Marisa' }, transcript: [{ role: 'user', message: 'Studio Hue, this is Bri.' }, { role: 'agent', message: 'Hi Bri — this is Eryn, an AI assistant calling for Tally. Is the owner around, or is this a bad time?' }, { role: 'user', message: "She's with a client. What's this about?" }] },
      { id: 'd2', status: 'ended', outcome: 'voicemail', duration_s: 22, ended_at: new Date(Date.now() - 14 * 60000).toISOString(), leads: { salon: 'Rooted Suites', city: 'Provo, UT' }, summary: 'Voicemail. Left the short message; text sent.' },
      { id: 'd3', status: 'ended', outcome: 'answered_interested', duration_s: 171, ended_at: new Date(Date.now() - 31 * 60000).toISOString(), leads: { salon: 'Ember & Ash Hair Co', city: 'Wellington, FL' }, summary: 'Jenna (owner). Open 10–6, misses calls after 5. Interested in Night Desk; asked to be put on with Seth — transferred.', data: { owner_name: 'Jenna', hours: '10-6, closed Sunday' } },
      { id: 'd4', status: 'ended', outcome: 'no_answer', duration_s: 0, ended_at: new Date(Date.now() - 40 * 60000).toISOString(), leads: { salon: 'Glass Door Salon', city: 'Orem, UT' } },
    ],
  };
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentError, setAgentError] = useState('');
  const refreshAgent = useCallback(async () => {
    if (!enabled) { setAgentStatus(DEMO_AGENT); return; }
    try {
      const res = await fetch('/api/agent-shift', { headers: { ...(await authHeaders()) } });
      if (!res.ok) { setAgentError((await res.json().catch(() => ({})))?.error || `Error ${res.status}`); return; }
      setAgentStatus(await res.json()); setAgentError('');
    } catch (e: any) { setAgentError(e?.message || 'Network error'); }
  }, [enabled]);
  // Poll while the Eryn screen is open, or a call is live anywhere.
  useEffect(() => {
    const busy = agentStatus?.live && ['queued', 'ringing', 'in_progress'].includes(agentStatus.live.status);
    if (view !== 'agent' && !busy) return;
    refreshAgent();
    const t = setInterval(refreshAgent, view === 'agent' ? 5000 : 10000);
    return () => clearInterval(t);
  }, [view, refreshAgent, agentStatus?.live?.status]);

  const agentShift = useCallback(async (action: 'start' | 'pause' | 'resume' | 'stop', cap?: number) => {
    if (!enabled) {
      setAgentStatus((s) => s ? { ...s, shift: action === 'stop' ? null : { ...(s.shift || { id: 'demo', dials: 0, answered: 0 }), status: action === 'pause' ? 'paused' : 'running', cap: cap || s.shift?.cap || 60 } } : s);
      return { ok: true };
    }
    const res = await fetch('/api/agent-shift', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ action, cap }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setAgentError(j?.error || `Error ${res.status}`);
    await refreshAgent();
    return res.ok ? { ok: true } : { ok: false, error: j?.error };
  }, [enabled, refreshAgent]);

  // Eryn dials one lead now. Returns the reason when Relay's rules say no.
  const agentCall = useCallback(async (leadId: string, force?: boolean): Promise<{ ok: boolean; error?: string; reason?: string }> => {
    if (!enabled) {
      const l = leadsRef.current.find((x) => x.id === leadId);
      setAgentStatus((s) => ({ ...(s || DEMO_AGENT), live: { id: 'demo-live', status: 'ringing', started_at: new Date().toISOString(), leads: { salon: l?.salon, city: l?.city }, to_number: l?.phone } }));
      return { ok: true };
    }
    const res = await fetch('/api/agent-call', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ leadId, force: !!force }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j?.reason === 'mobile') setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, owner: 'rep', lineType: 'mobile' } : l)));
      return { ok: false, error: j?.error || `Error ${res.status}`, reason: j?.reason };
    }
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, agentAttempts: (l.agentAttempts || 0) + 1 } : l)));
    refreshAgent();
    return { ok: true };
  }, [enabled, refreshAgent]);

  const assignOwnerMany = useCallback((ids: string[], ownerRepId: string | null) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setLeads((prev) => prev.map((l) => (idSet.has(l.id) ? { ...l, ownerRepId: ownerRepId || undefined } : l)));
    if (enabled) assignOwnerManyRepo(ids, ownerRepId);
  }, [enabled]);

  // ── Staging pool ─────────────────────────────────────────────────────────────
  const stagedLeads = leads.filter((l) => l.deployed === false);
  const activeLeads = leads.filter((l) => l.deployed !== false && bookMatch(l));
  // Deploy the N oldest staged leads into a cadence (they become due now).
  // assignToRepId puts the batch in that rep's name; defaults to the signed-in user.
  const deployLeads = useCallback(async (count: number, cadenceId: string, assignToRepId?: string): Promise<number> => {
    const pool = leadsRef.current.filter((l) => l.deployed === false); // oldest-first (fetch order)
    const picked = pool.slice(0, Math.max(0, count)).map((l) => l.id);
    if (!picked.length) return 0;
    const owner = assignToRepId || me?.id;
    const idSet = new Set(picked);
    setLeads((prev) => prev.map((l) => (idSet.has(l.id) ? { ...l, deployed: true, cadenceId, cadencePos: 0, nextActionAt: undefined, lastTouch: 'New', ownerRepId: owner } : l)));
    if (enabled) { const moved = await deployStagedLeads(picked.length, cadenceId, owner); return moved.length || picked.length; }
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
    // Pull the lead out of a running flow's queue too — a queue entry pointing at
    // a deleted lead crashes the queue rail (leadById(id)! on a missing id).
    setFlow((f) => {
      const idx = f.queue.findIndex((q) => q.leadId === leadId);
      if (idx < 0) return f;
      const queue = f.queue.filter((q) => q.leadId !== leadId);
      const pos = idx < f.pos ? f.pos - 1 : f.pos;
      const nextItem = queue[pos];
      if (f.on && nextItem && idx === f.pos) setActiveLeadId(nextItem.leadId);
      return { ...f, queue, pos: Math.min(pos, queue.length), phase: 'action', pendingAdvance: null, done: f.on && !nextItem ? true : f.done };
    });
    setActiveLeadId((cur) => (cur === leadId ? (remaining.find((l) => l.deployed !== false)?.id || remaining[0]?.id || cur) : cur));
    if (enabled) deleteLeadRepo(leadId);
  }, [enabled]);

  // ── Enrichment (Google Places) ───────────────────────────────────────────────
  const enrichableLeads = leads.filter((l) => !l.phone || !l.email || !l.website || !l.bookingSystem);
  const DEMO_BOOKING = ['Vagaro', 'Square Appointments', 'Boulevard', 'Booksy', 'GlossGenius', 'Fresha'];
  // Look a lead up on Google Places; returns what was found (does not save).
  const enrichLead = useCallback(async (leadId: string, placeId?: string): Promise<EnrichResult> => {
    const lead = leadsRef.current.find((l) => l.id === leadId);
    if (!lead) return { found: false };
    if (!enabled) {
      // Demo mode: fabricate a plausible result so the flow is demonstrable.
      const slug = lead.salon.toLowerCase().replace(/[^a-z0-9]/g, '');
      const bk = DEMO_BOOKING[slug.length % DEMO_BOOKING.length];
      return { found: true, sure: true, name: lead.salon, phone: lead.phone || '(303) 555-0148', email: lead.email || `hello@${slug}.com`, website: lead.website || `${slug}.com`, bookingSystem: lead.bookingSystem || bk, city: lead.city || 'Denver, CO', address: `${lead.city || 'Denver, CO'}`, hours: ['Mon–Fri 9 AM–6 PM', 'Sat 9 AM–4 PM', 'Sun closed'] };
    }
    try {
      const res = await fetch('/api/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salon: lead.salon, city: lead.city, handle: lead.handle ? lead.handle.replace(/^@+/, '') : undefined, placeId }) });
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

  // Manual field edit from the lead Edit panel. Provided keys are applied even
  // when blank (clears phone/email/website/booking/city); salon/contact name are
  // ignored when blank. Overwrites, unlike saveEnrichment which only fills gaps.
  const saveLeadEdits = useCallback((leadId: string, patch: { salon?: string; contactName?: string; phone?: string; email?: string; website?: string; bookingSystem?: string; city?: string; handle?: string }) => {
    setLeads((prev) => prev.map((l) => {
      if (l.id !== leadId) return l;
      const nx = { ...l };
      if (patch.salon !== undefined && patch.salon.trim()) nx.salon = patch.salon.trim();
      if (patch.phone !== undefined) nx.phone = patch.phone.trim();
      if (patch.email !== undefined) nx.email = patch.email.trim() || undefined;
      if (patch.website !== undefined) nx.website = patch.website.trim() || undefined;
      if (patch.bookingSystem !== undefined) nx.bookingSystem = patch.bookingSystem.trim() || undefined;
      if (patch.city !== undefined) nx.city = patch.city.trim();
      if (patch.handle !== undefined) { const h = patch.handle.trim().replace(/^@+/, ''); nx.handle = h ? '@' + h : undefined; if (h) nx.source = 'instagram'; }
      if (l.contact) {
        nx.contact = { ...l.contact };
        if (patch.contactName !== undefined && patch.contactName.trim()) nx.contact.name = patch.contactName.trim();
        if (patch.phone !== undefined) nx.contact.phone = patch.phone.trim() || undefined;
        if (patch.email !== undefined) nx.contact.email = patch.email.trim() || undefined;
      }
      return nx;
    }));
    if (enabled) updateLeadFields(leadId, patch);
    addActivity(leadId, { kind: 'note', ty: 'Details edited', time: 'Just now', body: 'Lead details edited by hand.' });
  }, [enabled, addActivity]);

  // ── Due-today scheduler ──────────────────────────────────────────────────────
  const dueLeads = leads.filter((l) => leadIsDue(l) && bookMatch(l)).sort((a, b) => {
    const ca = callbackHot(a) ? 0 : 1; const cb = callbackHot(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const sa = socialHot(a) ? 0 : 1; const sb = socialHot(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ia = a.source === 'instagram' ? 0 : 1;
    const ib = b.source === 'instagram' ? 0 : 1;
    if (ia !== ib) return ia - ib; // fresh Instagram leads sit at the top of the session
    const wa = warmLeadIds.has(a.id) ? 0 : 1;
    const wb = warmLeadIds.has(b.id) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    const ta = a.nextActionAt ? new Date(a.nextActionAt).getTime() : startOfToday();
    const tb = b.nextActionAt ? new Date(b.nextActionAt).getTime() : startOfToday();
    return ta - tb;
  });
  const scheduledLeads = leads.filter((l) => leadIsScheduled(l) && bookMatch(l));
  const startDueFlow = useCallback(() => startFlow(dueLeads.map((l) => l.id)), [startFlow, dueLeads]);
  // Manually snooze/reschedule a lead N days out (days<=0 clears → due now).
  const snoozeLead = useCallback((leadId: string, days: number) => {
    const iso = days > 0 ? addBusinessDays(new Date(), days).toISOString() : null;
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

  // Create a lead from scratch (New lead form). A handle tags it source=instagram
  // (avatar badge). Opens it in the dialer so you can call right away.
  const addLead = useCallback(async (fields: { salon: string; contactName?: string; phone?: string; email?: string; website?: string; bookingSystem?: string; city?: string; handle?: string; cadenceId?: string; notes?: string }): Promise<Lead | null> => {
    if (enabled) {
      const lead = await createLead({ ...fields, ownerRepId: meRef.current?.id });
      if (lead) { setLeads((prev) => [...prev, lead]); setActiveLeadId(lead.id); setView('dialer'); }
      return lead;
    }
    const h = (fields.handle || '').trim().replace(/^@+/, '');
    const lead: Lead = {
      id: 'new' + Date.now(), salon: fields.salon, city: fields.city || '', phone: fields.phone || '',
      email: fields.email || undefined, website: fields.website || undefined, bookingSystem: fields.bookingSystem || undefined,
      handle: h ? '@' + h : undefined, source: h ? 'instagram' : undefined, notes: fields.notes,
      stage: 'new', cadenceId: fields.cadenceId || DEFAULT_CADENCE_ID, cadencePos: 0,
      contact: { id: 'c', name: fields.contactName || '\u2014', role: 'Owner', phone: fields.phone, email: fields.email }, lastTouch: 'New',
    };
    setLeads((prev) => [...prev, lead]); setActiveLeadId(lead.id); setView('dialer');
    return lead;
  }, [enabled]);

  return {
    view, setView, leads, activities, stats, activeLeadId, setActiveLeadId, leadById,
    flow, current, currentLead, currentChannel, attemptInfo, enabled, importLeads, importCleanRows, importInstagramRows,
    me, reps, signOut,
    startFlow, exitFlow, endCall, flowCall, flowSend, flowDispo, flowConnected, saveNote, skipNote, flowSkip, workLeadNow, sendLeadEmail,
    addActivity, setStage,
    messages, activeThreadLead, unreadCount, openThread, closeThread, sendReply, sendThreadReply, retrySend, threadKeyForMessage,
    activeCall, startCall, bridgeCall, useBridge, canBridge, setDeviceCallMode, inbound, ringInbound, simInbound, answerInbound, declineInbound,
    sendLeadDm, setCallback, confirmFlowCallback, cancelFlowCallback, callbackLeads,
    shareIntent, clearShareIntent, pendingCallLead, clearPendingCall,
    cadences, cadenceById, newCadence, saveCadence, removeCadence, assignCadence, assignCadenceMany, moveCadenceLeads,
    book, setBook,
    recentDials, matchLeadByNumber, logDial, sendKeypadText, saveNumberAsLead, addLead,
    dueLeads, scheduledLeads, startDueFlow, snoozeLead, warmLeadIds,
    isAdmin, repLeadCounts, loadTeam, inviteRep, resetRepPassword, emailPasswordReset, updateRep, assignOwnerMany,
    setAgentOwnerMany, agentStatus, agentError, refreshAgent, agentShift, agentCall,
    tplOverrides, textTemplates, emailTemplates, productTemplates, saveTemplate, resetTemplate,
    stagedLeads, activeLeads, deployLeads,
    enrichableLeads, enrichLead, saveEnrichment, saveLeadEdits, deleteLead, removeFromCadence,
  };
}
