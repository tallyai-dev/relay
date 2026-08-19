'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import type { Lead, Cadence, CadenceStep, Channel, DispositionKey, BranchAction, Branches, Stage } from '@/lib/types';
import { renderTemplate, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, DISPOSITIONS, branchFor, describeBranch } from '@/lib/cadence';
import { placeCall, normalizePhone } from '@/lib/voice';
import { analyzeImport } from '@/lib/csv';

type R = ReturnType<typeof useRelay>;

const PALETTE = ['#2563eb', '#6d5aa8', '#c2843a', '#3a6ea5', '#c0503f', '#2f8f6b', '#a4573f', '#4b6cb7'];
const initials = (s: string) => s.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const colorFor = (i: number) => PALETTE[i % PALETTE.length];
const stageLabel: Record<string, string> = { new: 'New', working: 'Working', hot: 'Hot', won: 'Won', cold: 'Cold' };
const stagePill: Record<string, string> = { new: 'new', working: 'work', hot: 'hot', won: 'won', cold: 'cold' };

const Icon = {
  call: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3-8.6A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z" /></svg>,
  text: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>,
  email: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M4 6l8 6 8-6" /></svg>,
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>,
  import: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></svg>,
};

export default function RelayApp() {
  const r = useRelay();
  const [importOpen, setImportOpen] = useState(false);
  return (
    <div className="app">
      <Rail r={r} />
      <div className="main">
        <TopBar r={r} onImport={() => setImportOpen(true)} />
        <div className="content">
          {r.view === 'leads' && <LeadsView r={r} onImport={() => setImportOpen(true)} />}
          {r.view === 'dialer' && <Dialer r={r} />}
          {r.view === 'keypad' && <Keypad r={r} />}
          {r.view === 'inbox' && <Inbox r={r} />}
          {r.view === 'cadences' && <CadenceBuilder r={r} />}
          {(r.view === 'reports' || r.view === 'mobile') && (
            <Placeholder view={r.view} />
          )}
        </div>
      </div>
      {importOpen && <ImportModal r={r} onClose={() => setImportOpen(false)} />}
      <IncomingBanner r={r} />
      <FloatingDialer r={r} />
    </div>
  );
}

const ROW_BADGE: Record<string, { label: string; cls: string }> = {
  ready: { label: 'New', cls: 'rb-ready' },
  dup_existing: { label: 'Already a lead', cls: 'rb-dup' },
  dup_batch: { label: 'Dup in file', cls: 'rb-dup' },
  invalid: { label: 'No salon name', cls: 'rb-bad' },
};

function ImportModal({ r, onClose }: { r: R; onClose: () => void }) {
  const [csv, setCsv] = useState('salon,city,phone,email,contact,role\nBella Salon,Denver CO,(303) 555-0101,hi@bella.com,Ana,Owner');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [owner, setOwner] = useState<string>(r.me?.id || '');
  const [showAll, setShowAll] = useState(false);
  const [drag, setDrag] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isAdmin = r.me?.role === 'admin';

  const loadFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result || '')); setShowAll(false); };
    reader.readAsText(file);
  };

  // Existing book — for duplicate detection.
  const existing = useMemo(() => {
    const phones = new Set<string>(); const keys = new Set<string>();
    r.leads.forEach((l) => {
      const p = (l.phone || '').replace(/\D/g, '').slice(-10);
      if (p) phones.add(p);
      keys.add(`${(l.salon || '').toLowerCase()}|${(l.city || '').toLowerCase()}`);
    });
    return { phones, keys };
  }, [r.leads]);

  const analysis = useMemo(() => (csv.trim() ? analyzeImport(csv, existing) : null), [csv, existing]);
  const s = analysis?.summary;
  const readyRows = analysis ? analysis.rows.filter((x) => x.status === 'ready') : [];

  const run = async () => {
    setBusy(true);
    const n = await r.importCleanRows(readyRows, owner || r.me?.id);
    setBusy(false); setDone(n);
  };

  const rowsToShow = analysis ? (showAll ? analysis.rows : analysis.rows.slice(0, 8)) : [];

  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="mh"><h3>Import leads</h3>{!r.enabled && <span className="demo-flag" style={{ marginLeft: 6 }}>Demo mode — appends locally</span>}<button className="x" onClick={onClose}>×</button></div>
        <div className="mb import-body">
          {done === null ? (
            <>
              <div className="import-hint">Upload a CSV file, or paste rows below. Columns are auto‑detected — phone numbers get cleaned up, bad emails dropped, and duplicates flagged before anything is imported.</div>
              <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
              <div
                className={`imp-drop${drag ? ' on' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                <div>{fileName ? <b>{fileName}</b> : <><b>Choose a CSV file</b> or drag it here</>}</div>
              </div>
              <div className="imp-or">or paste rows</div>
              <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setShowAll(false); setFileName(null); }} placeholder="Paste rows here…" />

              {analysis && s && s.total > 0 && (
                <>
                  {analysis.detected.length > 0 && (
                    <div className="imp-detected">Detected: {analysis.detected.map((d, i) => <span key={d.field}>{i > 0 ? ' · ' : ''}<b>{d.field}</b> ← {d.column}</span>)}</div>
                  )}
                  <div className="imp-chips">
                    <span className="imp-chip c-ready">{s.ready} new</span>
                    {s.dupExisting > 0 && <span className="imp-chip c-dup">{s.dupExisting} already in Relay</span>}
                    {s.dupBatch > 0 && <span className="imp-chip c-dup">{s.dupBatch} dup in file</span>}
                    {s.invalid > 0 && <span className="imp-chip c-bad">{s.invalid} no salon name</span>}
                    {s.phonesFixed > 0 && <span className="imp-chip c-fix">{s.phonesFixed} phones cleaned</span>}
                    {s.emailsDropped > 0 && <span className="imp-chip c-fix">{s.emailsDropped} bad emails dropped</span>}
                  </div>
                  <div className="imp-table">
                    <table>
                      <thead><tr><th>Salon</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead>
                      <tbody>
                        {rowsToShow.map((row, i) => (
                          <tr key={i} className={row.status !== 'ready' ? 'imp-skip' : ''}>
                            <td>{row.salon || <span className="muted">—</span>}</td>
                            <td>{row.phone || <span className="muted">{row.warnings.includes('phone unreadable') ? 'unreadable' : '—'}</span>}</td>
                            <td>{row.email || <span className="muted">—</span>}</td>
                            <td><span className={`rb ${ROW_BADGE[row.status].cls}`}>{ROW_BADGE[row.status].label}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {analysis.rows.length > 8 && !showAll && <button className="imp-more" onClick={() => setShowAll(true)}>Show all {analysis.rows.length} rows</button>}
                  </div>
                </>
              )}

              {r.enabled && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Assign this batch to</label>
                  {isAdmin && r.reps.length > 0 ? (
                    <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                      {r.reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}{rep.id === r.me?.id ? ' (you)' : ''} · {rep.role}</option>)}
                    </select>
                  ) : (
                    <div className="import-hint" style={{ marginTop: 0 }}>These leads will be assigned to <b>you</b>{isAdmin ? '' : ' (reps can only import to themselves)'}.</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '18px 0' }}>
              <div className="success-tick">✓</div>
              <div><span className="import-count">{done}</span> leads imported{r.enabled ? ' to Supabase' : ' (demo)'}. Duplicates and blanks were skipped automatically.</div>
            </div>
          )}
        </div>
        <div className="mf">
          {done === null ? (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={run} disabled={busy || readyRows.length === 0}>{busy ? 'Importing…' : `Import ${readyRows.length} new lead${readyRows.length === 1 ? '' : 's'}`}</button>
            </>
          ) : (
            <button className="btn primary" onClick={onClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Rail({ r }: { r: R }) {
  const btn = (v: R['view'], label: string, path: React.ReactNode) => (
    <button className={r.view === v ? 'on' : ''} title={label} onClick={() => r.setView(v)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{path}</svg>
    </button>
  );
  return (
    <nav className="rail">
      <div className="logo">R</div>
      {btn('leads', 'Leads', <path d="M3 6h18M3 12h18M3 18h18" />)}
      {btn('dialer', 'Workspace', <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3-8.6A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z" />)}
      {btn('keypad', 'Keypad', <><circle cx="7" cy="6" r="1.3" /><circle cx="12" cy="6" r="1.3" /><circle cx="17" cy="6" r="1.3" /><circle cx="7" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="17" cy="12" r="1.3" /><circle cx="7" cy="18" r="1.3" /><circle cx="12" cy="18" r="1.3" /><circle cx="17" cy="18" r="1.3" /></>)}
      <button className={r.view === 'inbox' ? 'on' : ''} title="Inbox" onClick={() => r.setView('inbox')} style={{ position: 'relative' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M4 9h5l2 3h2l2-3h5" /></svg>
        {r.unreadCount > 0 && <span className="badge">{r.unreadCount}</span>}
      </button>
      {btn('cadences', 'Cadences', <path d="M3 12h4l3 8 4-16 3 8h4" />)}
      {btn('reports', 'Reports', <path d="M3 3v18h18M8 15v3M13 9v9M18 5v13" />)}
      {btn('mobile', 'Mobile', <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>)}
      <div className="spacer" />
      <div className="me" title={r.me?.name || 'You'}>{r.me ? initials(r.me.name) : 'SB'}</div>
    </nav>
  );
}

function TopBar({ r, onImport }: { r: R; onImport: () => void }) {
  const { score } = r;
  return (
    <div className="topbar">
      <div><div className="title">{r.view === 'dialer' ? 'Dialer session' : r.view[0].toUpperCase() + r.view.slice(1)}</div></div>
      <div className="metrics">
        <div className="metric"><span>Calls</span><b>{score.calls}</b><span className="bar"><i style={{ width: '68%' }} /></span></div>
        <div className="metric"><span>Texts</span><b>{score.texts}</b><span className="bar"><i style={{ width: '44%' }} /></span></div>
        <div className="metric"><span>Emails</span><b>{score.emails}</b><span className="bar"><i style={{ width: '55%' }} /></span></div>
        <div className="metric goal"><span>Demos</span><b>{score.demos}</b><span className="g">/10 today</span></div>
      </div>
      <div className="grow" />
      {!r.enabled && <span className="demo-flag" title="No Supabase configured — running on local demo data">Demo mode</span>}
      {r.enabled && r.me && <span className="demo-flag" style={{ background: r.me.role === 'admin' ? 'var(--accent-soft)' : '#eef2f8', color: r.me.role === 'admin' ? 'var(--accent-ink)' : 'var(--ink2)' }} title={r.me.email}>{r.me.name} · {r.me.role}</span>}
      <button className="btn" onClick={onImport}>{Icon.import}Import leads</button>
      <button className="btn flowbtn" onClick={() => r.startFlow()}>{Icon.flow}Flow Mode</button>
      {r.enabled && <button className="btn" onClick={r.signOut} title="Sign out">Sign out</button>}
    </div>
  );
}

function dueBadge(l: Lead): string | null {
  if (!l.nextActionAt) return null;
  const ms = new Date(l.nextActionAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const d = Math.max(1, Math.ceil(ms / 864e5));
  return `⏰ due in ${d}d`;
}

function LeadsView({ r, onImport }: { r: R; onImport: () => void }) {
  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Salon prospecting — pipeline</h1><p>{r.leads.length} salons · working the “Cold Salon Outbound” cadence</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onImport}>{Icon.import}Import leads</button>
          {r.dueLeads.length > 0
            ? <button className="btn primary flowbtn" onClick={r.startDueFlow}>{Icon.flow}Work {r.dueLeads.length} due today</button>
            : <button className="btn primary flowbtn" onClick={() => r.startFlow()}>{Icon.flow}Start Flow</button>}
        </div>
      </div>
      <div className="due-bar">
        <span className="due-chip due-now">{r.dueLeads.length} due today</span>
        {r.scheduledLeads.length > 0 && <span className="due-chip due-later">{r.scheduledLeads.length} scheduled</span>}
        <span className="due-hint">Snoozed salons come back automatically on their re-touch date.</span>
      </div>
      <div className="table">
        <table>
          <thead><tr><th>Salon</th><th>Owner / contact</th><th>Next step</th><th>Last touch</th><th>Stage</th><th /></tr></thead>
          <tbody>
            {r.leads.map((l, i) => (
              <tr key={l.id} onClick={() => { r.setActiveLeadId(l.id); r.setView('dialer'); }} style={{ cursor: 'pointer' }}>
                <td><div className="salon-cell"><div className="avatar" style={{ background: colorFor(i) }}>{initials(l.salon)}</div>
                  <div><div className="nm">{l.salon}</div><div className="loc">{l.city}</div></div></div></td>
                <td>{l.contact?.name === '—' ? <span className="muted">No name yet</span> : <div><div style={{ fontWeight: 600 }}>{l.contact?.name}</div><div className="loc">{l.contact?.role}</div></div>}</td>
                <td>{dueBadge(l) ? <span className="mode sched">{dueBadge(l)}</span> : <span className="mode">{Icon.call} Call — {l.objection}</span>}</td>
                <td className="muted">{l.lastTouch}</td>
                <td><span className={`pill ${stagePill[l.stage]}`}><span className="dot" style={{ background: 'currentColor' }} />{stageLabel[l.stage]}</span></td>
                <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); r.setActiveLeadId(l.id); r.setView('dialer'); }}>Open →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Placeholder({ view }: { view: string }) {
  const label: Record<string, string> = { inbox: 'Inbox', cadences: 'Cadence builder', reports: 'Reports', mobile: 'Mobile preview' };
  return (
    <section className="view on">
      <div className="page-head"><div><h1>{label[view]}</h1><p>Wired in the prototype — porting to React in Phase 2. Backend endpoints for this are already scaffolded.</p></div></div>
      <div className="block" style={{ maxWidth: 620 }}>
        <div className="bt" style={{ marginBottom: 8 }}>Phase 2</div>
        This screen exists in the approved prototype (see relay-prototype.html). The data model, cadence engine, and Twilio/email
        endpoints that power it are already built — this view is the next port.
      </div>
    </section>
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────────────
function fmtPhone(p?: string): string {
  const d = (p || '').replace(/\D/g, '');
  const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (t.length === 10) return `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`;
  return p || '—';
}

function Inbox({ r }: { r: R }) {
  const [reply, setReply] = useState('');
  // Group every message by its thread key (lead id, or "tel:<digits>" when there's
  // no lead) so texts to/from unknown numbers still show up.
  const byKey = new Map<string, typeof r.messages>();
  r.messages.forEach((m) => { const k = r.threadKeyForMessage(m); if (!k) return; const a = byKey.get(k) || []; a.push(m); byKey.set(k, a); });
  const threadList = [...byKey.entries()].map(([key, msgs]) => {
    const isPhone = key.startsWith('tel:');
    const lead = isPhone ? undefined : r.leadById(key);
    const number = isPhone ? key.slice(4) : lead?.phone;
    const name = lead ? (lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name : lead.salon) : fmtPhone(number);
    return { key, msgs, last: msgs[msgs.length - 1], unread: msgs.some((x) => x.direction === 'in' && !x.isRead), isPhone, lead, number, name };
  });
  const sel = r.activeThreadLead;
  const selT = threadList.find((t) => t.key === sel);
  const selMsgs = selT ? selT.msgs : [];

  return (
    <section className="view on" style={{ padding: 0 }}>
      <div className={`inbox ${sel ? 'has-sel' : ''}`}>
        <div className="inbox-list">
          <div className="inbox-lh"><h2>Inbox</h2><button className="btn sm" onClick={r.simInbound}>☎ Simulate returning call</button></div>
          {threadList.length === 0 && <div className="inbox-empty" style={{ padding: '30px 16px', textAlign: 'left' }}>No conversations yet. Texts you send or receive will thread here.</div>}
          {threadList.map((t, i) => (
            <div key={t.key} className={`thread ${t.unread ? 'unread' : ''} ${sel === t.key ? 'on' : ''}`} onClick={() => r.openThread(t.key)}>
              <div className="tav" style={{ background: colorFor(i) }}>{initials(t.name || '?')}
                <span className="chn">{t.last.channel === 'email' ? Icon.email : Icon.text}</span></div>
              <div className="tbody">
                <div className="trow"><span className="tnm">{t.name}</span><span className="ttime">{t.last.time}</span></div>
                <div className="tsalon">{t.lead ? t.lead.salon : 'Not in your leads'}</div>
                <div className="tprev">{t.last.body}</div>
              </div>
              {t.unread && <span className="udot" />}
            </div>
          ))}
        </div>
        <div className="inbox-conv">
          {!selT ? <div className="inbox-empty">Select a conversation</div> : (
            <>
              <div className="conv-head">
                <button className="inbox-back" onClick={r.closeThread} title="Back to inbox">‹</button>
                <div className="cav" style={{ background: colorFor(threadList.findIndex((t) => t.key === sel)) }}>{initials(selT.name || '?')}</div>
                <div><h3>{selT.name}{selT.lead ? ` · ${selT.lead.salon}` : ''}</h3><div className="cs">{selMsgs[selMsgs.length - 1]?.channel === 'email' ? 'Email' : 'Text'} · {fmtPhone(selT.number)}</div></div>
                <div className="ca">
                  {selT.lead
                    ? <button className="btn sm" onClick={() => { r.setActiveLeadId(selT.lead!.id); r.setView('dialer'); }}>Open in dialer</button>
                    : <button className="btn sm" onClick={() => r.saveNumberAsLead(selT.number || '', '')}>+ Save as lead</button>}
                </div>
              </div>
              <div className="conv-msgs">
                {selMsgs.map((m) => (
                  <div key={m.id} className={`cmsg ${m.direction === 'out' ? 'me' : 'them'}`}>
                    <div className="meta">{m.direction === 'out' ? 'You' : selT.lead?.contact?.name && selT.lead.contact.name !== '—' ? selT.lead.contact.name : fmtPhone(selT.number)} · {m.channel} · {m.time}
                      {m.pending && <span className="msg-status pending"> · sending…</span>}
                      {m.failed && <span className="msg-status failed"> · not delivered</span>}</div>
                    <div className={`bub${m.failed ? ' failed' : ''}`}>{m.subject && <div className="subj">{m.subject}</div>}{m.body}</div>
                    {m.failed && <button className="msg-retry" onClick={() => r.retrySend(m.id)}>Retry send</button>}
                  </div>
                ))}
              </div>
              <div className="conv-reply">
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (reply.trim()) { r.sendThreadReply(sel!, reply.trim()); setReply(''); } } }} />
                <button className="btn primary send" onClick={() => { if (reply.trim()) { r.sendThreadReply(sel!, reply.trim()); setReply(''); } }}>Send</button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function IncomingBanner({ r }: { r: R }) {
  if (!r.inbound) return null;
  const l = r.leadById(r.inbound.leadId);
  return (
    <div className="incoming on">
      <div className="inc-card">
        <div className="inc-pulse">{Icon.call}</div>
        <div className="inc-info"><div className="inc-eyebrow">Incoming · returning your call</div>
          <div className="inc-name">{l?.contact?.name && l.contact.name !== '—' ? l.contact.name : l?.salon}</div>
          <div className="inc-sub">{l?.salon} · {l?.phone}</div></div>
        <div className="inc-actions"><button className="inc-decline" onClick={r.declineInbound}>Decline</button>
          <button className="inc-answer" onClick={r.answerInbound}>Answer</button></div>
      </div>
    </div>
  );
}

// ── Dialer workspace ──────────────────────────────────────────────────────────
function Dialer({ r }: { r: R }) {
  const lead = r.leadById(r.activeLeadId);
  if (!lead) return null;
  const acts = r.activities[lead.id] || [];
  const inFlow = r.flow.on && !r.flow.paused;
  const idx = r.leads.findIndex((l) => l.id === lead.id);

  return (
    <section className="view on" style={{ padding: 0 }}>
      <div className={`ws${r.activeCall ? ' calling' : ''}`}>
        {/* queue rail */}
        <div className="ws-list">
          <div className="lh"><span>Session queue</span></div>
          {(inFlow ? r.flow.queue.map((q) => q.leadId) : r.leads.map((l) => l.id)).map((id) => {
            const l = r.leadById(id)!; const li = r.leads.findIndex((x) => x.id === id);
            const done = inFlow && r.flow.queue.findIndex((q) => q.leadId === id) < r.flow.pos;
            return (
              <div key={id} className={`ws-item ${id === lead.id ? 'on' : ''} ${done ? 'done' : ''}`} onClick={() => r.setActiveLeadId(id)}>
                <div className="avatar ai" style={{ background: colorFor(li) }}>{initials(l.salon)}</div>
                <div><div className="nm">{l.salon}</div><div className="mt">{l.contact?.name === '—' ? l.contact?.role : l.contact?.name}</div></div>
                {done ? <div className="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg></div>
                  : <div className="stp">{l.cadencePos + 1}/5</div>}
              </div>
            );
          })}
        </div>

        {/* center */}
        <div className="ws-center">
          {inFlow ? (
            <div className="session-bar flow">
              <span>⚡ <b>Flow</b> · Cold Salon Outbound · {r.flow.queue.length - r.flow.pos} of {r.flow.queue.length} salons left</span>
              <div className="prog"><i style={{ width: `${(r.flow.pos / Math.max(1, r.flow.queue.length)) * 100}%` }} /></div>
              <button className="btn sm" onClick={r.exitFlow}>Exit flow</button>
            </div>
          ) : (
            <div className="session-bar"><span>Manual dial</span><div className="prog"><i style={{ width: '20%' }} /></div>
              <button className="btn sm flowbtn" onClick={() => r.startFlow()}>Start Flow</button></div>
          )}

          <div className="lead-head">
            <div className="avatar big" style={{ background: colorFor(idx) }}>{initials(lead.salon)}</div>
            <div><h2>{lead.salon}</h2><div className="meta">{lead.contact?.name === '—' ? lead.contact?.role : `${lead.contact?.name} · ${lead.contact?.role}`} · {lead.city}</div></div>
            <div className="r"><span className={`pill ${stagePill[lead.stage]}`}><span className="dot" style={{ background: 'currentColor' }} />{stageLabel[lead.stage]}</span></div>
          </div>

          {inFlow ? <FlowBar r={r} lead={lead} /> : (
            <div className="task-strip"><div className="cb" /><div className="t">Call — {lead.objection}</div>
              <div className="chip amber">Due today</div>
              <div className="o"><button className="btn sm primary" onClick={() => r.startFlow()}>Start Flow</button></div></div>
          )}

          <div className="qgrid">
            <div className="qc"><div className="qk">Phone</div><div className="qv">{lead.phone}</div></div>
            <div className="qc"><div className="qk">Cadence</div>
              <select className="qv-select" value={r.cadences.some((c) => c.id === lead.cadenceId) ? lead.cadenceId : (r.cadences[0]?.id || '')}
                onChange={(e) => r.assignCadence(lead.id, e.target.value)} onClick={(e) => e.stopPropagation()}>
                {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="qc"><div className="qk">Last touch</div><div className="qv">{lead.lastTouch}</div></div>
            <div className="qc"><div className="qk">Objection</div><div className="qv">{lead.objection}</div></div>
          </div>

          <div className="block" style={{ marginTop: 14 }}>
            <div className="bh"><div className="bt">Activity · {acts.length}</div></div>
            <div className="timeline">
              {acts.length === 0 && <div className="muted">No activity yet — first touch.</div>}
              {acts.map((h) => (
                <div key={h.id} className={`tl ${h.kind}`}>
                  <div className="dot" />
                  <div className="tlh"><span className="ty">{h.ty}</span>{h.ai && <span className="ai-note">✦ AI summary</span>}<span className="tm">{h.time}</span></div>
                  <div className={`body ${h.kind === 'call' || h.kind === 'book' ? 'card' : ''}`}>
                    {h.aiNote || h.body}
                    {h.ownNote && <div className="own-note">📝 {h.ownNote}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* right: script */}
        <ScriptPanel lead={lead} />

        {/* live call column (outbound flow OR answered inbound) */}
        {r.activeCall && <CallPanel r={r} lead={lead} direction={r.activeCall.direction} incomingCall={r.activeCall.incomingCall} />}
      </div>
    </section>
  );
}

function ScriptPanel({ lead }: { lead: Lead }) {
  return (
    <div className="ws-right">
      <div className="rp-head"><div className="ic">{Icon.flow}</div><div><div className="nm">Intro — gatekeeper answers</div></div></div>
      <div className="rp-body">
        <div className="script-step"><div className="sn">01 — HEY, WHAT TIME DO YOU CLOSE?</div>
          <span className="lbl">Casual open</span>
          <div className="say">&quot;Hey, what time do you guys close?&quot;</div>
          <div className="aside">About 8 o&apos;clock — or — We&apos;re open online 24/7.</div></div>
        <div className="script-step"><div className="sn">02 — AFTER-HOURS</div>
          <div className="say">&quot;And if someone calls {lead.salon} after you close — does it just go to voicemail?&quot;</div></div>
        <div className="script-step"><div className="sn">03 — THE PITCH</div>
          <div className="say">&quot;We help salons set up an AI receptionist that answers missed &amp; after-hours calls so you&apos;re not losing booking revenue. Are you the owner?&quot;</div></div>
      </div>
    </div>
  );
}

// ── Flow action bar ───────────────────────────────────────────────────────────
function FlowBar({ r, lead }: { r: R; lead: Lead }) {
  const ch = r.currentChannel;
  const { phase } = r.flow;

  if (phase === 'incall') {
    return <div className="flowbar dispo"><span className="fb-badge live">On the call</span>
      <span className="fb-what">Live with {lead.contact?.name === '—' ? lead.salon : lead.contact?.name?.split(' ')[0]} — hit “End &amp; log” to pick the outcome →</span></div>;
  }
  if (phase === 'note') return <NoteBar r={r} />;
  if (phase === 'dispo') {
    return (
      <div className="flowbar dispo"><span className="fb-badge live">On the call</span><span className="fb-what">How&apos;d it go?</span>
        <div className="fb-dispos">
          <button onClick={() => r.flowDispo('no_answer')}><span className="k">1</span>No answer</button>
          <button onClick={() => r.flowDispo('voicemail')}><span className="k">2</span>Voicemail</button>
          <button className="good" onClick={() => r.flowDispo('connected')}><span className="k">3</span>Connected!</button>
          <button className="bad" onClick={() => r.flowDispo('wrong_number')}><span className="k">4</span>Wrong #</button>
        </div>
      </div>
    );
  }
  if (phase === 'connected') {
    return (
      <div className="flowbar connected"><span className="fb-badge good">Connected{lead.contact?.name === '—' ? '' : ' — ' + lead.contact?.name?.split(' ')[0]}</span>
        <div className="fb-dispos">
          <button className="good" onClick={() => r.flowConnected('booked')}><span className="k">1</span>🎉 Booked</button>
          <button onClick={() => r.flowConnected('callback')}><span className="k">2</span>Callback</button>
          <button className="bad" onClick={() => r.flowConnected('not_interested')}><span className="k">3</span>Not interested</button>
        </div>
      </div>
    );
  }
  // action phase
  if (ch === 'call') {
    const { attempt, totalCalls } = r.attemptInfo;
    const next = attempt < totalCalls ? `call attempt ${attempt + 1}` : 'text + email';
    return (
      <div className="flowbar call"><span className="fb-badge">⚡ Flow · Action {r.flow.actionCount + 1}</span>
        <span className="fb-what">{Icon.call} Call attempt {attempt} of {totalCalls}</span>
        <span className="fb-sub">No answer → {next}</span>
        <div className="fb-actions"><button className="btn primary sm" onClick={r.flowCall}>{Icon.call} Call {lead.phone}</button>
          <button className="btn sm" onClick={r.flowSkip}>Skip</button></div></div>
    );
  }
  if (ch === 'text') return <ComposeText r={r} lead={lead} />;
  return <ComposeEmail r={r} lead={lead} />;
}

function ComposeText({ r, lead }: { r: R; lead: Lead }) {
  const cad = r.cadenceById(lead.cadenceId);
  const tpl = cad?.steps.find((s) => s.channel === 'text' && s.template)?.template || DEFAULT_SMS;
  const [body, setBody] = useState(renderTemplate(tpl, lead));
  return (
    <div className="flowbar text compose">
      <div className="compose-head"><span className="fb-badge">{Icon.text} Text · Action {r.flow.actionCount + 1}</span>
        <span className="compose-meta">To {lead.contact?.name === '—' ? lead.contact?.role : lead.contact?.name} · {lead.phone} · review before sending</span></div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="fb-actions"><button className="btn sm" onClick={r.flowSkip}>Skip</button>
        <button className="btn primary sm" style={{ background: 'var(--purple)', borderColor: 'var(--purple)' }} onClick={() => r.flowSend('text', body)}>Send text</button></div>
    </div>
  );
}

function ComposeEmail({ r, lead }: { r: R; lead: Lead }) {
  const cad = r.cadenceById(lead.cadenceId);
  const estep = cad?.steps.find((s) => s.channel === 'email' && (s.template || s.subject));
  const [subj, setSubj] = useState(renderTemplate(estep?.subject || DEFAULT_EMAIL_SUBJECT, lead));
  const [body, setBody] = useState(renderTemplate(estep?.template || DEFAULT_EMAIL_BODY, lead));
  return (
    <div className="flowbar email compose">
      <div className="compose-head"><span className="fb-badge">{Icon.email} Email · Action {r.flow.actionCount + 1}</span>
        <span className="compose-meta">To {lead.contact?.name === '—' ? lead.contact?.role : lead.contact?.name} · review before sending</span></div>
      <input value={subj} onChange={(e) => setSubj(e.target.value)} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="fb-actions"><button className="btn sm" onClick={r.flowSkip}>Skip</button>
        <button className="btn primary sm" style={{ background: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => r.flowSend('email', body, subj)}>Send email</button></div>
    </div>
  );
}

function NoteBar({ r }: { r: R }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="flowbar note">
      <div className="compose-head"><span className="fb-badge good">✦ AI note captured</span><span className="fb-sub" style={{ color: '#9fb4d4' }}>add your own if needed</span></div>
      <div className="ai-preview">{r.flow.noteAiText}</div>
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add your note… (Enter to save)"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); r.saveNote(text); } }} />
      <div className="fb-actions"><button className="btn sm" onClick={r.skipNote}>Skip note →</button>
        <button className="btn primary sm" onClick={() => r.saveNote(text)}>Save &amp; next →</button></div>
    </div>
  );
}

// ── Live call panel ───────────────────────────────────────────────────────────
// Tries a real Twilio call first; falls back to a scripted sim when Voice isn't
// configured, so the loop is always demoable.
function CallPanel({ r, lead, direction, incomingCall }: { r: R; lead: Lead; direction: 'out' | 'in'; incomingCall?: any }) {
  const [secs, setSecs] = useState(0);
  const [lines, setLines] = useState<{ sp: string; msg: string }[]>([]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(direction === 'in' ? 'Connected (inbound)' : 'Connecting…');
  const [mode, setMode] = useState<'connecting' | 'real' | 'sim'>('connecting');
  const callRef = useRef<any>(null);
  const them = lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name.split(' ')[0] : 'Them';

  useEffect(() => {
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    let sim: ReturnType<typeof setInterval> | undefined;
    const startTick = () => { tick = setInterval(() => setSecs((s) => s + 1), 1000); };
    const outScript = [
      { sp: 'you', msg: 'Hey, what time do you guys close?' },
      { sp: 'them', msg: "Uh, about 8. Who's this?" },
      { sp: 'you', msg: `Seth — quick one. If someone calls ${lead.salon} after 8, does it just go to voicemail?` },
      { sp: 'them', msg: 'Yeah, pretty much. We catch it in the morning.' },
      { sp: 'you', msg: 'Gotcha. We set salons up with an AI receptionist that answers those and books them. Are you the owner?' },
      { sp: 'them', msg: `I am, yeah. ${them}.` },
    ];
    const inScript = [
      { sp: 'them', msg: 'Hi — I got a missed call and a text from this number about my salon?' },
      { sp: 'you', msg: `Yes! ${them} — thanks for calling ${lead.salon} back.` },
      { sp: 'them', msg: 'Right. We do miss a bunch after we close. What is it exactly?' },
      { sp: 'you', msg: 'An AI receptionist that answers and books those 24/7. Can I grab 15 min to show you?' },
    ];
    const runSim = (script: { sp: string; msg: string }[]) => {
      setMode('sim'); setStatus(direction === 'in' ? 'Connected (inbound)' : 'Connected'); startTick();
      let i = 0;
      sim = setInterval(() => {
        if (i >= script.length) { clearInterval(sim); setNote(`✦ AI: ${direction === 'in' ? 'inbound return call' : 'reached'} ${them} at ${lead.salon}. After-hours pain confirmed. Demo interest.`); return; }
        setLines((prev) => [...prev, script[i]]); i++;
      }, 1300);
    };

    (async () => {
      if (direction === 'in') {
        if (incomingCall?.accept) {
          callRef.current = incomingCall; setMode('real'); setStatus('Connected (inbound)'); startTick();
          incomingCall.on?.('disconnect', () => setStatus('Call ended'));
          try { incomingCall.accept(); } catch { /* noop */ }
        } else { runSim(inScript); }
        return;
      }
      const call = await placeCall(lead.phone || '');
      if (cancelled) { call?.disconnect?.(); return; }
      if (call) {
        callRef.current = call;
        setMode('real'); setStatus('Ringing…');
        call.on('accept', () => { setStatus('Connected'); startTick(); });
        call.on('disconnect', () => setStatus('Call ended'));
        call.on('cancel', () => setStatus('Ended'));
        call.on('error', (e: any) => { setStatus('Call error'); console.error(e); });
      } else { runSim(outScript); }
    })();

    return () => { cancelled = true; if (tick) clearInterval(tick); if (sim) clearInterval(sim); callRef.current?.disconnect?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const end = () => { callRef.current?.disconnect?.(); r.endCall(); };
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <div className="callcol" style={{ display: 'flex' }}>
      <div className="ch"><span className="live"><span className="p" /><span>{status}</span></span><span className="tm">{mm}:{ss}</span></div>
      <div className="who">{direction === 'in' ? 'incoming' : mode === 'real' ? 'live' : 'mobile'} · {lead.phone} · {lead.contact?.name === '—' ? lead.salon : lead.contact?.name}</div>
      <div className="transcript">
        {mode === 'real' && (
          <div className="tr them"><div className="sp">Relay</div><div className="msg">Live call in progress. Real-time transcription arrives in a later phase — jot key points below and log the outcome when you hang up.</div></div>
        )}
        {lines.map((m, i) => (<div key={i} className={`tr ${m.sp}`}><div className="sp">{m.sp === 'you' ? 'You' : them}</div><div className="msg">{m.msg}</div></div>))}
      </div>
      <div className="live-notes"><div className="lh">✦ Auto-notes · AI listening</div><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notes while you talk…" /></div>
      <div className="callctrls">
        <button className="ic" title="Mute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z" /><path d="M5 10v1a7 7 0 0014 0v-1" /></svg></button>
        <button className="end" onClick={end}>End &amp; log</button>
      </div>
    </div>
  );
}

// ── Cadence builder ─────────────────────────────────────────────────────────
const CH_META: Record<Channel, { label: string; icon: React.ReactNode; color: string }> = {
  call: { label: 'Call', icon: Icon.call, color: 'var(--accent)' },
  text: { label: 'Text', icon: Icon.text, color: 'var(--purple, #6d5aa8)' },
  email: { label: 'Email', icon: Icon.email, color: 'var(--blue, #3a6ea5)' },
  wait: { label: 'Wait', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>, color: '#8a97ab' },
};

// The routing choices offered per disposition, flattened into one dropdown.
const ACTION_OPTIONS: { val: string; label: string; action: BranchAction }[] = [
  { val: 'continue', label: 'Continue to next step', action: { type: 'continue' } },
  { val: 'send:text', label: 'Send a text → continue', action: { type: 'send', channel: 'text' } },
  { val: 'send:email', label: 'Send an email → continue', action: { type: 'send', channel: 'email' } },
  { val: 'wait:1', label: 'Wait 1 day → re-touch', action: { type: 'wait', days: 1 } },
  { val: 'wait:2', label: 'Wait 2 days → re-touch', action: { type: 'wait', days: 2 } },
  { val: 'wait:3', label: 'Wait 3 days → re-touch', action: { type: 'wait', days: 3 } },
  { val: 'wait:7', label: 'Wait 7 days → re-touch', action: { type: 'wait', days: 7 } },
  { val: 'stop:hot', label: 'Stop — mark Hot', action: { type: 'stop', stage: 'hot' } },
  { val: 'stop:working', label: 'Stop — mark Working', action: { type: 'stop', stage: 'working' } },
  { val: 'stop:won', label: 'Stop — mark Won', action: { type: 'stop', stage: 'won' } },
  { val: 'stop:cold', label: 'Stop — mark Cold', action: { type: 'stop', stage: 'cold' } },
];
const actionToVal = (a: BranchAction): string =>
  a.type === 'continue' ? 'continue' : a.type === 'send' ? `send:${a.channel}` : a.type === 'wait' ? `wait:${a.days}` : `stop:${a.stage}`;
const valToAction = (v: string): BranchAction => ACTION_OPTIONS.find((o) => o.val === v)?.action || { type: 'continue' };

function BranchEditor({ step, open, onToggle, onSet }: { step: CadenceStep; open: boolean; onToggle: () => void; onSet: (k: DispositionKey, a: BranchAction) => void }) {
  return (
    <div className="cad-branch">
      <button className="cad-branch-toggle" onClick={onToggle}>
        <span className="cbt-ic">{open ? '▾' : '▸'}</span> If the call ends in…
        <span className="cbt-sum">{DISPOSITIONS.map((d) => describeBranch(branchFor(step, d.key)).replace(/ —.*/, '').replace('Continue to next step', 'continue')).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(' · ')}</span>
      </button>
      {open && (
        <div className="cad-branch-rows">
          {DISPOSITIONS.map((d) => {
            const cur = actionToVal(branchFor(step, d.key));
            const inList = ACTION_OPTIONS.some((o) => o.val === cur);
            return (
              <div key={d.key} className={`cad-branch-row grp-${d.group}`}>
                <span className="cbr-dispo">{d.label}</span>
                <span className="cbr-arrow">→</span>
                <select value={inList ? cur : 'continue'} onChange={(e) => onSet(d.key, valToAction(e.target.value))}>
                  {ACTION_OPTIONS.map((o) => <option key={o.val} value={o.val}>{o.label}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CadenceBuilder({ r }: { r: R }) {
  const [selId, setSelId] = useState<string>(r.cadences[0]?.id || '');
  const [draft, setDraft] = useState<Cadence | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openBranches, setOpenBranches] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const c = r.cadences.find((x) => x.id === selId);
    if (!c) { if (r.cadences[0]) setSelId(r.cadences[0].id); return; }
    setDraft(JSON.parse(JSON.stringify(c)));
    setDirty(false);
  }, [selId, r.cadences]);

  const patchDraft = (fn: (d: Cadence) => Cadence) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };
  const updStep = (i: number, patch: Partial<CadenceStep>) =>
    patchDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addStep = () => patchDraft((d) => ({ ...d, steps: [...d.steps, { position: d.steps.length, channel: 'call', waitMinutes: 0 }] }));
  const removeStep = (i: number) => patchDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
  const moveStep = (i: number, dir: -1 | 1) => patchDraft((d) => {
    const j = i + dir; if (j < 0 || j >= d.steps.length) return d;
    const steps = d.steps.slice(); [steps[i], steps[j]] = [steps[j], steps[i]]; return { ...d, steps };
  });
  const setBranch = (i: number, key: DispositionKey, action: BranchAction) =>
    patchDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, branches: { ...(s.branches || {}), [key]: action } } : s)) }));

  const save = async () => { if (!draft) return; setSaving(true); await r.saveCadence(draft); setSaving(false); setDirty(false); };
  const create = async () => { const c = await r.newCadence('New cadence'); setSelId(c.id); };
  const del = async () => { if (!draft) return; await r.removeCadence(draft.id); setSelId(r.cadences.find((c) => c.id !== draft.id)?.id || ''); };

  const usedBy = (id: string) => r.leads.filter((l) => l.cadenceId === id).length;

  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Cadences</h1><p>{r.cadences.length} cadence{r.cadences.length === 1 ? '' : 's'} · build the call / text / email sequence Flow works through</p></div>
        <button className="btn primary" onClick={create}>+ New cadence</button>
      </div>
      <div className="cadbuild">
        <div className="cad-list">
          {r.cadences.map((c) => (
            <button key={c.id} className={`cad-li ${c.id === selId ? 'on' : ''}`} onClick={() => setSelId(c.id)}>
              <div className="cad-nm">{c.name}</div>
              <div className="cad-mt">{c.steps.length} step{c.steps.length === 1 ? '' : 's'} · {usedBy(c.id)} lead{usedBy(c.id) === 1 ? '' : 's'}</div>
            </button>
          ))}
          {r.cadences.length === 0 && <div className="muted" style={{ padding: 12 }}>No cadences yet — create one.</div>}
        </div>

        {draft ? (
          <div className="cad-edit">
            <div className="cad-edit-head">
              <input className="cad-name-in" value={draft.name} onChange={(e) => patchDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Cadence name" />
              <div style={{ display: 'flex', gap: 8 }}>
                {r.cadences.length > 1 && <button className="btn danger sm" onClick={del}>Delete</button>}
                <button className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
              </div>
            </div>

            <div className="cad-steps">
              {draft.steps.map((s, i) => (
                <div key={i} className={`cad-step ch-${s.channel}`}>
                  <div className="cad-step-n" style={{ color: CH_META[s.channel].color }}>{i + 1}</div>
                  <div className="cad-step-body">
                    <div className="cad-step-row">
                      <label className="cad-chan">
                        <span className="cad-chan-ic" style={{ color: CH_META[s.channel].color }}>{CH_META[s.channel].icon}</span>
                        <select value={s.channel} onChange={(e) => updStep(i, { channel: e.target.value as Channel })}>
                          {(['call', 'text', 'email', 'wait'] as Channel[]).map((ch) => <option key={ch} value={ch}>{CH_META[ch].label}</option>)}
                        </select>
                      </label>
                      <label className="cad-gap">Day gap
                        <input type="number" min={0} step={0.5} value={+(s.waitMinutes / 1440).toFixed(2)}
                          onChange={(e) => updStep(i, { waitMinutes: Math.max(0, Math.round(parseFloat(e.target.value || '0') * 1440)) })} />
                      </label>
                      <div className="cad-step-ctrls">
                        <button className="ico" title="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                        <button className="ico" title="Move down" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                        <button className="ico del" title="Remove" onClick={() => removeStep(i)}>✕</button>
                      </div>
                    </div>
                    {s.channel === 'email' && (
                      <input className="cad-subj" value={s.subject || ''} onChange={(e) => updStep(i, { subject: e.target.value })} placeholder="Email subject — use {salon}, {first_name}" />
                    )}
                    {(s.channel === 'text' || s.channel === 'email') && (
                      <textarea className="cad-tpl" value={s.template || ''} onChange={(e) => updStep(i, { template: e.target.value })}
                        placeholder={s.channel === 'text' ? 'Text message — use {salon}, {first_name}' : 'Email body — use {salon}, {first_name}'} />
                    )}
                    {s.channel === 'call' && (
                      <BranchEditor step={s} open={!!openBranches[i]} onToggle={() => setOpenBranches((o) => ({ ...o, [i]: !o[i] }))} onSet={(k, a) => setBranch(i, k, a)} />
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button className="btn add-step" onClick={addStep}>+ Add step</button>
            <div className="cad-hint">Merge tags: <b>{'{salon}'}</b> and <b>{'{first_name}'}</b> fill in per lead. Flow runs the call/text/email steps in order (wait steps are for scheduling and skipped in a live session).</div>
          </div>
        ) : (
          <div className="cad-edit"><div className="muted" style={{ padding: 24 }}>Select or create a cadence to edit.</div></div>
        )}
      </div>
    </section>
  );
}

// ── Keypad (type-a-number dialer) ───────────────────────────────────────────
function Keypad({ r }: { r: R }) {
  const [num, setNum] = useState('');
  const [mode, setMode] = useState<'idle' | 'calling' | 'text'>('idle');
  const [status, setStatus] = useState('');
  const [secs, setSecs] = useState(0);
  const [body, setBody] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const callRef = useRef<any>(null);

  const digits = num.replace(/[^0-9]/g, '');
  const ready = digits.length >= 10;
  const match = ready ? r.matchLeadByNumber(num) : undefined;

  useEffect(() => {
    if (mode !== 'calling') return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  const press = (d: string) => { if (mode === 'idle') setNum((n) => (n + d).slice(0, 18)); };
  const back = () => setNum((n) => n.slice(0, -1));

  const endCall = () => { callRef.current?.disconnect?.(); callRef.current = null; r.logDial('call', num); setMode('idle'); setStatus(''); setSecs(0); };

  const call = async () => {
    if (!ready) return;
    setMode('calling'); setStatus('Connecting…'); setSecs(0);
    const c = await placeCall(num);
    if (c) {
      callRef.current = c;
      c.on('accept', () => setStatus('Connected'));
      c.on('disconnect', () => endCall());
      c.on('cancel', () => endCall());
      c.on('error', (e: any) => { console.error(e); setStatus('Call error'); });
    } else {
      // Voice not configured — log the attempt so the number still lands in history.
      setStatus('Voice not configured'); setTimeout(() => endCall(), 1200);
    }
  };

  const openText = () => { setBody(match?.contact ? renderTemplate(DEFAULT_SMS, match) : ''); setMode('text'); };
  const sendText = () => { if (!body.trim()) return; r.sendKeypadText(num, body.trim()); setMode('idle'); setBody(''); };

  const doSave = async () => { await r.saveNumberAsLead(num, saveName); setSaveOpen(false); setSaveName(''); };

  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

  return (
    <section className="view on">
      <div className="keypad-wrap">
        <div className="keypad-card">
          <div className="kp-display">
            <input className="kp-num" value={num} onChange={(e) => setNum(e.target.value.replace(/[^0-9+*#]/g, '').slice(0, 18))} placeholder="Enter a number" />
            {num && mode === 'idle' && <button className="kp-back" onClick={back} title="Delete">⌫</button>}
          </div>
          <div className="kp-match">
            {match ? <span className="kp-hit">✓ {match.salon}{match.city ? ` · ${match.city}` : ''}</span>
              : ready ? <span className="kp-new">New number — not in your leads</span>
              : <span className="muted">&nbsp;</span>}
          </div>

          {mode === 'calling' ? (
            <div className="kp-live">
              <div className="kp-live-status"><span className="p" /> {status} · {mm}:{ss}</div>
              <div className="kp-live-num">{num}</div>
              <button className="kp-end" onClick={endCall}>End call</button>
            </div>
          ) : mode === 'text' ? (
            <div className="kp-text">
              <div className="kp-text-to">Text to {match ? match.salon : num}</div>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type your message…" autoFocus />
              <div className="kp-text-actions">
                <button className="btn sm" onClick={() => setMode('idle')}>Cancel</button>
                <button className="btn primary sm" onClick={sendText} disabled={!body.trim()}>Send text</button>
              </div>
            </div>
          ) : (
            <>
              <div className="kp-grid">
                {keys.map(([d, sub]) => (
                  <button key={d} className="kp-key" onClick={() => press(d)}>
                    <span className="kd">{d}</span>{sub && <span className="ks">{sub}</span>}
                  </button>
                ))}
              </div>
              <div className="kp-actions">
                <button className="kp-call" onClick={call} disabled={!ready} title={ready ? 'Call' : 'Enter a full number'}>{Icon.call} Call</button>
                <button className="kp-textbtn" onClick={openText} disabled={!ready}>{Icon.text} Text</button>
              </div>
              <div className="kp-save">
                {match ? (
                  <button className="btn sm" onClick={() => { r.setActiveLeadId(match.id); r.setView('dialer'); }}>Open {match.salon} →</button>
                ) : saveOpen ? (
                  <div className="kp-save-row">
                    <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Salon / name" autoFocus />
                    <button className="btn primary sm" onClick={doSave} disabled={!ready}>Save lead</button>
                    <button className="btn sm" onClick={() => setSaveOpen(false)}>×</button>
                  </div>
                ) : (
                  <button className="btn sm" onClick={() => setSaveOpen(true)} disabled={!ready}>+ Save as lead</button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="kp-recent">
          <div className="kp-recent-h">Recent</div>
          {r.recentDials.length === 0 && <div className="muted" style={{ padding: '10px 4px' }}>Calls &amp; texts you make here show up in this list.</div>}
          {r.recentDials.map((d) => (
            <button key={d.id} className="kp-recent-li" onClick={() => setNum(d.number)}>
              <span className="kr-ic">{d.kind === 'call' ? Icon.call : Icon.text}</span>
              <span className="kr-body"><span className="kr-num">{d.salon || d.number}</span><span className="kr-sub">{d.salon ? d.number : (d.kind === 'call' ? 'Call' : 'Text')} · {d.time}</span></span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Floating dial button (global quick-dial keypad) ─────────────────────────
function FloatingDialer({ r }: { r: R }) {
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState('');
  const [mode, setMode] = useState<'idle' | 'calling' | 'text'>('idle');
  const [status, setStatus] = useState('');
  const [secs, setSecs] = useState(0);
  const [body, setBody] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const callRef = useRef<any>(null);

  const digits = num.replace(/[^0-9]/g, '');
  const ready = digits.length >= 10;
  const match = ready ? r.matchLeadByNumber(num) : undefined;

  useEffect(() => {
    if (mode !== 'calling') return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [mode]);

  // Hide on the full Keypad view (redundant) and while a call panel is up.
  if (r.view === 'keypad' || r.activeCall) return null;

  const press = (d: string) => setNum((n) => (n + d).slice(0, 18));
  const back = () => setNum((n) => n.slice(0, -1));
  const endCall = () => { callRef.current?.disconnect?.(); callRef.current = null; r.logDial('call', num); setMode('idle'); setStatus(''); setSecs(0); };
  const call = async () => {
    if (!ready) return;
    setMode('calling'); setStatus('Connecting…'); setSecs(0);
    const c = await placeCall(num);
    if (c) {
      callRef.current = c;
      c.on('accept', () => setStatus('Connected'));
      c.on('disconnect', () => endCall());
      c.on('cancel', () => endCall());
      c.on('error', (e: any) => { console.error(e); setStatus('Call error'); });
    } else { setStatus('Voice not configured'); setTimeout(() => endCall(), 1200); }
  };
  const openText = () => { setBody(match?.contact ? renderTemplate(DEFAULT_SMS, match) : ''); setMode('text'); };
  const sendText = () => { if (!body.trim()) return; r.sendKeypadText(num, body.trim()); setMode('idle'); setBody(''); setNum(''); };
  const doSave = async () => { await r.saveNumberAsLead(num, saveName); setSaveOpen(false); setSaveName(''); setOpen(false); };
  const close = () => { if (mode === 'calling') return; setOpen(false); setMode('idle'); };

  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

  return (
    <>
      {open && (
        <div className="fdial-pop">
          <div className="fdial-ph"><span>{Icon.call} Quick dial</span><button className="fdial-x" onClick={close}>×</button></div>
          <div className="fdial-kp">
            <div className="kp-display">
              <input className="kp-num" value={num} onChange={(e) => setNum(e.target.value.replace(/[^0-9+*#]/g, '').slice(0, 18))} placeholder="Enter a number" />
              {num && mode === 'idle' && <button className="kp-back" onClick={back}>⌫</button>}
            </div>
            <div className="kp-match">
              {match ? <span className="kp-hit">✓ {match.salon}</span> : ready ? <span className="kp-new">New number</span> : <span className="muted">&nbsp;</span>}
            </div>
            {mode === 'calling' ? (
              <div className="kp-live">
                <div className="kp-live-status"><span className="p" /> {status} · {mm}:{ss}</div>
                <div className="kp-live-num">{num}</div>
                <button className="kp-end" onClick={endCall}>End call</button>
              </div>
            ) : mode === 'text' ? (
              <div className="kp-text">
                <div className="kp-text-to">Text to {match ? match.salon : num}</div>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type your message…" autoFocus />
                <div className="kp-text-actions">
                  <button className="btn sm" onClick={() => setMode('idle')}>Cancel</button>
                  <button className="btn primary sm" onClick={sendText} disabled={!body.trim()}>Send text</button>
                </div>
              </div>
            ) : (
              <>
                <div className="kp-grid">
                  {keys.map(([d, sub]) => (
                    <button key={d} className="kp-key" onClick={() => press(d)}><span className="kd">{d}</span>{sub && <span className="ks">{sub}</span>}</button>
                  ))}
                </div>
                <div className="kp-actions">
                  <button className="kp-call" onClick={call} disabled={!ready}>{Icon.call} Call</button>
                  <button className="kp-textbtn" onClick={openText} disabled={!ready}>{Icon.text} Text</button>
                </div>
                <div className="kp-save">
                  {match ? (
                    <button className="btn sm" onClick={() => { r.setActiveLeadId(match.id); r.setView('dialer'); setOpen(false); }}>Open {match.salon} →</button>
                  ) : saveOpen ? (
                    <div className="kp-save-row">
                      <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Salon / name" autoFocus />
                      <button className="btn primary sm" onClick={doSave} disabled={!ready}>Save</button>
                      <button className="btn sm" onClick={() => setSaveOpen(false)}>×</button>
                    </div>
                  ) : (
                    <button className="btn sm" onClick={() => setSaveOpen(true)} disabled={!ready}>+ Save as lead</button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <button className={`fdial-fab ${open ? 'on' : ''}`} onClick={() => (open ? close() : setOpen(true))} title="Dial a number" aria-label="Dial a number">
        {open ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M6 6l12 12M18 6L6 18" /></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7" cy="6" r="1.3" /><circle cx="12" cy="6" r="1.3" /><circle cx="17" cy="6" r="1.3" /><circle cx="7" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="17" cy="12" r="1.3" /><circle cx="7" cy="18" r="1.3" /><circle cx="12" cy="18" r="1.3" /><circle cx="17" cy="18" r="1.3" /></svg>}
      </button>
    </>
  );
}
