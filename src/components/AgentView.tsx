'use client';
import { useEffect, useState } from 'react';
import type { useRelay } from '@/hooks/useRelay';
import type { Lead } from '@/lib/types';

// Eryn — the AI cold caller. Two pieces:
//   <AgentView>        her screen: shift controls, the live call, today's numbers,
//                      her list, and every call she's made with the transcript.
//   <AgentCallButton>  the "Eryn" action on a lead card: what she'll know, then dial.
// Rules live server-side (src/lib/agent-server.ts); this is the window onto them.
type R = ReturnType<typeof useRelay>;

const OUT: Record<string, { label: string; cls: string }> = {
  answered_interested: { label: 'Interested', cls: 'ok' },
  callback: { label: 'Callback', cls: 'ok' },
  gatekeeper: { label: 'Front desk', cls: 'warn' },
  not_interested: { label: 'Not interested', cls: 'dim' },
  wrong_icp: { label: 'Not a salon', cls: 'dim' },
  dnc: { label: 'Stop', cls: 'bad' },
  voicemail: { label: 'Voicemail', cls: 'dim' },
  no_answer: { label: 'No answer', cls: 'dim' },
  unknown: { label: 'Ended', cls: 'dim' },
};
const fmtDur = (s?: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const ago = (iso?: string) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : new Date(iso).toLocaleDateString();
};
function useNow(ms = 1000) { const [, set] = useState(0); useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]); }

export function ErynMark({ size = 22 }: { size?: number }) {
  return <span className="eryn-mark" style={{ width: size, height: size, fontSize: size * 0.5 }}>E</span>;
}

// ── her screen ───────────────────────────────────────────────────────────────
export function AgentView({ r }: { r: R }) {
  const s = r.agentStatus;
  const [cap, setCap] = useState(60);
  const [open, setOpen] = useState<string | null>(null);
  useNow();
  useEffect(() => { r.refreshAgent(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const shift = s?.shift;
  const live = s?.live && ['queued', 'ringing', 'in_progress'].includes(s.live.status) ? s.live : null;
  const running = shift?.status === 'running';
  const mine = r.leads.filter((l) => l.owner === 'agent' && l.deployed !== false && !l.dnc);
  const liveSecs = live ? Math.max(0, Math.round((Date.now() - new Date(live.started_at).getTime()) / 1000)) : 0;

  return (
    <section className="view on agent-view">
      <div className="page-head">
        <div><h1><ErynMark size={30} /> Eryn</h1><p>Cold calls only. Instagram leads and anyone who ever answered stay with you.</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!shift || shift.status === 'done' ? (
            <>
              <label className="cap-lbl">Cap <input type="number" min={1} max={200} value={cap} onChange={(e) => setCap(Number(e.target.value) || 60)} /></label>
              <button className="btn primary eryn-btn" onClick={() => r.agentShift('start', cap)} disabled={!s || s.queue === 0}>{s?.queue === 0 ? 'Her list is empty' : `Start Eryn's shift`}</button>
            </>
          ) : running ? (
            <><button className="btn" onClick={() => r.agentShift('pause')}>Pause after this call</button><button className="btn" onClick={() => r.agentShift('stop')}>End shift</button></>
          ) : (
            <><button className="btn primary eryn-btn" onClick={() => r.agentShift('resume')}>Resume</button><button className="btn" onClick={() => r.agentShift('stop')}>End shift</button></>
          )}
        </div>
      </div>
      {r.agentError && <div className="agent-err">{r.agentError}</div>}
      {shift?.status === 'paused' && shift.paused_note && <div className="agent-note">Paused itself: {shift.paused_note}</div>}
      {!r.enabled && <div className="agent-note">Demo mode — this is what the screen looks like mid-shift.</div>}

      <div className="agent-grid">
        <div className="agent-col">
          <div className="card agent-live">
            {live ? (
              <>
                <div className="al-ring"><ErynMark size={56} /></div>
                <div className="al-title">{live.leads?.salon || 'Dialing…'}</div>
                <div className="al-sub">{live.status === 'in_progress' ? 'connected' : live.status === 'ringing' ? 'ringing' : 'placing the call'} · {fmtDur(liveSecs)}{live.leads?.city ? ` · ${live.leads.city}` : ''}</div>
                <div className="al-hint">The transcript, outcome, and any text she promised land on the timeline the moment the call ends.</div>
              </>
            ) : (
              <>
                <div className="al-ring idle"><ErynMark size={56} /></div>
                <div className="al-title">{running ? 'Between calls' : shift?.status === 'paused' ? 'Paused' : 'Off shift'}</div>
                <div className="al-sub">{running ? 'next dial within a minute, during her local 10–4' : `${s?.queue ?? mine.length} on her list`}</div>
              </>
            )}
          </div>
          <div className="agent-stats">
            <div><b>{s?.today.dials ?? 0}</b><span>dials today</span></div>
            <div><b>{s?.today.answered ?? 0}</b><span>answered</span></div>
            <div><b>{s?.today.voicemail ?? 0}</b><span>voicemail</span></div>
            <div className="hi"><b>{s?.today.interested ?? 0}</b><span>for you</span></div>
          </div>
          {shift && shift.status !== 'done' && (
            <div className="card agent-shift"><div className="h"><b>This shift</b><span>{shift.dials} / {shift.cap} dials</span></div><div className="prog"><i style={{ width: `${Math.min(100, (shift.dials / Math.max(1, shift.cap)) * 100)}%` }} /></div>
              <div className="rules">Her local 10a–4p · never Sunday · one call at a time · business lines only · one try a day, three total · "stop" = never again</div></div>
          )}
          <div className="card">
            <div className="h"><b>Her list</b><span>{mine.length}</span></div>
            {mine.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Select leads in Pipeline and choose “Give to Eryn”. Cold lists only — she'll hand back anything that turns out to be a cell phone.</div>}
            <div className="agent-list">
              {mine.slice(0, 12).map((l) => (
                <div key={l.id} className="agent-row" onClick={() => { r.setActiveLeadId(l.id); r.setView('dialer'); }}>
                  <div><div className="nm">{l.salon}</div><div className="mt">{l.city || '—'}{l.lineType ? ` · ${l.lineType}` : ''}{l.agentAttempts ? ` · try ${l.agentAttempts}` : ' · never called'}</div></div>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); r.setAgentOwnerMany([l.id], 'rep'); }}>Take back</button>
                </div>
              ))}
              {mine.length > 12 && <div className="muted" style={{ fontSize: 12 }}>+{mine.length - 12} more</div>}
            </div>
          </div>
        </div>

        <div className="agent-col">
          <div className="card">
            <div className="h"><b>Her calls</b><span>latest first</span></div>
            {(!s || s.recent.length === 0) && <div className="muted" style={{ fontSize: 12.5 }}>Nothing yet.</div>}
            <div className="agent-calls">
              {(s?.recent || []).map((c: any) => {
                const o = OUT[c.outcome] || OUT.unknown;
                const isOpen = open === c.id;
                return (
                  <div key={c.id} className={`agent-call ${isOpen ? 'open' : ''}`}>
                    <div className="ac-head" onClick={() => setOpen(isOpen ? null : c.id)}>
                      <span className={`ac-out ${o.cls}`}>{o.label}</span>
                      <span className="ac-salon">{c.leads?.salon || '—'}</span>
                      <span className="ac-meta">{fmtDur(c.duration_s)}{c.duration_s ? ' · ' : ''}{ago(c.ended_at)}</span>
                    </div>
                    {c.summary && <div className="ac-sum">{c.summary}</div>}
                    {isOpen && (
                      <div className="ac-body">
                        {c.data && Object.values(c.data).some(Boolean) && (
                          <div className="ac-facts">{Object.entries(c.data).filter(([, v]) => v).map(([k, v]) => <span key={k}><i>{k.replace('_', ' ')}</i> {String(v)}</span>)}</div>
                        )}
                        {Array.isArray(c.transcript) && c.transcript.length > 0 ? (
                          <div className="ac-tx">{c.transcript.map((t: any, i: number) => <div key={i} className={t.role === 'agent' ? 'ai' : 'her'}><b>{t.role === 'agent' ? 'Eryn' : 'Her'}</b> {t.message}</div>)}</div>
                        ) : <div className="muted" style={{ fontSize: 12 }}>No transcript{c.error ? ` — ${c.error}` : ''}.</div>}
                        <div className="ac-actions">
                          {c.lead_id && <button className="btn sm" onClick={() => { r.setActiveLeadId(c.lead_id); r.setView('dialer'); }}>Open lead →</button>}
                          {c.conversation_id && <a className="btn sm" href={`https://elevenlabs.io/app/agents/history/${c.conversation_id}`} target="_blank" rel="noreferrer">Recording ↗</a>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── the button on a lead card ────────────────────────────────────────────────
export function AgentCallButton({ r, lead }: { r: R; lead: Lead }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const warm = lead.source === 'instagram';
  const first = lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name.split(' ')[0] : '';
  const dial = async (force?: boolean) => {
    setBusy(true); setMsg(null);
    const res = await r.agentCall(lead.id, force);
    setBusy(false);
    if (res.ok) { setMsg({ ok: true, text: `Eryn is dialing ${lead.salon}. Watch it on her screen; the outcome lands here when she hangs up.` }); }
    else setMsg({ ok: false, text: res.error || 'Could not start the call.' });
  };
  return (
    <>
      <button className="btn sm eryn-sm" title="Eryn (AI) calls this salon" onClick={() => { setOpen((v) => !v); setMsg(null); }} disabled={!lead.phone || lead.dnc}>
        <ErynMark size={16} /> Eryn
      </button>
      {open && (
        <div className="eryn-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="es-head"><ErynMark size={32} /><div><div className="es-title">Eryn calls {first || lead.salon}</div><div className="es-sub">AI cold call · ~2 min · from the Tally line</div></div><button className="es-x" onClick={() => setOpen(false)}>×</button></div>
          <div className="es-grp">What she'll know</div>
          <div className="es-kv">
            <span>salon</span><b>{lead.salon}</b>
            <span>first name</span><b>{first || <i>none — she asks for the owner</i>}</b>
            <span>city</span><b>{lead.city || <i>unknown</i>}</b>
            <span>booking</span><b>{lead.bookingSystem || <i>unknown</i>}</b>
            <span>line</span><b>{lead.lineType || <i>checked before she dials</i>}</b>
            <span>transfer to</span><b>{r.me?.forwardTo || r.me?.name || 'your cell'}</b>
          </div>
          {warm && <div className="es-warn">This is an Instagram lead — she came to us. Eryn's script is written for cold calls, so this one's really yours. You can still send her if you want.</div>}
          {lead.lineType === 'mobile' && <div className="es-warn">This number is a cell phone. Eryn only dials business lines; hand-dial this one.</div>}
          {msg && <div className={`es-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
          <div className="es-row">
            <button className="btn" onClick={() => setOpen(false)}>{msg?.ok ? 'Close' : 'Cancel'}</button>
            {!msg?.ok && <button className="btn primary eryn-btn" disabled={busy || lead.lineType === 'mobile'} onClick={() => dial(warm)}>{busy ? 'Dialing…' : 'Call now'}</button>}
          </div>
          {!msg?.ok && (lead.owner !== 'agent' ? <button className="es-link" onClick={() => r.setAgentOwnerMany([lead.id], 'agent')}>Or put her on Eryn's list for the next shift</button>
            : <button className="es-link" onClick={() => r.setAgentOwnerMany([lead.id], 'rep')}>On Eryn's list · take her back</button>)}
        </div>
      )}
    </>
  );
}
