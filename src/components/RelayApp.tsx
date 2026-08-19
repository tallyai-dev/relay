'use client';
import { useEffect, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import type { Lead } from '@/lib/types';
import { renderTemplate, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT } from '@/lib/cadence';
import { placeCall } from '@/lib/voice';

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
          {r.view === 'inbox' && <Inbox r={r} />}
          {(r.view === 'cadences' || r.view === 'reports' || r.view === 'mobile') && (
            <Placeholder view={r.view} />
          )}
        </div>
      </div>
      {importOpen && <ImportModal r={r} onClose={() => setImportOpen(false)} />}
      <IncomingBanner r={r} />
    </div>
  );
}

function ImportModal({ r, onClose }: { r: R; onClose: () => void }) {
  const [csv, setCsv] = useState('salon,city,phone,email,contact,role\nBella Salon,Denver CO,+13035550101,hi@bella.com,Ana,Owner');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [owner, setOwner] = useState<string>(r.me?.id || '');
  const isAdmin = r.me?.role === 'admin';
  const run = async () => {
    setBusy(true);
    const n = await r.importLeads(csv, owner || r.me?.id);
    setBusy(false); setDone(n);
  };
  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="mh"><h3>Import leads</h3>{!r.enabled && <span className="demo-flag" style={{ marginLeft: 6 }}>Demo mode — appends locally</span>}<button className="x" onClick={onClose}>×</button></div>
        <div className="mb import-body">
          {done === null ? (
            <>
              <div className="import-hint">Paste CSV or export from your list tool. Recognized columns: <b>salon, city, phone, email, contact, role</b> (header row optional).</div>
              <textarea value={csv} onChange={(e) => setCsv(e.target.value)} />
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
              <div><span className="import-count">{done}</span> leads imported{r.enabled ? ' to Supabase' : ' (demo)'}.</div>
            </div>
          )}
        </div>
        <div className="mf">
          {done === null ? (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={run} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
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
      {btn('dialer', 'Dialer', <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3-8.6A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z" />)}
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
      <button className="btn flowbtn" onClick={r.startFlow}>{Icon.flow}Flow Mode</button>
      {r.enabled && <button className="btn" onClick={r.signOut} title="Sign out">Sign out</button>}
    </div>
  );
}

function LeadsView({ r, onImport }: { r: R; onImport: () => void }) {
  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Salon prospecting — pipeline</h1><p>{r.leads.length} salons · working the “Cold Salon Outbound” cadence</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onImport}>{Icon.import}Import leads</button>
          <button className="btn primary flowbtn" onClick={r.startFlow}>{Icon.flow}Start Flow</button>
        </div>
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
                <td><span className="mode">{Icon.call} Call — {l.objection}</span></td>
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
function Inbox({ r }: { r: R }) {
  const [reply, setReply] = useState('');
  const byLead = new Map<string, typeof r.messages>();
  r.messages.forEach((m) => { if (!m.leadId) return; const a = byLead.get(m.leadId) || []; a.push(m); byLead.set(m.leadId, a); });
  const threads = [...byLead.entries()].map(([leadId, msgs]) => ({
    leadId, msgs, last: msgs[msgs.length - 1], unread: msgs.some((x) => x.direction === 'in' && !x.isRead),
  }));
  const sel = r.activeThreadLead;
  const selMsgs = sel ? byLead.get(sel) || [] : [];
  const selLead = sel ? r.leadById(sel) : undefined;

  return (
    <section className="view on" style={{ padding: 0 }}>
      <div className="inbox">
        <div className="inbox-list">
          <div className="inbox-lh"><h2>Inbox</h2><button className="btn sm" onClick={r.simInbound}>☎ Simulate returning call</button></div>
          {threads.map(({ leadId, last, unread }, i) => {
            const l = r.leadById(leadId); const who = l?.contact?.name && l.contact.name !== '—' ? l.contact.name : l?.salon;
            return (
              <div key={leadId} className={`thread ${unread ? 'unread' : ''} ${sel === leadId ? 'on' : ''}`} onClick={() => r.openThread(leadId)}>
                <div className="tav" style={{ background: colorFor(i) }}>{initials(who || '?')}
                  <span className="chn">{last.channel === 'email' ? Icon.email : Icon.text}</span></div>
                <div className="tbody">
                  <div className="trow"><span className="tnm">{who}</span><span className="ttime">{last.time}</span></div>
                  <div className="tsalon">{l?.salon}</div>
                  <div className="tprev">{last.body}</div>
                </div>
                {unread && <span className="udot" />}
              </div>
            );
          })}
        </div>
        <div className="inbox-conv">
          {!sel ? <div className="inbox-empty">Select a conversation</div> : (
            <>
              <div className="conv-head">
                <div className="cav" style={{ background: colorFor(threads.findIndex((t) => t.leadId === sel)) }}>{initials(selLead?.contact?.name && selLead.contact.name !== '—' ? selLead.contact.name : selLead?.salon || '?')}</div>
                <div><h3>{selLead?.contact?.name !== '—' ? selLead?.contact?.name : selLead?.salon} · {selLead?.salon}</h3><div className="cs">{selMsgs[selMsgs.length - 1]?.channel === 'email' ? 'Email' : 'Text'} · {selLead?.phone}</div></div>
                <div className="ca"><button className="btn sm" onClick={() => { r.setActiveLeadId(sel); r.setView('dialer'); }}>Open in dialer</button></div>
              </div>
              <div className="conv-msgs">
                {selMsgs.map((m) => (
                  <div key={m.id} className={`cmsg ${m.direction === 'out' ? 'me' : 'them'}`}>
                    <div className="meta">{m.direction === 'out' ? 'You' : selLead?.contact?.name || 'Them'} · {m.channel} · {m.time}</div>
                    <div className="bub">{m.subject && <div className="subj">{m.subject}</div>}{m.body}</div>
                  </div>
                ))}
              </div>
              <div className="conv-reply">
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (reply.trim()) { r.sendReply(sel, reply.trim()); setReply(''); } } }} />
                <button className="btn primary send" onClick={() => { if (reply.trim()) { r.sendReply(sel, reply.trim()); setReply(''); } }}>Send</button>
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
              <button className="btn sm flowbtn" onClick={r.startFlow}>Start Flow</button></div>
          )}

          <div className="lead-head">
            <div className="avatar big" style={{ background: colorFor(idx) }}>{initials(lead.salon)}</div>
            <div><h2>{lead.salon}</h2><div className="meta">{lead.contact?.name === '—' ? lead.contact?.role : `${lead.contact?.name} · ${lead.contact?.role}`} · {lead.city}</div></div>
            <div className="r"><span className={`pill ${stagePill[lead.stage]}`}><span className="dot" style={{ background: 'currentColor' }} />{stageLabel[lead.stage]}</span></div>
          </div>

          {inFlow ? <FlowBar r={r} lead={lead} /> : (
            <div className="task-strip"><div className="cb" /><div className="t">Call — {lead.objection}</div>
              <div className="chip amber">Due today</div>
              <div className="o"><button className="btn sm primary" onClick={r.startFlow}>Start Flow</button></div></div>
          )}

          <div className="qgrid">
            <div className="qc"><div className="qk">Phone</div><div className="qv">{lead.phone}</div></div>
            <div className="qc"><div className="qk">Cadence</div><div className="qv">Cold Salon · {lead.cadencePos + 1}/5</div></div>
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
          <button onClick={() => r.flowConnected('quote')}><span className="k">3</span>Quote</button>
          <button className="bad" onClick={() => r.flowConnected('not_interested')}><span className="k">4</span>Not interested</button>
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
  const [body, setBody] = useState(renderTemplate(DEFAULT_SMS, lead));
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
  const [subj, setSubj] = useState(renderTemplate(DEFAULT_EMAIL_SUBJECT, lead));
  const [body, setBody] = useState(renderTemplate(DEFAULT_EMAIL_BODY, lead));
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
