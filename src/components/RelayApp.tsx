'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentView, AgentCallButton, ErynMark } from '@/components/AgentView';
import { useRelay, isOverdue, type EnrichResult, EnrichCandidate } from '@/hooks/useRelay';
import type { Lead, Cadence, CadenceStep, Channel, DispositionKey, BranchAction, Branches, Stage, Activity } from '@/lib/types';
import { renderTemplate, DEFAULT_SMS, DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, DISPOSITIONS, branchFor, describeBranch, dmOpen, resolveChannel, IG_DM } from '@/lib/cadence';
import { enablePush, pushState, type PushState } from '@/lib/push';
import { placeCall, normalizePhone } from '@/lib/voice';
import { openCalendly, CALENDLY_URL } from '@/lib/calendly';
import { TEXT_TEMPLATES, PRODUCT_TEMPLATES, EMAIL_TEMPLATES_LIB, renderTpl } from '@/lib/templates';
import { analyzeImport } from '@/lib/csv';
import { fetchActivityFeed, type FeedActivity } from '@/lib/repo';
import { BoltMark } from '@/components/Logo';

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
  const [newLeadOpen, setNewLeadOpen] = useState(false);
  const [reportsRep, setReportsRep] = useState(''); // '' = everyone (admin)
  // Shared from Instagram/TikTok (PWA share target) → open Add prefilled.
  useEffect(() => { if (r.shareIntent) setNewLeadOpen(true); }, [r.shareIntent]);
  return (
    <div className="app">
      <Rail r={r} onNewLead={() => setNewLeadOpen(true)} />
      <div className="main">
        <TopBar r={r} onImport={() => setImportOpen(true)} />
        <div className="content">
          {r.view === 'leads' && <LeadsView r={r} onImport={() => setImportOpen(true)} onNewLead={() => setNewLeadOpen(true)} />}
          {r.view === 'staging' && r.isAdmin && <StagingView r={r} onImport={() => setImportOpen(true)} />}
          {r.view === 'enrich' && <EnrichView r={r} />}
          {r.view === 'dialer' && <Dialer r={r} />}
          {r.view === 'inbox' && <Inbox r={r} />}
          {r.view === 'cadences' && <CadenceBuilder r={r} />}
          {r.view === 'agent' && <AgentView r={r} />}
          {r.view === 'team' && <TeamView r={r} onViewActivity={(id) => { setReportsRep(id); r.setView('reports'); }} />}
          {r.view === 'reports' && <ReportsView r={r} repFilter={reportsRep} setRepFilter={setReportsRep} />}
        </div>
      </div>
      {importOpen && <ImportModal r={r} onClose={() => setImportOpen(false)} />}
      {newLeadOpen && <NewLeadModal r={r} prefill={r.shareIntent || undefined} onClose={() => { setNewLeadOpen(false); r.clearShareIntent(); }} />}
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

// Normalize an Instagram handle or profile URL to { user, handle, url, valid }.
const IG_USER_RE = /^[A-Za-z0-9._]{1,30}$/;
function parseHandle(input: string): { user: string; handle: string; url: string; valid: boolean } {
  let u = (input || '').trim();
  u = u.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '').replace(/^@+/, '');
  const valid = IG_USER_RE.test(u);
  return { user: u, handle: u ? '@' + u : '', url: u ? 'https://instagram.com/' + u : '', valid };
}

// When Google isn't sure which listing is the salon, show the top matches and
// let a human pick instead of taking the first one.
function CandidatePicker({ candidates, busy, onPick, onNone }: { candidates: EnrichCandidate[]; busy?: boolean; onPick: (placeId: string) => void; onNone?: () => void }) {
  return (
    <div className="cand-wrap">
      <div className="cand-h">Google isn&apos;t sure which one — pick the right listing</div>
      {candidates.map((c) => (
        <button key={c.placeId} type="button" className="cand" disabled={busy} onClick={() => onPick(c.placeId)}>
          <span className="cand-nm">{c.name}</span>
          <span className="cand-mt">{[c.address, c.phone, c.website].filter(Boolean).join(' · ') || 'no details on the listing'}</span>
        </button>
      ))}
      {onNone && <button type="button" className="btn sm" disabled={busy} onClick={onNone} style={{ alignSelf: 'flex-start' }}>None of these</button>}
    </div>
  );
}

interface PullPreview { igFound: boolean; sure?: boolean; candidates?: EnrichCandidate[]; handle: string; name?: string; bio?: string; followers?: number; posts?: number; profilePic?: string; website?: string; phone?: string; email?: string; bookingSystem?: string; city?: string; placesName?: string }
// "Is this her?" — what Pull from Instagram found, before it fills the form.
function PullPreviewCard({ p, onYes, onNo, onPick, busy }: { p: PullPreview; onYes: () => void; onNo: () => void; onPick: (placeId: string) => void; busy?: boolean }) {
  const initials = (p.name || p.handle).replace(/^@/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const facts = [p.phone, p.website, p.bookingSystem, p.city].filter(Boolean);
  return (
    <div className="pull-card">
      <div className="pull-top">
        {p.profilePic ? <img className="pull-av" src={p.profilePic} alt="" referrerPolicy="no-referrer" /> : <div className="pull-av pull-av-txt">{initials}</div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pull-nm">{p.name || p.placesName || p.handle}</div>
          <div className="pull-mt">{p.handle}{p.followers != null ? ` · ${p.followers.toLocaleString()} followers` : ''}{p.posts != null ? ` · ${p.posts} posts` : ''}</div>
          {p.bio && <div className="pull-bio">{p.bio}</div>}
          {!p.igFound && <div className="pull-warn">Instagram gave nothing back — personal account, or Meta isn&apos;t connected yet. {p.placesName ? 'This is the closest Google listing:' : 'Fill it in by hand.'}</div>}
          {facts.length > 0 && <div className="pull-facts">{facts.map((f, i) => <span key={i}>{f}</span>)}</div>}
        </div>
      </div>
      {p.sure === false && p.candidates && p.candidates.length > 0 ? (
        <CandidatePicker candidates={p.candidates} busy={busy} onPick={onPick} onNone={onYes} />
      ) : (
        <div className="pull-q"><span>Is this her?</span>
          <button type="button" className="btn sm" onClick={onNo}>Not her</button>
          <button type="button" className="btn sm primary" onClick={onYes}>Yes, use this</button>
        </div>
      )}
    </div>
  );
}

// Create a lead by hand. An Instagram handle is verified (valid format), linked
// (opens the live profile to confirm), and tags the lead source=instagram so the
// avatar badge shows.
function NewLeadModal({ r, onClose, prefill }: { r: R; onClose: () => void; prefill?: { platform: 'instagram' | 'tiktok' | null; handle: string; text: string; url: string } }) {
  const [salon, setSalon] = useState('');
  const [name, setName] = useState('');
  const [ig, setIg] = useState(prefill?.platform !== 'tiktok' && prefill?.handle ? '@' + prefill.handle : '');
  const [notes, setNotes] = useState(prefill?.text && !/^https?:/i.test(prefill.text) ? prefill.text : '');
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string | null>(null);
  // What the pull found, held for a yes/no before it touches the form.
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [booking, setBooking] = useState('');
  const [city, setCity] = useState('');
  const [cadenceId, setCadenceId] = useState('');
  const [busy, setBusy] = useState(false);
  const h = parseHandle(ig);
  const canSave = !!(salon.trim() || h.handle) && (!ig.trim() || h.valid);
  const save = async () => {
    setBusy(true);
    await r.addLead({ salon: salon.trim() || h.handle, contactName: name, handle: h.user, phone, email, website, bookingSystem: booking, city, cadenceId: cadenceId || undefined, notes: notes.trim() || undefined });
    setBusy(false); onClose();
  };
  // Pull the public profile (name, pic, bio, site) + phone/booking off the
  // site — into a preview card first, so you confirm it's her before anything
  // lands in the form.
  const pull = async (placeId?: string) => {
    if (!h.valid) return;
    setPulling(true); setPullMsg(null); if (!placeId) setPreview(null);
    try {
      const res = await fetch('/api/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: h.user, salon: salon.trim() || undefined, city: city.trim() || undefined, placeId }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.found) { setPullMsg(j.error || 'Nothing found for that handle yet — fill it in by hand.'); return; }
      setPreview({ igFound: !!j.igFound, sure: j.sure !== false, candidates: j.candidates, handle: j.handle || h.handle, name: j.igName || j.name, bio: j.bio, followers: j.followers, posts: j.posts, profilePic: j.profilePic, website: j.website, phone: j.phone, email: j.email, bookingSystem: j.bookingSystem, city: j.city, placesName: j.name });
    } catch { setPullMsg('Lookup failed.'); }
    finally { setPulling(false); }
  };
  const acceptPreview = () => {
    if (!preview) return;
    const got: string[] = [];
    const nm = preview.name || preview.placesName;
    if (nm && !salon.trim()) { setSalon(nm); got.push('name'); }
    if (preview.phone && !phone.trim()) { setPhone(preview.phone); got.push('phone'); }
    if (preview.email && !email.trim()) { setEmail(preview.email); got.push('email'); }
    if (preview.website && !website.trim()) { setWebsite(String(preview.website).replace(/^https?:\/\//, '').replace(/\/$/, '')); got.push('website'); }
    if (preview.bookingSystem && !booking.trim()) { setBooking(preview.bookingSystem); got.push('booking'); }
    if (preview.city && !city.trim()) { setCity(preview.city); got.push('city'); }
    setPullMsg(got.length ? `✓ Pulled ${got.join(', ')}` : 'Confirmed — nothing new to add.');
    setPreview(null);
  };
  const rejectPreview = () => { setPreview(null); setPullMsg('Not her — check the handle and pull again, or fill it in by hand.'); };
  const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, background: 'var(--panel)', color: 'var(--ink)' };
  const field = (label: string, val: string, set: (v: string) => void, ph = '', type = 'text') => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink3)' }}>{label}</span>
      <input style={inputStyle} type={type} value={val} placeholder={ph} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="mh"><h3>{prefill ? (prefill.platform === 'tiktok' ? 'Add to Relay · from TikTok' : 'Add to Relay · from Instagram') : 'New lead'}</h3><button className="x" onClick={onClose}>×</button></div>
        <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink3)' }}>Instagram</span>
            <input style={inputStyle} value={ig} placeholder="@handle or instagram.com/handle" onChange={(e) => setIg(e.target.value)} />
            {ig.trim() && (h.valid
              ? <span style={{ fontSize: 12, color: '#2f855a', display: 'inline-flex', alignItems: 'center', gap: 6 }}>✓ Linked <b>{h.handle}</b> — <a href={h.url} target="_blank" rel="noreferrer" style={{ color: '#2f855a', fontWeight: 600 }}>open to verify ↗</a></span>
              : <span style={{ fontSize: 12, color: '#c0503f' }}>Not a valid Instagram handle yet</span>)}
            {h.valid && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <button type="button" className="btn sm" disabled={pulling} onClick={() => pull()} title="Business name, website, phone and booking system from the public profile + link in bio">{pulling ? 'Pulling…' : '✨ Pull from Instagram'}</button>
                {pullMsg && <span style={{ fontSize: 12, color: pullMsg.startsWith('✓') ? '#2f855a' : 'var(--ink3)' }}>{pullMsg}</span>}
              </div>
            )}
          </label>
          {preview && <PullPreviewCard p={preview} onYes={acceptPreview} onNo={rejectPreview} busy={pulling} onPick={(id) => pull(id)} />}
          {(prefill?.platform === 'tiktok' && prefill.handle) && <div style={{ fontSize: 12, color: 'var(--ink2)' }}>TikTok <b>@{prefill.handle}</b> — TikTok has no DM API, so Relay keeps the handle in the notes and works her by call/text.</div>}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink3)' }}>Their ask (comment / DM · optional)</span>
            <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={notes} placeholder="Paste what she said — it lands on the timeline as her words" onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {field('Business / salon', salon, setSalon, h.handle ? `defaults to ${h.handle}` : 'Salon name')}
            {field('Contact name', name, setName, 'Owner / manager')}
            {field('Phone', phone, setPhone, '(801) 555-0123', 'tel')}
            {field('Email', email, setEmail, 'name@salon.com', 'email')}
            {field('Website', website, setWebsite, 'salon.com')}
            {field('Booking system', booking, setBooking, 'Vagaro, Boulevard\u2026')}
            {field('City', city, setCity, 'City, ST')}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink3)' }}>Cadence</span>
              <select style={inputStyle} value={cadenceId} onChange={(e) => setCadenceId(e.target.value)}>
                <option value="">Default</option>
                {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="mf">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canSave || busy} onClick={save}>{busy ? 'Adding\u2026' : 'Add lead & open'}</button>
        </div>
      </div>
    </div>
  );
}

// Small Instagram badge dropped on the corner of a lead avatar when the lead
// came from Instagram (source === 'instagram').
function IgBadge({ size = 15 }: { size?: number }) {
  return (
    <span title="From Instagram" style={{ position: 'absolute', right: -3, bottom: -3, width: size, height: size, borderRadius: Math.round(size * 0.33), background: 'linear-gradient(105deg,#F58529,#DD2A7B,#8134AF,#515BD4)', border: '2px solid var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} fill="none" stroke="#fff" strokeWidth={2.4}><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1.3" fill="#fff" /></svg>
    </span>
  );
}

function ImportModal({ r, onClose }: { r: R; onClose: () => void }) {
  const [csv, setCsv] = useState('salon,city,phone,email,contact,role\nBella Salon,Denver CO,(303) 555-0101,hi@bella.com,Ana,Owner');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [igRes, setIgRes] = useState<{ deployed: number; staged: number; total: number } | null>(null);
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
  const igMode = !!analysis?.detected.find((d) => d.field === 'Instagram');

  const run = async () => {
    setBusy(true);
    if (igMode) {
      const res = await r.importInstagramRows(readyRows, owner || r.me?.id);
      setBusy(false); setIgRes(res); setDone(res.total);
    } else {
      const n = await r.importCleanRows(readyRows, owner || r.me?.id);
      setBusy(false); setDone(n);
    }
  };

  const rowsToShow = analysis ? (showAll ? analysis.rows : analysis.rows.slice(0, 8)) : [];

  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="mh"><h3>Import leads</h3>{!r.enabled && <span className="demo-flag" style={{ marginLeft: 6 }}>Demo mode — appends locally</span>}<button className="x" onClick={onClose}>×</button></div>
        <div className="mb import-body">
          {done === null ? (
            <>
              {igMode && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px', borderRadius: 12, marginBottom: 12, background: 'linear-gradient(105deg,#fbeaf3,#efeaf9)', border: '1px solid #f0d5e6' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, background: 'linear-gradient(105deg,#F58529,#DD2A7B,#8134AF,#515BD4)' }} />
                  <div style={{ fontSize: 12, color: '#5a3550', lineHeight: 1.5 }}>
                    <b>Instagram warm import.</b> These get <b>source = instagram</b> and start on the <b>Instagram — warm demo</b> cadence. Salons you can reach (phone or email) go live now; ones with no contact yet wait under <b>Needs enrichment</b>. The first text is a draft you send from Flow — nothing auto-sends.
                  </div>
                </div>
              )}
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
              {igMode && igRes ? (
                <div><span className="import-count">{igRes.deployed}</span> warm lead{igRes.deployed === 1 ? '' : 's'} live on the <b>Instagram — warm demo</b> cadence{igRes.staged > 0 ? <> · <b>{igRes.staged}</b> with no contact yet waiting under <b>Needs enrichment</b></> : ''}. First texts are drafts — send them from Flow.</div>
              ) : (
                <div><span className="import-count">{done}</span> leads added to <b>staging</b>{r.enabled ? '' : ' (demo)'}. Duplicates and blanks were skipped. Deploy them into a cadence from the Staging tab when you’re ready to call.</div>
              )}
            </div>
          )}
        </div>
        <div className="mf">
          {done === null ? (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={run} disabled={busy || readyRows.length === 0}>{busy ? 'Importing…' : igMode ? `Add ${readyRows.length} Instagram lead${readyRows.length === 1 ? '' : 's'}` : `Import ${readyRows.length} new lead${readyRows.length === 1 ? '' : 's'}`}</button>
            </>
          ) : (
            <button className="btn primary" onClick={() => { r.setView(igMode ? 'leads' : 'staging'); onClose(); }}>{igMode ? 'Go to leads →' : 'Go to staging →'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Rail({ r, onNewLead }: { r: R; onNewLead: () => void }) {
  const btn = (v: R['view'], label: string, path: React.ReactNode, short?: string) => (
    <button className={r.view === v ? 'on' : ''} title={label} onClick={() => r.setView(v)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{path}</svg>
      <span className="rail-lbl">{short || label}</span>
    </button>
  );
  return (
    <nav className="rail">
      <div className="logo"><BoltMark size={42} tight /></div>
      {btn('dialer', 'Workspace', <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3-8.6A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z" />, 'Dialer')}
      <button className={r.view === 'inbox' ? 'on' : ''} title="Inbox" onClick={() => r.setView('inbox')} style={{ position: 'relative' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M4 9h5l2 3h2l2-3h5" /></svg>
        {r.unreadCount > 0 && <span className="badge">{r.unreadCount}</span>}
        <span className="rail-lbl">Inbox</span>
      </button>
      {btn('leads', 'Pipeline', <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />, 'Leads')}
      {r.isAdmin && btn('staging', 'Staging', <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />)}
      {btn('enrich', 'Enrich', <path d="M13 3l2.3 6.2L22 11.5l-6.7 2.3L13 20l-2.3-6.2L4 11.5l6.7-2.3zM5 3v3M3.5 4.5h3" />)}
      <button className="rail-add" title="Add a lead" onClick={onNewLead}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
        <span className="rail-lbl">Add</span>
      </button>
      <button className={r.view === 'agent' ? 'on' : ''} title="Eryn — AI cold caller" onClick={() => r.setView('agent')}>
        <ErynMark size={22} />
        <span className="rail-lbl">Eryn</span>
      </button>
      {btn('cadences', 'Cadences', <path d="M3 12h4l3 8 4-16 3 8h4" />, 'Cadence')}
      {btn('reports', 'Reports', <path d="M3 3v18h18M8 15v3M13 9v9M18 5v13" />)}
      {r.isAdmin && btn('team', 'Team', <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8" />)}
      <div className="spacer" />
      <div className="me" title={r.me?.name || 'You'}>{r.me ? initials(r.me.name) : 'SB'}</div>
    </nav>
  );
}

function RemindersButton({ r }: { r: R }) {
  const [state, setState] = useState<PushState>('unsupported');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { pushState().then(setState); }, []);
  if (!r.enabled || !r.me || state === 'unsupported' || state === 'unavailable' || state === 'on') return null;
  const go = async () => {
    const res = await enablePush(r.me!.id);
    if (res.ok) setState('on'); else { setMsg(res.error || 'Could not turn on reminders.'); setTimeout(() => setMsg(null), 6000); }
  };
  return (
    <>
      {msg && <span className="demo-flag" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}>{msg}</span>}
      <button className="btn tb-push" onClick={go} title={state === 'blocked' ? 'Notifications are blocked for Relay in this browser' : 'Get a buzz on this phone 5 min before every callback'} disabled={state === 'blocked'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></svg><span className="lbl">Reminders</span>
      </button>
    </>
  );
}

function TopBar({ r, onImport }: { r: R; onImport: () => void }) {
  const s = r.stats;
  return (
    <div className="topbar">
      <div><div className="title">{r.view === 'dialer' ? 'Dialer session' : r.view === 'agent' ? 'Eryn · AI cold calls' : r.view[0].toUpperCase() + r.view.slice(1)}</div></div>
      <div className="metrics">
        <span className="metrics-day" title="Counts reset at midnight">Today</span>
        <div className="metric"><span>Dials</span><b>{s.dials}</b></div>
        <div className="metric" title="Calls where you reached a person"><span>Convos</span><b>{s.conversations}</b></div>
        <div className="metric"><span>Voicemails</span><b>{s.voicemails}</b></div>
        <div className="metric"><span>Texts</span><b>{s.texts}</b></div>
        <div className="metric"><span>Emails</span><b>{s.emails}</b></div>
        <div className="metric goal"><span>Demos</span><b>{s.demos}</b><span className="g">/10</span></div>
      </div>
      <div className="grow" />
      {!r.enabled && <span className="demo-flag" title="No Supabase configured — running on local demo data">Demo mode</span>}
      {r.enabled && r.me && <span className="demo-flag" style={{ background: r.me.role === 'admin' ? 'var(--accent-soft)' : '#eef2f8', color: r.me.role === 'admin' ? 'var(--accent-ink)' : 'var(--ink2)' }} title={r.me.email}>{r.me.name} · {r.me.role}</span>}
      {r.isAdmin && r.reps.length > 1 && (
        <select className={`book-sel ${r.book !== 'mine' ? 'away' : ''}`} value={r.book} onChange={(e) => r.setBook(e.target.value)} title="Whose book the pipeline and queue show">
          <option value="mine">My book</option>
          {r.reps.filter((rp) => rp.id !== r.me?.id).map((rp) => <option key={rp.id} value={rp.id}>{rp.name}’s book</option>)}
          <option value="all">Everyone</option>
        </select>
      )}
      <RemindersButton r={r} />
      <button className="btn tb-import" onClick={onImport}>{Icon.import}<span className="lbl">Import leads</span></button>
      <button className="btn flowbtn" onClick={() => r.startFlow()}>{Icon.flow}<span className="lbl">Flow Mode</span></button>
      {r.enabled && <button className="btn tb-signout" onClick={r.signOut} title="Sign out"><span className="lbl">Sign out</span></button>}
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

function LeadsView({ r, onImport, onNewLead }: { r: R; onImport: () => void; onNewLead: () => void }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [booking, setBooking] = useState('all');
  const [due, setDue] = useState('all');
  const [owner, setOwner] = useState('all');
  const [needsEnrich, setNeedsEnrich] = useState(false);
  const repName = (id?: string) => r.reps.find((x) => x.id === id)?.name;

  const bookingOpts = Array.from(new Set(r.activeLeads.map((l) => l.bookingSystem).filter(Boolean))).sort() as string[];
  const dueSet = new Set(r.dueLeads.map((l) => l.id));
  const schedSet = new Set(r.scheduledLeads.map((l) => l.id));

  const filteredRaw = r.activeLeads.filter((l) => {
    if (q) {
      const s = q.trim().toLowerCase();
      const digits = s.replace(/\D/g, '');
      const hay = [l.salon, l.city, l.contact?.name, l.email, l.handle, l.phone].map((x) => (x || '').toLowerCase());
      const phoneDigits = (l.phone || '').replace(/\D/g, '');
      const hit = hay.some((h) => h.includes(s)) || (!!digits && phoneDigits.includes(digits));
      if (!hit) return false;
    }
    if (stage !== 'all' && l.stage !== stage) return false;
    if (booking === 'none') { if (l.bookingSystem) return false; }
    else if (booking !== 'all' && l.bookingSystem !== booking) return false;
    if (due === 'due' && !dueSet.has(l.id)) return false;
    if (due === 'sched' && !schedSet.has(l.id)) return false;
    if (owner === 'none') { if (l.ownerRepId) return false; }
    else if (owner !== 'all' && l.ownerRepId !== owner) return false;
    if (needsEnrich && l.phone && l.email && l.website && l.bookingSystem) return false;
    return true;
  });
  // Pin Instagram warm leads to the top so a fresh batch doesn't get buried
  // under the older book (leads otherwise load oldest-first).
  const filtered = filteredRaw.slice().sort((a, b) => Number(b.source === 'instagram') - Number(a.source === 'instagram'));

  const anyFilter = !!q || stage !== 'all' || booking !== 'all' || due !== 'all' || owner !== 'all' || needsEnrich;
  const clearFilters = () => { setQ(''); setStage('all'); setBooking('all'); setDue('all'); setOwner('all'); setNeedsEnrich(false); };

  // Bulk selection → assign many leads to a cadence at once.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkCad, setBulkCad] = useState('');
  const allSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.id));
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) filtered.forEach((l) => next.delete(l.id));
    else filtered.forEach((l) => next.add(l.id));
    return next;
  });
  const toggleOne = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [bulkOwner, setBulkOwner] = useState('');
  const clearSel = () => setSelected(new Set());
  const doBulkAssign = () => { if (!bulkCad || !selected.size) return; r.assignCadenceMany([...selected], bulkCad); clearSel(); setBulkCad(''); };
  const doBulkOwner = () => { if (!bulkOwner || !selected.size) return; r.assignOwnerMany([...selected], bulkOwner === 'none' ? null : bulkOwner); clearSel(); setBulkOwner(''); };

  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Leads</h1><p>{r.activeLeads.length} active salons{r.isAdmin && r.stagedLeads.length > 0 ? <> · <a className="stage-link" onClick={() => r.setView('staging')}>{r.stagedLeads.length} waiting in staging →</a></> : ''}</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={onNewLead}>+ New lead</button>
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

      <div className="lead-filters">
        <input className="lf-search" placeholder="Search salon, city, contact, phone, or @handle…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="all">All stages</option>
          {(Object.keys(stageLabel) as (keyof typeof stageLabel)[]).map((s) => <option key={s} value={s}>{stageLabel[s]}</option>)}
        </select>
        <select value={booking} onChange={(e) => setBooking(e.target.value)}>
          <option value="all">All booking platforms</option>
          {bookingOpts.map((b) => <option key={b} value={b}>{b}</option>)}
          <option value="none">No booking / unknown</option>
        </select>
        <select value={due} onChange={(e) => setDue(e.target.value)}>
          <option value="all">Any time</option>
          <option value="due">Due today</option>
          <option value="sched">Scheduled</option>
        </select>
        {r.isAdmin && r.reps.length > 1 && (
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">All owners</option>
            <option value="none">Unassigned</option>
            {r.reps.map((rp) => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
          </select>
        )}
        <button className={`lf-toggle ${needsEnrich ? 'on' : ''}`} onClick={() => setNeedsEnrich((v) => !v)}>Needs enrichment</button>
        {anyFilter && <button className="lf-clear" onClick={clearFilters}>Clear</button>}
        <span className="lf-count">{filtered.length} of {r.activeLeads.length}</span>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-n">{selected.size} selected</span>
          <select value={bulkCad} onChange={(e) => setBulkCad(e.target.value)}>
            <option value="">Assign to cadence…</option>
            {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn sm primary" disabled={!bulkCad} onClick={doBulkAssign}>Assign cadence</button>
          {r.isAdmin && (
            <>
              <select value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)}>
                <option value="">Assign owner…</option>
                {r.reps.map((rp) => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
                <option value="none">Unassign</option>
              </select>
              <button className="btn sm primary" disabled={!bulkOwner} onClick={doBulkOwner}>Set owner</button>
            </>
          )}
          <button className="btn sm eryn-sm" title="Eryn (AI) works these on her next shift — cold lists only" onClick={() => { r.setAgentOwnerMany([...selected].filter((id) => r.leadById(id)?.source !== 'instagram'), 'agent'); clearSel(); }}><ErynMark size={14} /> Give to Eryn</button>
          <button className="btn sm" onClick={() => { r.setAgentOwnerMany([...selected], 'rep'); clearSel(); }}>Take back</button>
          <button className="btn sm" onClick={clearSel}>Clear selection</button>
          <span className="bulk-hint">Assigning a cadence starts them fresh at day 0, due now. Instagram leads never go to Eryn.</span>
        </div>
      )}

      <div className="table">
        <table>
          <thead><tr>
            <th className="ck"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all matching" /></th>
            <th>Salon</th><th>Owner / contact</th><th>Next step</th><th>Last touch</th><th>Stage</th><th />
          </tr></thead>
          <tbody>
            {filtered.map((l, i) => (
              <tr key={l.id} className={selected.has(l.id) ? 'row-sel' : ''} onClick={() => { r.setActiveLeadId(l.id); r.setView('dialer'); }} style={{ cursor: 'pointer' }}>
                <td className="ck" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} /></td>
                <td><div className="salon-cell"><div className="avatar" style={{ background: colorFor(i), position: 'relative', overflow: 'visible' }}>{initials(l.salon)}{l.source === 'instagram' && <IgBadge />}</div>
                  <div><div className="nm">{l.salon}{l.cadenceCompletedAt && <span className="row-done" title={`Completed ${l.cadenceCompletedName || 'cadence'} · ${fmtDate(l.cadenceCompletedAt)}`}>✓ Done</span>}{r.isAdmin && l.ownerRepId && <span className="row-owner" title="Assigned rep">{repName(l.ownerRepId)}</span>}{l.owner === 'agent' && <span className="row-owner eryn-chip" title="On Eryn's list">Eryn</span>}{l.dnc && <span className="row-owner dnc-chip" title="Asked us to stop">DNC</span>}</div><div className="loc">{l.city}{l.bookingSystem && <span className="row-book">{l.bookingSystem}</span>}</div></div></div></td>
                <td>{l.contact?.name === '—' ? <span className="muted">No name yet</span> : <div><div style={{ fontWeight: 600 }}>{l.contact?.name}</div><div className="loc">{l.contact?.role}</div></div>}</td>
                <td>{dueBadge(l) ? <span className="mode sched">{dueBadge(l)}</span> : <span className="mode">{Icon.call} Call — {l.objection}</span>}</td>
                <td className="muted">{l.lastTouch}</td>
                <td><span className={`pill ${stagePill[l.stage]}`}><span className="dot" style={{ background: 'currentColor' }} />{stageLabel[l.stage]}</span></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                    <button className="btn sm" disabled={!l.phone} title={l.phone ? `Call ${l.phone}` : 'No phone on file — add one first'}
                      onClick={() => r.startCall(l.id)}
                      style={l.phone ? { background: '#2f855a', borderColor: '#2f855a', color: '#fff' } : undefined}>{Icon.call} Call</button>
                    <select value="" title="Add to a cadence" onChange={(e) => { if (e.target.value) r.assignCadence(l.id, e.target.value); }}
                      style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '5px 7px', fontSize: 11.5, background: 'var(--panel)', color: 'var(--ink)' }}>
                      <option value="">Cadence…</option>
                      {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button className="btn sm" onClick={() => { r.setActiveLeadId(l.id); r.setView('dialer'); }}>Open →</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.activeLeads.length === 0 && (
          <div className="empty-active">
            <div className="ea-title">No active leads yet</div>
            <div className="ea-sub">{r.stagedLeads.length > 0 ? `You have ${r.stagedLeads.length} leads waiting in staging.` : 'Import some leads to get started.'}</div>
            {r.isAdmin && r.stagedLeads.length > 0
              ? <button className="btn primary" onClick={() => r.setView('staging')}>Go to staging →</button>
              : <button className="btn primary" onClick={onImport}>{Icon.import}Import leads</button>}
          </div>
        )}
        {r.activeLeads.length > 0 && filtered.length === 0 && (
          <div className="empty-active">
            <div className="ea-title">No leads match these filters</div>
            <div className="ea-sub">Try loosening a filter or clearing them.</div>
            <button className="btn primary" onClick={clearFilters}>Clear filters</button>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Staging pool + Deploy slider ──────────────────────────────────────────────
function StagingView({ r, onImport }: { r: R; onImport: () => void }) {
  const pool = r.stagedLeads.length;
  const [amount, setAmount] = useState(25);
  const [cadenceId, setCadenceId] = useState(r.cadences[0]?.id || '');
  const [assignTo, setAssignTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const amt = Math.min(amount, pool);
  const cad = r.cadences.find((c) => c.id === cadenceId) || r.cadences[0];
  const roster = r.reps.filter((rp) => rp.active !== false);
  const assignee = assignTo || r.me?.id || '';
  const assigneeName = (id: string) => (id === r.me?.id ? 'you' : r.reps.find((rp) => rp.id === id)?.name || 'them');

  const deploy = async () => {
    if (amt <= 0 || !cad) return;
    setBusy(true);
    const n = await r.deployLeads(amt, cad.id, assignee || undefined);
    setBusy(false);
    setFlash(`Deployed ${n} lead${n === 1 ? '' : 's'} into “${cad.name}” — assigned to ${assigneeName(assignee)}.`);
    setTimeout(() => setFlash(null), 4000);
  };

  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Staging</h1><p>Imported leads wait here until you deploy them into a cadence.</p></div>
        <button className="btn" onClick={onImport}>{Icon.import}Import leads</button>
      </div>

      {flash && <div className="deploy-flash">✓ {flash}</div>}

      <div className="stage-wrap">
        <div className="stage-deploy">
          <div className="pool-big"><span className="n">{pool}</span><span className="lbl">leads waiting in staging</span></div>
          {pool === 0 ? (
            <div className="stage-empty">Nothing staged right now. Imported CSVs land here so you can deploy them in batches on your call days.</div>
          ) : (
            <>
              <div className="fld">
                <label>Into cadence</label>
                <select value={cadenceId} onChange={(e) => setCadenceId(e.target.value)}>
                  {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {roster.length > 0 && (
                <div className="fld">
                  <label>Assign to</label>
                  <select value={assignee} onChange={(e) => setAssignTo(e.target.value)}>
                    {roster.map((rp) => (
                      <option key={rp.id} value={rp.id}>{rp.name}{rp.id === r.me?.id ? ' (you)' : ''}{rp.role === 'admin' ? ' · admin' : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="fld">
                <label>How many to deploy</label>
                <div className="amt-row">
                  <button className="amt-btn" onClick={() => setAmount((a) => Math.max(1, a - 5))}>–</button>
                  <div className="amt-val">{amt}</div>
                  <button className="amt-btn" onClick={() => setAmount((a) => Math.min(pool, a + 5))}>+</button>
                  <div className="amt-quick">
                    {[10, 25, 50].filter((n) => n <= pool).map((n) => (
                      <button key={n} className={amount === n ? 'on' : ''} onClick={() => setAmount(n)}>{n}</button>
                    ))}
                    <button className={amount >= pool ? 'on' : ''} onClick={() => setAmount(pool)}>All {pool}</button>
                  </div>
                </div>
                <input className="amt-slider" type="range" min={1} max={pool} value={amt} onChange={(e) => setAmount(Number(e.target.value))} />
              </div>
              <button className="btn primary deploy-cta" onClick={deploy} disabled={busy || amt <= 0}>
                {Icon.flow}{busy ? 'Deploying…' : `Deploy ${amt} into ${cad?.name || 'cadence'}`}
              </button>
              <div className="deploy-stat">
                <span className="chip b">{r.activeLeads.length} active</span>
                <span className="chip a">{r.dueLeads.length} due today</span>
                <span className="chip n">{pool} staged</span>
              </div>
            </>
          )}
        </div>

        <div className="stage-list">
          <div className="sl-head">Waiting in staging {pool > 0 && <span>{pool}</span>}</div>
          {pool === 0 ? <div className="muted" style={{ padding: 16 }}>Empty — imported leads will appear here.</div> : (
            <div className="sl-rows">
              {r.stagedLeads.slice(0, 60).map((l, i) => (
                <div key={l.id} className="sl-row">
                  <div className="avatar sm" style={{ background: colorFor(i), position: 'relative', overflow: 'visible' }}>{initials(l.salon)}{l.source === 'instagram' && <IgBadge size={14} />}</div>
                  <div className="sl-nm"><div className="nm">{l.salon}</div><div className="loc">{l.city || '—'}{l.phone ? ` · ${l.phone}` : ''}</div></div>
                  {i < amt && <span className="sl-next">next ↑</span>}
                </div>
              ))}
              {pool > 60 && <div className="muted" style={{ padding: '10px 14px' }}>+ {pool - 60} more</div>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Lead enrichment (Google Places) ──────────────────────────────────────────
function EnrichView({ r }: { r: R }) {
  const leads = r.enrichableLeads;
  const [sel, setSel] = useState<string | null>(leads[0]?.id || null);
  const [results, setResults] = useState<Record<string, EnrichResult | 'loading'>>({});
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<string | null>(null);

  const selLead = sel ? r.leadById(sel) : undefined;
  const selRes = sel ? results[sel] : undefined;

  const runOne = async (id: string) => {
    setResults((p) => ({ ...p, [id]: 'loading' }));
    const res = await r.enrichLead(id);
    setResults((p) => ({ ...p, [id]: res }));
    return res;
  };
  // Auto-look-up the selected lead the first time it's opened.
  useEffect(() => { if (sel && results[sel] === undefined) runOne(sel); /* eslint-disable-next-line */ }, [sel]);

  // Only offer fields that are actually missing / new on the lead.
  const newFields = (lead: Lead | undefined, res: EnrichResult) => {
    const f: { phone?: string; email?: string; city?: string; website?: string; bookingSystem?: string } = {};
    if (res.phone && !lead?.phone) f.phone = res.phone;
    if (res.email && !lead?.email) f.email = res.email;
    if (res.website && !lead?.website) f.website = res.website;
    if (res.bookingSystem && !lead?.bookingSystem) f.bookingSystem = res.bookingSystem;
    if (res.city && !lead?.city) f.city = res.city;
    return f;
  };

  const acceptSel = () => {
    if (!sel || !selLead || !selRes || selRes === 'loading' || !selRes.found) return;
    r.saveEnrichment(sel, newFields(selLead, selRes));
    setSaved((p) => new Set(p).add(sel));
  };

  const enrichAll = async () => {
    const todo = leads.filter((l) => !saved.has(l.id));
    let filled = 0; let needPick = 0;
    for (const l of todo) {
      setBulk(`Looking up ${l.salon}…`);
      const res = results[l.id] && results[l.id] !== 'loading' ? (results[l.id] as EnrichResult) : await runOne(l.id);
      if (res.found && res.sure === false) { needPick++; continue; }
      if (res.found) {
        const f = newFields(l, res);
        if (Object.keys(f).length) { r.saveEnrichment(l.id, f); filled++; }
        setSaved((p) => new Set(p).add(l.id));
      }
    }
    setBulk(`Done — filled info on ${filled} lead${filled === 1 ? '' : 's'}.${needPick ? ` ${needPick} need${needPick === 1 ? 's' : ''} you to pick the right listing.` : ''}`);
    setTimeout(() => setBulk(null), 5000);
  };

  const missChips = (l: Lead) => (
    <span className="miss">
      {!l.phone && <span className="mchip">No phone</span>}
      {!l.email && <span className="mchip">No email</span>}
      {!l.website && <span className="mchip">No website</span>}
      {!l.bookingSystem && <span className="mchip">No booking</span>}
    </span>
  );

  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Enrich leads</h1><p>{leads.length} lead{leads.length === 1 ? '' : 's'} missing phone, email, website, or booking · filled from Google &amp; the salon’s site</p></div>
        {leads.length > 0 && <button className="btn primary" onClick={enrichAll}>✨ Enrich all {leads.length}</button>}
      </div>
      {bulk && <div className="deploy-flash">{bulk}</div>}

      {leads.length === 0 ? (
        <div className="empty-active"><div className="ea-title">Every lead has its basics 🎉</div><div className="ea-sub">Nothing to enrich — all your leads have a phone and website.</div></div>
      ) : (
        <div className="enr-wrap">
          <div className="enr-list">
            {leads.map((l, i) => (
              <div key={l.id} className={`enr-row ${sel === l.id ? 'on' : ''}`} onClick={() => setSel(l.id)}>
                <div className="avatar sm" style={{ background: colorFor(i), position: 'relative', overflow: 'visible' }}>{initials(l.salon)}{l.source === 'instagram' && <IgBadge size={14} />}</div>
                <div className="enr-nm"><div className="nm">{l.salon}</div><div className="loc">{l.city || '—'}</div></div>
                {saved.has(l.id) ? <span className="mchip ok">Enriched ✓</span> : (results[l.id] && results[l.id] !== 'loading' && (results[l.id] as EnrichResult).sure === false) ? <span className="mchip pick">Pick listing</span> : missChips(l)}
                <DeleteLeadButton r={r} leadId={l.id} label="✕" armedLabel="Delete?" className="enr-del" title={`Delete ${l.salon}`} after={() => { if (sel === l.id) { const rest = leads.filter((x) => x.id !== l.id); setSel(rest[0]?.id || null); } }} />
              </div>
            ))}
          </div>

          <div className="enr-panel">
            {!selLead ? <div className="muted" style={{ padding: 18 }}>Select a lead.</div> : (
              <>
                <div className="enr-pt">Found for {selLead.salon}</div>
                {selRes === 'loading' || selRes === undefined ? (
                  <div className="enr-loading">Looking up on Google Places…</div>
                ) : !selRes.found ? (
                  <div className="enr-none">No Google match found for “{selLead.salon}{selLead.city ? `, ${selLead.city}` : ''}”. Try adding a city, or fill it in manually.<button className="btn sm" style={{ marginTop: 12 }} onClick={() => runOne(selLead.id)}>Retry</button></div>
                ) : (
                  selRes.sure === false && selRes.candidates && selRes.candidates.length ? (
                    <CandidatePicker candidates={selRes.candidates} onPick={async (id) => { setResults((p) => ({ ...p, [sel!]: 'loading' })); const res = await r.enrichLead(sel!, id); setResults((p) => ({ ...p, [sel!]: res })); }} />
                  ) : (
                  <>
                    {selRes.phone && <div className="found"><span className="k">Phone</span><span className="v">{selRes.phone}</span>{selLead.phone ? <span className="src">on file</span> : <span className="tick">✓ new</span>}</div>}
                    {selRes.email && <div className="found"><span className="k">Email</span><span className="v">{selRes.email}</span>{selLead.email ? <span className="src">on file</span> : <span className="tick">✓ new</span>}</div>}
                    {selRes.website && <div className="found"><span className="k">Website</span><span className="v">{selRes.website}</span>{selLead.website ? <span className="src">on file</span> : <span className="tick">✓ new</span>}</div>}
                    {selRes.bookingSystem && <div className="found"><span className="k">Booking</span><span className="v"><span className="book-chip">{selRes.bookingSystem}</span></span>{selLead.bookingSystem ? <span className="src">on file</span> : <span className="tick">✓ new</span>}</div>}
                    {selRes.city && <div className="found"><span className="k">City</span><span className="v">{selRes.city}</span>{selLead.city ? <span className="src">on file</span> : <span className="tick">✓ new</span>}</div>}
                    {selRes.hours && <div className="found"><span className="k">Hours</span><span className="v" style={{ fontWeight: 400, fontSize: 12 }}>{selRes.hours[0]}{selRes.hours.length > 1 ? ` · +${selRes.hours.length - 1} more` : ''}</span></div>}
                    {selRes.address && <div className="found"><span className="k">Address</span><span className="v" style={{ fontWeight: 400, fontSize: 12 }}>{selRes.address}</span></div>}
                    <div className="enr-acc">
                      {saved.has(sel!) ? <span className="enr-done">✓ Saved</span> : (
                        Object.keys(newFields(selLead, selRes)).length
                          ? <button className="btn primary" onClick={acceptSel}>Accept &amp; save {Object.keys(newFields(selLead, selRes)).length} new field{Object.keys(newFields(selLead, selRes)).length === 1 ? '' : 's'}</button>
                          : <span className="muted">Nothing new to add — already complete.</span>
                      )}
                    </div>
                  </>
                  )
                )}
                {selRes !== 'loading' && selRes?.websiteSource && selRes.websiteSource !== 'places' && selRes.websiteSource !== 'instagram' && <div className="keynote" style={{ color: '#8a5a00' }}>Website came from a {selRes.websiteSource === 'guess' ? 'booking-site guess' : 'web search'}, not the Google listing — double-check it.</div>}
                <div className="keynote">Data from Google Places. When Google can’t tell which listing is the salon, Relay asks instead of guessing.</div>
                <div className="enr-delrow">
                  <DeleteLeadButton r={r} leadId={sel!} label="Delete this lead" after={() => { const rest = leads.filter((x) => x.id !== sel); setSel(rest[0]?.id || null); }} />
                  <span className="enr-delhint">No good match &amp; no info? Remove it.</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// Admin-only team management: add SDR logins, assign each a number, flip roles,
// deactivate. Lead assignment happens from the Pipeline's bulk bar.
function TeamView({ r, onViewActivity }: { r: R; onViewActivity: (repId: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);
  const [reset, setReset] = useState<{ id: string; sent?: string; link?: string } | null>(null);
  const [resetBusy, setResetBusy] = useState('');
  const [invited, setInvited] = useState(''); // email we auto-sent a set-password link to

  useEffect(() => { r.loadTeam(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Default reset = Supabase emails them a link directly. No copy-paste needed.
  const doReset = async (rp: { id: string; email?: string }) => {
    if (!rp.email) return;
    setResetBusy(rp.id); setReset(null); setErr('');
    const res = await r.emailPasswordReset(rp.email);
    setResetBusy('');
    if (!res.ok) { setErr(res.error || 'Could not send the reset email.'); return; }
    setReset({ id: rp.id, sent: rp.email });
  };

  // Fallback for when their email is being difficult: mint a link to send yourself.
  const doResetLink = async (rp: { id: string; email?: string }) => {
    if (!rp.email) return;
    setResetBusy(rp.id); setErr('');
    const res = await r.resetRepPassword(rp.email);
    setResetBusy('');
    if (!res.ok) { setErr(res.error || 'Could not create a reset link.'); return; }
    setReset({ id: rp.id, link: res.inviteLink || '' });
  };

  const add = async () => {
    setErr(''); setInvite(null); setInvited('');
    if (!email.trim()) { setErr('Enter an email.'); return; }
    setBusy(true);
    const em = email.trim();
    const res = await r.inviteRep(em, name.trim() || em, number.trim() || undefined);
    if (!res.ok) { setBusy(false); setErr(res.error || 'Could not add user.'); return; }
    // Email them their set-password link automatically; keep the copyable link too.
    const mail = await r.emailPasswordReset(em);
    setBusy(false);
    if (mail.ok) setInvited(em);
    setInvite({ email: em, link: res.inviteLink || '' });
    setEmail(''); setName(''); setNumber('');
  };

  return (
    <section className="view on">
      <div className="page-head"><div><h1>Team</h1><p>{r.reps.length} {r.reps.length === 1 ? 'member' : 'members'} · add an SDR, give them a number, then assign leads from the Pipeline.</p></div></div>

      <div className="block team-add">
        <div className="bt">Add a user</div>
        <div className="team-form">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Phone number (optional)" value={number} onChange={(e) => setNumber(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add user'}</button>
        </div>
        {err && <div className="team-err">{err}</div>}
        {invite && (
          <div className="team-invite">
            <div className="ti-head">✓ <b>{invite.email}</b> created.{invited === invite.email ? ' We emailed them a link to set their password.' : ' Send them this link to set their password:'}</div>
            <div className="ti-link">
              <input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(invite.link)}>Copy</button>
            </div>
            {invited === invite.email && <div className="ti-sub">Backup link above in case the email doesn’t land.</div>}
          </div>
        )}
      </div>

      <div className="team-list">
        {r.reps.map((rp) => (
          <div key={rp.id} className={`team-card ${rp.active === false ? 'inactive' : ''}`}>
            <div className="team-row">
              <div className="avatar ai team-av">{initials(rp.name)}</div>
              <div className="team-main">
                <div className="nm">{rp.name}{rp.id === r.me?.id && <span className="ti-you">you</span>}<span className={`role-badge ${rp.role}`}>{rp.role}</span></div>
                <div className="mt">{rp.email}</div>
              </div>
              <label className="team-num">Number
                <input defaultValue={rp.phoneNumber || ''} placeholder="+1…" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (rp.phoneNumber || '')) r.updateRep(rp.id, { phoneNumber: v }); }} />
              </label>
              <label className="team-num" title="The phone Relay rings for the cell bridge and for callbacks">Cell
                <input defaultValue={rp.forwardTo || ''} placeholder="+1 your cell" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (rp.forwardTo || '')) r.updateRep(rp.id, { forwardTo: v }); }} />
              </label>
              <label className="team-num" title="Bridge = Call rings your cell first, then dials her. App = the in-browser dialer.">Call via
                <select defaultValue={rp.callMode || 'bridge'} onChange={(e) => r.updateRep(rp.id, { callMode: e.target.value as 'bridge' | 'app' })}>
                  <option value="bridge">My cell (bridge)</option>
                  <option value="app">In-app dialer</option>
                </select>
              </label>
              <div className="team-leads"><b>{r.repLeadCounts[rp.id] || 0}</b><span>leads</span></div>
              <div className="team-actions">
                <button className="btn sm" onClick={() => onViewActivity(rp.id)}>Activity →</button>
                <button className="btn sm" disabled={resetBusy === rp.id} onClick={() => doReset(rp)}>{resetBusy === rp.id ? 'Linking…' : 'Reset password'}</button>
                {rp.id !== r.me?.id && (
                  <>
                    <button className="btn sm" onClick={() => r.updateRep(rp.id, { role: rp.role === 'admin' ? 'rep' : 'admin' })}>{rp.role === 'admin' ? 'Make rep' : 'Make admin'}</button>
                    <button className="btn sm" onClick={() => r.updateRep(rp.id, { active: rp.active === false })}>{rp.active === false ? 'Reactivate' : 'Deactivate'}</button>
                  </>
                )}
              </div>
            </div>
            {reset?.id === rp.id && (
              <div className="team-invite in-row">
                {reset.sent ? (
                  <div className="ti-head">✓ Reset email sent to <b>{reset.sent}</b> — the link inside lets them set a new password. Didn’t land? <a className="ti-alt" onClick={() => doResetLink(rp)}>Copy a link instead</a>.</div>
                ) : (
                  <>
                    <div className="ti-head">Send <b>{rp.name}</b> this link to reset their password:</div>
                    <div className="ti-link">
                      <input readOnly value={reset.link || ''} onFocus={(e) => e.currentTarget.select()} />
                      <button className="btn sm" onClick={() => navigator.clipboard?.writeText(reset.link || '')}>Copy</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Reports — who did what, filterable by rep ────────────────────────────────
const RP_RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
] as const;
type RpRange = (typeof RP_RANGES)[number]['id'];

function ReportsView({ r, repFilter, setRepFilter }: { r: R; repFilter: string; setRepFilter: (v: string) => void }) {
  const [range, setRange] = useState<RpRange>('7d');
  const [rows, setRows] = useState<FeedActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const days = RP_RANGES.find((x) => x.id === range)!.days;
  const scope = r.isAdmin ? repFilter : (r.me?.id || ''); // reps only ever see themselves
  const repName = (id?: string) => (id ? (r.reps.find((x) => x.id === id)?.name || '—') : '—');

  const sinceIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, [days]);

  useEffect(() => {
    if (!r.enabled) {
      // Demo mode — flatten the local per-lead activity map.
      const all: FeedActivity[] = Object.entries(r.activities).flatMap(([leadId, list]) =>
        (list || []).map((a) => ({ ...a, salon: r.leadById(leadId)?.salon })));
      setRows(all);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchActivityFeed(sinceIso, scope || undefined).then((data) => {
      if (!alive) return;
      setRows(data);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [r.enabled, sinceIso, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const stat = useMemo(() => {
    const s = { calls: 0, connects: 0, texts: 0, emails: 0, demos: 0, voicemails: 0, talkS: 0 };
    for (const a of rows) {
      if (a.kind === 'call') {
        s.calls++;
        if (a.disposition === 'connected' || a.disposition === 'booked') s.connects++;
        if (a.disposition === 'voicemail') s.voicemails++;
        if (a.durationS) s.talkS += a.durationS;
      }
      else if (a.kind === 'text' && a.direction !== 'in') s.texts++;
      else if (a.kind === 'email' && a.direction !== 'in') s.emails++;
      if (a.kind === 'book') s.demos++;
    }
    return s;
  }, [rows]);
  // Prospecting ratios — the numbers that tell you if the blitz is working.
  const connectRate = stat.calls ? Math.round((stat.connects / stat.calls) * 100) : 0;
  const dialsPerDemo = stat.demos ? (stat.calls / stat.demos).toFixed(1) : '—';
  const touchesPerDemo = stat.demos ? ((stat.calls + stat.texts + stat.emails) / stat.demos).toFixed(1) : '—';
  const talkTime = stat.talkS >= 3600
    ? `${Math.floor(stat.talkS / 3600)}h ${Math.round((stat.talkS % 3600) / 60)}m`
    : `${Math.round(stat.talkS / 60)}m`;

  const [kindFilter, setKindFilter] = useState<'all' | 'call' | 'text' | 'email' | 'book'>('all');
  const filtered = useMemo(() => (kindFilter === 'all' ? rows : rows.filter((a) => a.kind === kindFilter)), [rows, kindFilter]);
  const KIND_TABS = [
    { id: 'all', label: 'All' },
    { id: 'call', label: 'Calls' },
    { id: 'text', label: 'Texts' },
    { id: 'email', label: 'Emails' },
    { id: 'book', label: 'Demos' },
  ] as const;

  const chart = useMemo(() => {
    const buckets: { label: string; calls: number; msgs: number }[] = [];
    const idx = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      idx.set(d.toDateString(), buckets.length);
      buckets.push({ label: days <= 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : `${d.getMonth() + 1}/${d.getDate()}`, calls: 0, msgs: 0 });
    }
    for (const a of rows) {
      if (!a.at) continue;
      const i = idx.get(new Date(a.at).toDateString());
      if (i == null) continue;
      if (a.kind === 'call') buckets[i].calls++;
      else if (a.kind === 'text' || a.kind === 'email') buckets[i].msgs++;
    }
    const max = Math.max(1, ...buckets.map((b) => b.calls + b.msgs));
    return { buckets, max };
  }, [rows, days]);

  const icFor = (k: string) => (k === 'call' ? Icon.call : k === 'text' ? Icon.text : k === 'email' ? Icon.email : k === 'book' ? Icon.flow : Icon.text);

  return (
    <section className="view on">
      <div className="page-head">
        <div><h1>Reports</h1><p>{scope ? <>Activity for <b>{repName(scope)}</b></> : 'Activity across the whole team'} · last {days === 1 ? 'day' : `${days} days`}{loading ? ' · loading…' : ''}</p></div>
        <div className="rp-controls">
          {r.isAdmin && (
            <select className="rp-rep-sel" value={repFilter} onChange={(e) => setRepFilter(e.target.value)}>
              <option value="">Everyone</option>
              {r.reps.map((rp) => <option key={rp.id} value={rp.id}>{rp.name}{rp.id === r.me?.id ? ' (you)' : ''}</option>)}
            </select>
          )}
          <div className="rp-range">
            {RP_RANGES.map((x) => <button key={x.id} className={range === x.id ? 'on' : ''} onClick={() => setRange(x.id)}>{x.label}</button>)}
          </div>
        </div>
      </div>

      <div className="rp-stats">
        <div className="rp-stat"><span className="n">{stat.calls}</span><span className="l">Calls</span></div>
        <div className="rp-stat"><span className="n">{stat.connects}</span><span className="l">Connects</span></div>
        <div className="rp-stat"><span className="n">{stat.texts}</span><span className="l">Texts</span></div>
        <div className="rp-stat"><span className="n">{stat.emails}</span><span className="l">Emails</span></div>
        <div className="rp-stat hot"><span className="n">{stat.demos}</span><span className="l">Demos booked</span></div>
      </div>
      <div className="rp-stats rp-kpis">
        <div className="rp-stat"><span className="n">{connectRate}%</span><span className="l">Connect rate</span></div>
        <div className="rp-stat"><span className="n">{dialsPerDemo}</span><span className="l">Calls per demo set</span></div>
        <div className="rp-stat"><span className="n">{touchesPerDemo}</span><span className="l">Touches per demo set</span></div>
        <div className="rp-stat"><span className="n">{stat.voicemails}</span><span className="l">Voicemails left</span></div>
        <div className="rp-stat"><span className="n">{talkTime}</span><span className="l">Talk time</span></div>
      </div>

      {days > 1 && (
        <div className="block rp-chart-block">
          <div className="bt">Daily activity <span className="rp-legend"><i className="c" /> calls <i className="m" /> texts + emails</span></div>
          <div className="rp-chart">
            {chart.buckets.map((b, i) => (
              <div key={i} className="rp-col" title={`${b.label}: ${b.calls} calls, ${b.msgs} messages`}>
                <div className="rp-bars">
                  <div className="bar m" style={{ height: `${(b.msgs / chart.max) * 100}%` }} />
                  <div className="bar c" style={{ height: `${(b.calls / chart.max) * 100}%` }} />
                </div>
                <div className="rp-lbl">{b.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="block rp-feed-block">
        <div className="bt rp-feed-head">
          <span>Activity feed {filtered.length > 0 && <span className="rp-count">{filtered.length}</span>}</span>
          <div className="rp-kind">
            {KIND_TABS.map((t) => (
              <button key={t.id} className={kindFilter === t.id ? 'on' : ''} onClick={() => setKindFilter(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>{loading ? 'Loading…' : kindFilter === 'all' ? 'No activity in this window yet.' : `No ${KIND_TABS.find((t) => t.id === kindFilter)?.label.toLowerCase()} in this window.`}</div>
        ) : (
          <div className="rp-feed">
            {filtered.slice(0, 120).map((a) => (
              <div key={a.id} className="rp-row">
                <div className={`rp-ic k-${a.kind}`}>{icFor(a.kind)}</div>
                <div className="rp-main">
                  <div className="rp-top">
                    <b>{a.ty}</b>
                    {a.salon && <a className="rp-salon" onClick={() => { r.setActiveLeadId(a.leadId); r.setView('leads'); }}>{a.salon}</a>}
                    {!scope && r.isAdmin && a.repId && <span className="rp-who">{repName(a.repId)}</span>}
                    <span className="rp-when">{a.time}</span>
                  </div>
                  {(a.aiNote || a.ownNote || a.body) && <div className="rp-note">{a.aiNote || a.ownNote || a.body}</div>}
                  {a.recordingUrl && <audio className="rp-audio" controls preload="none" src={a.recordingUrl} />}
                </div>
              </div>
            ))}
            {filtered.length > 120 && <div className="muted" style={{ padding: '10px 14px' }}>Showing the latest 120 of {filtered.length}.</div>}
          </div>
        )}
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
                <span className={`chn ${t.last.channel === 'dm' ? 'dm' : ''}`}>{t.last.channel === 'email' ? Icon.email : t.last.channel === 'dm' ? IgGlyph : Icon.text}</span></div>
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
                <div><h3>{selT.name}{selT.lead ? ` · ${selT.lead.salon}` : ''}</h3><div className="cs">{selMsgs[selMsgs.length - 1]?.channel === 'email' ? 'Email' : selMsgs[selMsgs.length - 1]?.channel === 'dm' ? `Instagram DM${selT.lead && !dmOpen(selT.lead) ? ' · window closed, replies go by text' : ''}` : 'Text'} · {selT.lead?.handle ? `${selT.lead.handle} · ` : ''}{fmtPhone(selT.number)}</div></div>
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
// Two-step delete: first click arms it ("Confirm delete?"), second click removes
// the lead. Auto-disarms after a few seconds so a stray click never deletes.
function DeleteLeadButton({ r, leadId, label = 'Delete', armedLabel = 'Confirm delete?', className = 'btn sm danger', title = 'Delete this lead', after }: { r: R; leadId: string; label?: string; armedLabel?: string; className?: string; title?: string; after?: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(t); }, [armed]);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!armed) { setArmed(true); return; }
    r.deleteLead(leadId); after?.();
  };
  return <button className={`${className}${armed ? ' armed' : ''}`} onClick={onClick} title={title}>{armed ? armedLabel : label}</button>;
}

// On-the-spot enrichment button for the lead workspace. Looks the lead up on
// Google Places and auto-fills whatever's still missing.
function LeadEnrich({ r, lead }: { r: R; lead: Lead }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cands, setCands] = useState<EnrichCandidate[] | null>(null);
  const run = async (placeId?: string) => {
    setBusy(true); setMsg(null);
    const res = await r.enrichLead(lead.id, placeId);
    setBusy(false);
    if (!res.found) { setMsg('No Google match'); setTimeout(() => setMsg(null), 4000); return; }
    if (res.sure === false && res.candidates?.length) { setCands(res.candidates); return; }
    setCands(null);
    const f: { phone?: string; email?: string; city?: string; website?: string; bookingSystem?: string } = {};
    if (res.phone && !lead.phone) f.phone = res.phone;
    if (res.email && !lead.email) f.email = res.email;
    if (res.website && !lead.website) f.website = res.website;
    if (res.bookingSystem && !lead.bookingSystem) f.bookingSystem = res.bookingSystem;
    if (res.city && !lead.city) f.city = res.city;
    const keys = Object.keys(f);
    if (!keys.length) { setMsg('Already complete'); setTimeout(() => setMsg(null), 4000); return; }
    r.saveEnrichment(lead.id, f);
    setMsg(`✓ Added ${keys.map((k) => (k === 'bookingSystem' ? 'booking' : k)).join(', ')}`);
    setTimeout(() => setMsg(null), 6000);
  };
  return (
    <div className="lead-enrich" style={{ position: 'relative' }}>
      {msg && <span className="lead-enrich-msg">{msg}</span>}
      <button className="btn sm" onClick={() => run()} disabled={busy} title="Fill missing info from Google">{busy ? 'Enriching…' : '✨ Enrich'}</button>
      {cands && (
        <div className="cand-pop">
          <CandidatePicker candidates={cands} busy={busy} onPick={(id) => run(id)} onNone={() => { setCands(null); setMsg('Fill it in by hand'); setTimeout(() => setMsg(null), 4000); }} />
        </div>
      )}
    </div>
  );
}

// ── Compose a one-off email ───────────────────────────────────────────────────
// Opens a pre-filled draft in the rep's OWN mail app (mailto:), so a requested
// follow-up goes out from their real inbox, threads naturally, and lands in
// their Sent folder. Nothing is sent from Relay — the rep reviews and hits send
// themselves. Best deliverability, zero setup, right fit for warm/opt-in sends.
const EMAIL_SIGNOFF = 'Seth\nTally AI';
function firstName(lead: Lead): string {
  const n = lead.contact?.name;
  return n && n !== '—' ? n.split(' ')[0] : 'there';
}
type EmailTemplate = { key: string; label: string; subject: (l: Lead) => string; body: (l: Lead) => string };
const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    key: 'missed',
    label: 'Missed you (no connect)',
    subject: (l) => `Sorry I missed you — quick idea for ${l.salon}`,
    body: (l) => `Hi ${firstName(l)},

Tried giving ${l.salon} a call and just missed you — no worries.

Most salons lose a few bookings a week to calls that come in after hours or when the front desk is buried. Tally fixes that two ways: a missed-call text-back that instantly replies to callers with your booking link, and an AI voice receptionist that answers questions and books appointments straight into your calendar — you don't even have to change your phone system.

Want me to show you how it'd work for ${l.salon}? Grab 15 minutes here:
${CALENDLY_URL}

Thanks,
${EMAIL_SIGNOFF}`,
  },
  {
    key: 'referral',
    label: 'Stylist referral (email owner)',
    subject: (l) => `A quick idea for ${l.salon}`,
    body: (l) => `Hi there,

I spoke with someone on your team at ${l.salon} and they suggested I reach out to you directly.

Most salons lose a few bookings a week to calls that come in after hours or when the front desk is buried. Tally fixes that two ways: a missed-call text-back that instantly replies to callers with your booking link, and an AI voice receptionist that answers questions and books appointments straight into your calendar — you don't even have to change your phone system.

Worth a quick look? Grab 15 minutes here and I'll show you how it'd work for ${l.salon}:
${CALENDLY_URL}

Thanks,
${EMAIL_SIGNOFF}`,
  },
  {
    key: 'info',
    label: 'Info & pricing',
    subject: (l) => `Tally AI for ${l.salon}`,
    body: (l) => `Hi ${firstName(l)},

Great chatting just now — here's the quick rundown on what we talked about.

Tally sets up an AI receptionist for ${l.salon} that answers your missed and after-hours calls, books appointments straight into your calendar, and texts back anyone you can't get to — so you stop losing bookings when the front desk is slammed or closed.

Happy to get you set up whenever you're ready — just reply here.

Thanks,
${EMAIL_SIGNOFF}`,
  },
  {
    key: 'nice',
    label: 'Nice talking to you',
    subject: () => 'Following up',
    body: (l) => `Hi ${firstName(l)},

Really enjoyed talking with you today — wanted to get my info in your inbox so it's easy to find me.

Whenever you want to get ${l.salon} set up with the AI receptionist, just reply here and I'll take care of the rest.

Thanks,
${EMAIL_SIGNOFF}`,
  },
  {
    key: 'recap',
    label: 'Recap of our call',
    subject: () => 'Quick recap from our call',
    body: (l) => `Hi ${firstName(l)},

Quick recap of what we covered:

- AI receptionist answers missed & after-hours calls for ${l.salon}
- Books appointments and texts callers back automatically
- Works with your current number — no new hardware

I'll follow up soon, but reply anytime if you want to move forward.

Thanks,
${EMAIL_SIGNOFF}`,
  },
];

// The prospecting template library, as a sheet on the lead card. Texts send
// from here (edit, then send); emails and product emails open the composer
// prefilled. The Product tab is the pick-one flow after "spoke · wants info":
// pick the product she asked about → the "wants info" text goes now and the
// matching product email opens as a draft.
type TplTab = 'text' | 'email' | 'product';
function TemplatesSheet({ r, lead, tab: tab0 = 'text', onClose, onPickText }: { r: R; lead: Lead; tab?: TplTab; onClose: () => void; onPickText?: (body: string) => void }) {
  const [tab, setTab] = useState<TplTab>(tab0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [emailInit, setEmailInit] = useState<{ subject: string; body: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { lead, me: r.me, calendly: CALENDLY_URL };
  const norm = (x: string) => x.toLowerCase();
  const hit = (a: string, b?: string) => !q.trim() || norm(a).includes(norm(q)) || (b ? norm(b).includes(norm(q)) : false);
  const pickText = (key: string, tpl: string, product?: string) => {
    const rendered = renderTpl(tpl, { ...ctx, product });
    if (onPickText) { onPickText(rendered); onClose(); return; }
    setSel(key); setBody(rendered); setMsg(null);
  };
  const sendText = () => {
    if (!lead.phone || !body.trim()) return;
    r.sendReply(lead.id, body.trim(), 'text');
    setMsg('✓ Text sent'); setSel(null); setBody('');
  };
  const pickProduct = (p: typeof PRODUCT_TEMPLATES[number]) => {
    // Text now (if she has a phone), email as a draft to glance at.
    const info = TEXT_TEMPLATES.find((t) => t.key === 'info')!;
    if (lead.phone) { r.sendReply(lead.id, renderTpl(info.body, { ...ctx, product: p.product }), 'text'); setMsg(`✓ "Wants info" text sent · ${p.product} email drafted`); }
    else setMsg(`No phone on file — ${p.product} email drafted`);
    if (lead.email) setEmailInit({ subject: renderTpl(p.subject, ctx), body: renderTpl(p.body, ctx) });
    else setMsg((m) => `${m || ''} · no email on file, add one to send`);
  };
  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal tpl-modal" style={{ maxWidth: 560 }}>
        <div className="mh"><h3>Templates · {lead.salon}</h3><button className="x" onClick={onClose}>×</button></div>
        <div className="mb tpl-body">
          <div className="tpl-tabs">
            <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Texts</button>
            <button className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}>Emails</button>
            <button className={tab === 'product' ? 'on' : ''} onClick={() => setTab('product')}>Wants info · pick one</button>
          </div>
          {tab !== 'product' && <input className="tpl-search" value={q} placeholder="Search a moment — no answer, callback, robot, demo…" onChange={(e) => setQ(e.target.value)} />}
          {msg && <div className="tpl-msg">{msg}</div>}
          {tab === 'text' && (
            <div className="tpl-list">
              {!lead.phone && <div className="tpl-warn">No phone on file — pick one to copy the wording, or add her number first.</div>}
              {TEXT_TEMPLATES.filter((t) => hit(t.label, t.body)).map((t) => (
                <div key={t.key} className={`tpl-item ${sel === t.key ? 'on' : ''}`}>
                  <button className="tpl-head" onClick={() => pickText(t.key, t.body)}>
                    <span className="tpl-lab">{t.label}</span><span className="tpl-when">{t.when}</span>
                    <span className="tpl-prev">{renderTpl(t.body, ctx)}</span>
                  </button>
                  {sel === t.key && !onPickText && (
                    <div className="tpl-edit">
                      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
                      <div className="fb-actions">
                        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(body).catch(() => {}); setMsg('Copied'); }}>Copy</button>
                        <button className="btn sm" onClick={() => setSel(null)}>Cancel</button>
                        <button className="btn primary sm" disabled={!lead.phone || !body.trim()} style={{ background: 'var(--purple)', borderColor: 'var(--purple)' }} onClick={sendText}>Send text</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {tab === 'email' && (
            <div className="tpl-list">
              {!lead.email && <div className="tpl-warn">No email on file — enrich the lead or add one, then these open in the composer.</div>}
              {EMAIL_TEMPLATES_LIB.filter((t) => hit(t.label, t.body)).map((t) => (
                <div key={t.key} className="tpl-item">
                  <button className="tpl-head" onClick={() => lead.email ? setEmailInit({ subject: renderTpl(t.subject, ctx), body: renderTpl(t.body, ctx) }) : setMsg('Add an email address first.')}>
                    <span className="tpl-lab">{t.label}</span>{t.when && <span className="tpl-when">{t.when}</span>}
                    <span className="tpl-sub">{renderTpl(t.subject, ctx)}</span>
                    <span className="tpl-prev">{renderTpl(t.body, ctx).split('\n\n')[1] || renderTpl(t.body, ctx)}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {tab === 'product' && (
            <div className="tpl-list">
              <div className="tpl-note">She asked for more info. Pick what came up: the <b>&ldquo;wants info&rdquo;</b> text goes now{lead.phone ? ` to ${fmtPhone(lead.phone)}` : ' (no phone on file)'}, and the product email opens as a draft{lead.email ? ` for ${lead.email}` : ' (no email on file)'}.</div>
              {PRODUCT_TEMPLATES.map((p) => (
                <div key={p.key} className="tpl-item">
                  <button className="tpl-head" onClick={() => pickProduct(p)}>
                    <span className="tpl-lab">{p.product}</span><span className="tpl-when">{p.price}</span>
                    <span className="tpl-sub">{renderTpl(p.subject, ctx)}</span>
                    <span className="tpl-prev">{renderTpl(p.body, ctx).split('\n\n')[1]}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {emailInit && lead.email && <EmailComposer r={r} lead={lead} initial={emailInit} onClose={() => setEmailInit(null)} />}
      </div>
    </div>
  );
}

function TemplatesButton({ r, lead, tab }: { r: R; lead: Lead; tab?: TplTab }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Texts and emails for every prospecting moment">📄 Templates</button>
      {open && <TemplatesSheet r={r} lead={lead} tab={tab} onClose={() => setOpen(false)} />}
    </>
  );
}

function QuickEmail({ r, lead }: { r: R; lead: Lead }) {
  const [open, setOpen] = useState(false);
  const hasEmail = !!lead.email;
  return (
    <>
      <button className="btn sm" disabled={!hasEmail} onClick={() => setOpen(true)}
        title={hasEmail ? `Email ${lead.email}` : 'No email on file — enrich the lead first'}>✉ Email</button>
      {open && hasEmail && <EmailComposer r={r} lead={lead} onClose={() => setOpen(false)} />}
    </>
  );
}

// Opens the Calendly scheduler in a popup over Relay, prefilled with the salon.
// The booking syncs back via /api/calendly/webhook.
function BookDemo({ lead }: { lead: Lead }) {
  const name = lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name : lead.salon;
  return (
    <button className="btn sm book-demo" title="Book a demo — opens Calendly"
      onClick={() => openCalendly({ name, email: lead.email, leadId: lead.id })}>📅 Book demo</button>
  );
}

// In-app email composer: edit the subject/body (start from a template or blank)
// and send it via Gmail as sales@gettallyai.com. Logged to the lead + threaded
// into the Inbox; replies sync back. "Open in Gmail" is kept as a fallback.
function EmailComposer({ r, lead, onClose, initial }: { r: R; lead: Lead; onClose: () => void; initial?: { subject: string; body: string } }) {
  const [subject, setSubject] = useState(initial?.subject ?? EMAIL_TEMPLATES[0].subject(lead));
  const [body, setBody] = useState(initial?.body ?? EMAIL_TEMPLATES[0].body(lead));
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const apply = (t: EmailTemplate) => { setSubject(t.subject(lead)); setBody(t.body(lead)); };
  const ctx = { lead, me: r.me, calendly: CALENDLY_URL };
  const applyLib = (t: { subject: string; body: string }) => { setSubject(renderTpl(t.subject, ctx)); setBody(renderTpl(t.body, ctx)); };
  const send = async () => {
    setSending(true); setErr(null);
    const res = await r.sendLeadEmail(lead.id, subject, body);
    setSending(false);
    if (res.ok) onClose();
    else setErr(res.error || 'Send failed. Check the email setup.');
  };
  const openInGmail = () => {
    const url = `mailto:${encodeURIComponent(lead.email!)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const a = document.createElement('a'); a.href = url; a.click();
    onClose();
  };
  return (
    <div className="overlay on" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal email-modal" style={{ maxWidth: 620 }}>
        <div className="mh"><h3>Email {lead.salon}</h3><button className="x" onClick={onClose}>×</button></div>
        <div className="mb em-body-wrap">
          <div className="em-tofrom">To <b>{lead.email}</b> · from <b>sales@gettallyai.com</b></div>
          <div className="em-templates">
            <span className="em-tpl-label">Start from:</span>
            {EMAIL_TEMPLATES_LIB.map((t) => <button key={t.key} className="em-tpl" onClick={() => applyLib(t)} title={t.when}>{t.label}</button>)}
            {PRODUCT_TEMPLATES.map((t) => <button key={t.key} className="em-tpl prod" onClick={() => applyLib(t)} title={t.price}>{t.label}</button>)}
            {EMAIL_TEMPLATES.map((t) => <button key={t.key} className="em-tpl old" onClick={() => apply(t)}>{t.label}</button>)}
            <button className="em-tpl" onClick={() => { setSubject(''); setBody(''); }}>Blank</button>
          </div>
          <input className="em-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          <textarea className="em-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your email…" />
          {err && <div className="em-err">{err}</div>}
        </div>
        <div className="mf">
          <button className="btn sm" onClick={openInGmail} title="Open a draft in your own mail app instead">Open in Gmail</button>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Cancel</button>
          <button className="btn sm primary" disabled={sending} onClick={send}>{sending ? 'Sending…' : 'Send email'}</button>
        </div>
      </div>
    </div>
  );
}

// Per-salon touch tally + a way to pull the salon out of the cadence.
function TouchStrip({ r, lead, acts }: { r: R; lead: Lead; acts: Activity[] }) {
  const calls = acts.filter((a) => (a.kind === 'call' || a.kind === 'book') && a.direction !== 'in').length;
  const texts = acts.filter((a) => a.kind === 'text' && a.direction !== 'in').length;
  const emails = acts.filter((a) => a.kind === 'email' && a.direction !== 'in').length;
  const demos = acts.filter((a) => a.kind === 'book' || a.disposition === 'booked').length;
  const removed = lead.stage === 'cold';
  return (
    <div className="touch-strip">
      <div className="ts-counts">
        <span className="ts">{Icon.call}<b>{calls}</b> {calls === 1 ? 'call' : 'calls'}</span>
        <span className="ts">{Icon.text}<b>{texts}</b> {texts === 1 ? 'text' : 'texts'}</span>
        <span className="ts">{Icon.email}<b>{emails}</b> {emails === 1 ? 'email' : 'emails'}</span>
        <span className="ts ts-demo">🎉 <b>{demos}</b> {demos === 1 ? 'demo' : 'demos'}</span>
      </div>
      {removed
        ? <span className="ts-removed">⊘ Removed from cadence</span>
        : <RemoveFromCadence r={r} leadId={lead.id} />}
    </div>
  );
}

function RemoveFromCadence({ r, leadId }: { r: R; leadId: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(t); }, [armed]);
  const onClick = (e: React.MouseEvent) => { e.stopPropagation(); if (!armed) { setArmed(true); return; } r.removeFromCadence(leadId); };
  return (
    <button className={`btn sm danger${armed ? ' armed' : ''}`} onClick={onClick} title="Mark not interested and stop the cadence for this salon">
      {armed ? 'Confirm — not interested?' : '⊘ Remove from cadence'}
    </button>
  );
}

// Day-cleared / nothing-due screen for the flow.
function FlowDone({ r }: { r: R }) {
  const s = r.stats;
  const nothingDue = r.flow.queue.length === 0;
  return (
    <section className="view on flowdone">
      <div className="fd-card">
        <div className="fd-emoji">{nothingDue ? '☕️' : '🎉'}</div>
        <h2>{nothingDue ? 'Nothing due today' : "That's your list — nicely done"}</h2>
        <p className="fd-sub">{nothingDue
          ? "You're all caught up. Salons scheduled for a future working day will appear here when they come due."
          : "You've worked every salon due today. Come back next working day for the next batch."}</p>
        {!nothingDue && (
          <div className="fd-stats">
            <div><b>{s.dials}</b><span>dials</span></div>
            <div><b>{s.conversations}</b><span>convos</span></div>
            <div><b>{s.texts}</b><span>texts</span></div>
            <div><b>{s.emails}</b><span>emails</span></div>
            <div><b>{s.demos}</b><span>demos</span></div>
          </div>
        )}
        <button className="btn primary" onClick={r.exitFlow}>Done</button>
      </div>
    </section>
  );
}

function Dialer({ r }: { r: R }) {
  // Whole due list worked (or nothing was due) → the day-cleared screen.
  if (r.flow.on && r.flow.done) return <FlowDone r={r} />;
  const lead = r.leadById(r.activeLeadId);
  if (!lead) return null;
  const acts = r.activities[lead.id] || [];
  const inFlow = r.flow.on && !r.flow.paused;
  const idx = r.leads.findIndex((l) => l.id === lead.id);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [lead.id]);

  return (
    <section className="view on" style={{ padding: 0 }}>
      <div className={`ws${r.activeCall ? ' calling' : ''}`}>
        {/* queue rail */}
        <div className="ws-list">
          <div className="lh"><span>Session queue</span>{!inFlow && <em className="lh-ct">{r.dueLeads.length} due today</em>}</div>
          {(inFlow ? r.flow.queue.map((q) => q.leadId) : (r.dueLeads.length ? r.dueLeads : r.activeLeads).map((l) => l.id)).map((id) => {
            const l = r.leadById(id); if (!l) return null; // deleted mid-flow — skip, never crash
            const li = r.leads.findIndex((x) => x.id === id);
            const done = inFlow && r.flow.queue.findIndex((q) => q.leadId === id) < r.flow.pos;
            const warm = r.warmLeadIds.has(id);
            return (
              <div key={id} className={`ws-item ${id === lead.id ? 'on' : ''} ${done ? 'done' : ''} ${warm ? 'warm' : ''}`} onClick={() => r.setActiveLeadId(id)}>
                <div className="avatar ai" style={{ background: colorFor(li), position: 'relative', overflow: 'visible' }}>{initials(l.salon)}{l.source === 'instagram' && <IgBadge size={13} />}</div>
                <div><div className="nm">{l.salon}{warm && <span className="warm-flag" title="Opened or clicked your email">🔥</span>}</div>
                  <div className="mt">{warm ? 'Warm · engaged your email' : (l.contact?.name === '—' ? l.contact?.role : l.contact?.name)}</div></div>
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
              <span>⚡ <b>Today&apos;s list</b> · {r.flow.queue.length - r.flow.pos} of {r.flow.queue.length} salons left</span>
              <div className="prog"><i style={{ width: `${(r.flow.pos / Math.max(1, r.flow.queue.length)) * 100}%` }} /></div>
              <button className="btn sm" onClick={r.exitFlow}>Exit flow</button>
            </div>
          ) : (
            <div className="session-bar"><span>Manual dial</span><div className="prog"><i style={{ width: '20%' }} /></div>
              <button className="btn sm flowbtn" onClick={() => r.startFlow()}>Start Flow</button></div>
          )}

          {inFlow && r.flow.notice && (
            <div className="flow-notice">{r.flow.notice}<span className="fn-next">Next up: {lead.salon}</span></div>
          )}

          <div className="lead-head">
            <div className="avatar big" style={{ background: colorFor(idx), position: 'relative', overflow: 'visible' }}>{initials(lead.salon)}{lead.source === 'instagram' && <IgBadge size={20} />}</div>
            <div>
              <h2>{lead.salon}</h2>
              <div className="meta">{lead.contact?.name === '—' ? lead.contact?.role : `${lead.contact?.name} · ${lead.contact?.role}`}{lead.city ? ` · ${lead.city}` : ''}</div>
              {lead.cadenceCompletedAt && (
                <div className="cad-done">✓ Completed {lead.cadenceCompletedName || 'cadence'} · {fmtDate(lead.cadenceCompletedAt)}</div>
              )}
              {!lead.cadenceCompletedAt && isOverdue(lead) && (
                <div className="cad-overdue">⏰ Overdue · was due {fmtDate(lead.nextActionAt)}</div>
              )}
            </div>
            <div className="r"><BookDemo lead={lead} /><AgentCallButton r={r} lead={lead} /><TemplatesButton r={r} lead={lead} /><QuickEmail r={r} lead={lead} /><LeadEnrich r={r} lead={lead} /><button className="btn sm" onClick={() => setEditing((v) => !v)} title="Edit lead details">{editing ? 'Close' : '✎ Edit'}</button><DeleteLeadButton r={r} leadId={lead.id} /><span className={`pill ${stagePill[lead.stage]}`}><span className="dot" style={{ background: 'currentColor' }} />{stageLabel[lead.stage]}</span></div>
          </div>

          <ChannelRow r={r} lead={lead} />
          <LeadContextCards r={r} lead={lead} />

          {inFlow ? (
            // The action bar always belongs to the flow's CURRENT lead. If the rep
            // has browsed to a different lead in the queue, show a peek banner
            // instead of a compose — never a send box under the wrong salon.
            r.current && r.activeLeadId === r.current.leadId
              ? <FlowBar r={r} lead={r.currentLead || lead} />
              : <FlowPeekBar r={r} viewing={lead} />
          ) : (
            <div className="task-strip"><div className="cb" /><div className="t">Call — {lead.objection}</div>
              <div className="chip amber">Due today</div>
              <div className="o"><button className="btn sm primary" onClick={() => r.startFlow()}>Start Flow</button></div></div>
          )}

          {editing ? <LeadEditForm r={r} lead={lead} onDone={() => setEditing(false)} /> : (
          <div className="qgrid">
            <div className="qc"><div className="qk">Phone</div><div className="qv">{lead.phone
              ? <button className="qv-call" title={`Call ${lead.phone}`} onClick={() => r.startCall(lead.id)}>{Icon.call} {lead.phone}</button>
              : <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Email</div><div className="qv">{lead.email ? <a className="qv-link" href={`mailto:${lead.email}`}>{lead.email}</a> : <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Booking</div><div className="qv">{lead.bookingSystem ? <span className="book-chip">{lead.bookingSystem}</span> : <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Website</div><div className="qv">{lead.website ? <a className="qv-link" href={`https://${lead.website}`} target="_blank" rel="noreferrer">{lead.website}</a> : <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Instagram</div><div className="qv">{lead.handle ? <a className="qv-link" href={`https://instagram.com/${lead.handle.replace(/^@+/, '')}`} target="_blank" rel="noreferrer">{lead.handle}</a> : <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Cadence</div>
              <select className="qv-select" value={r.cadences.some((c) => c.id === lead.cadenceId) ? lead.cadenceId : (r.cadences[0]?.id || '')}
                onChange={(e) => r.assignCadence(lead.id, e.target.value)} onClick={(e) => e.stopPropagation()}>
                {r.cadences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="qc"><div className="qk">City</div><div className="qv">{lead.city || <span className="muted">—</span>}</div></div>
            <div className="qc"><div className="qk">Last touch</div><div className="qv">{lead.lastTouch}</div></div>
          </div>
          )}

          <TouchStrip r={r} lead={lead} acts={acts} />

          <div className="block" style={{ marginTop: 14 }}>
            <div className="bh"><div className="bt">Activity · {acts.length}</div></div>
            <div className="timeline">
              {acts.length === 0 && <div className="muted">No activity yet — first touch.</div>}
              {acts.map((h) => <TimelineItem key={h.id} h={h} />)}
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

// One entry in the lead's activity timeline. Calls with a recording get an
// inline audio player + expandable transcript; the AI summary shows as before.
const fmtDur = (s?: number) => { if (s == null) return ''; const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = (iso?: string) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } };
const recSid = (url?: string) => url?.match(/Recordings\/(RE[0-9a-fA-F]+)/)?.[1];

function LeadEditForm({ r, lead, onDone }: { r: R; lead: Lead; onDone: () => void }) {
  const [salon, setSalon] = useState(lead.salon || '');
  const [name, setName] = useState(lead.contact?.name && lead.contact.name !== '\u2014' ? lead.contact.name : '');
  const [phone, setPhone] = useState(lead.phone || '');
  const [email, setEmail] = useState(lead.email || '');
  const [website, setWebsite] = useState(lead.website || '');
  const [booking, setBooking] = useState(lead.bookingSystem || '');
  const [city, setCity] = useState(lead.city || '');
  const [handle, setHandle] = useState(lead.handle || '');
  const save = () => { r.saveLeadEdits(lead.id, { salon, contactName: name, phone, email, website, bookingSystem: booking, city, handle }); onDone(); };
  const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 13, background: 'var(--panel)', color: 'var(--ink)' };
  const field = (label: string, val: string, set: (v: string) => void, ph = '', type = 'text') => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink3)' }}>{label}</span>
      <input style={inputStyle} type={type} value={val} placeholder={ph} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--panel)', marginBottom: 4 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {field('Business / salon', salon, setSalon, 'Salon name')}
        {field('Contact name', name, setName, 'Owner / manager')}
        {field('Phone', phone, setPhone, '(801) 555-0123', 'tel')}
        {field('Email', email, setEmail, 'name@salon.com', 'email')}
        {field('Website', website, setWebsite, 'salon.com')}
        {field('Booking system', booking, setBooking, 'Vagaro, Boulevard\u2026')}
        {field('City', city, setCity, 'City, ST')}
        {field('Instagram', handle, setHandle, '@handle')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button className="btn sm primary" onClick={save}>Save changes</button>
        <button className="btn sm" onClick={onDone}>Cancel</button>
        <span style={{ fontSize: 11, color: 'var(--ink3)' }}>Clear a field to remove it. Phone &amp; email also update the contact.</span>
      </div>
    </div>
  );
}

function TimelineItem({ h }: { h: Activity }) {
  const [showTx, setShowTx] = useState(false);
  const sid = recSid(h.recordingUrl);
  return (
    <div className={`tl ${h.kind}`}>
      <div className="dot" />
      <div className="tlh">
        <span className="ty">{h.ty}</span>
        {h.ai && <span className="ai-note">✦ AI summary</span>}
        {h.recordingUrl && <span className="rec-chip">● Recorded{h.durationS != null ? ` · ${fmtDur(h.durationS)}` : ''}</span>}
        <span className="tm">{h.time}</span>
      </div>
      <div className={`body ${h.kind === 'call' || h.kind === 'book' ? 'card' : ''}`} style={{ whiteSpace: 'pre-line' }}>
        {h.aiNote || h.body}
        {h.ownNote && <div className="own-note">📝 {h.ownNote}</div>}
        {sid && (
          <div className="rec-player">
            <audio controls preload="none" src={`/api/voice/media?sid=${sid}`} />
            {h.transcript && <button className="rec-tx-toggle" onClick={() => setShowTx((v) => !v)}>{showTx ? 'Hide transcript' : 'Show transcript'}</button>}
          </div>
        )}
        {!sid && h.transcript && <button className="rec-tx-toggle" style={{ marginTop: 6 }} onClick={() => setShowTx((v) => !v)}>{showTx ? 'Hide transcript' : 'Show transcript'}</button>}
        {showTx && h.transcript && <div className="rec-transcript">{h.transcript}</div>}
      </div>
    </div>
  );
}

// ── Interactive cold-call script — tap how the prospect responds, it branches ─
// A tiny state machine: each node is a script beat; its choice chips reveal the
// next beat below (the path stays visible so you can read back up the call).
// New lead in the dialer = fresh script from the top.
type ScriptNode = {
  title: string;
  lines: { who: 'you' | 'them'; text: string }[];
  ask?: string;                                    // the green closing ask
  choices?: { label: string; to: string }[];       // how they responded
  book?: boolean;                                  // offer 📅 book-the-Zoom
  end?: string;                                    // wrap-up coaching note
};
const SCRIPT_NODES: Record<string, ScriptNode> = {
  open: {
    title: 'The open',
    lines: [
      { who: 'you', text: 'Hey, what time do you close tonight?' },
      { who: 'them', text: '[answer]' },
      { who: 'you', text: 'Nice. When a new client calls after hours, or while you’re in the chair — does that just go to voicemail?' },
      { who: 'them', text: '[answer]' },
      { who: 'you', text: 'Got it. I’m curious — have you guys ever looked at a virtual receptionist that just catches the calls you can’t get to?' },
    ],
    choices: [
      { label: 'Owner — “yes / we’ve thought about it”', to: 'owner_yes' },
      { label: 'Owner — “no / not really”', to: 'owner_no' },
      { label: 'Not the person', to: 'not_person' },
    ],
  },
  owner_yes: {
    title: 'Owner · open to it',
    lines: [
      { who: 'you', text: 'Cool. Missed calls get picked up before voicemail by our virtual receptionist — she knows your salon and can get the client a booking link. That’s been helping salons turn missed calls into busier schedules for their commission team.' },
    ],
    ask: 'Are you opposed to taking a look on a quick 15-minute Zoom call right now?',
    book: true,
    choices: [{ label: 'They pushed back', to: 'owner_no' }],
  },
  owner_no: {
    title: 'Owner · not really',
    lines: [
      { who: 'you', text: 'No worries. Wasn’t trying to sell you. I only ask because the salons that try it usually see those missed calls turn into booked appointments for the commission team.' },
    ],
    ask: 'Is there another day that would make more sense to take a quick look?',
    book: true,
    end: 'If they name a day, book it on the spot — otherwise snooze the lead to that day so it comes back due.',
  },
  not_person: {
    title: 'Not the person',
    lines: [{ who: 'you', text: 'No worries. Are you a commission stylist, or do you rent a booth?' }],
    choices: [
      { label: 'Commission stylist', to: 'commission' },
      { label: 'Booth renter', to: 'booth' },
    ],
  },
  commission: {
    title: 'Commission stylist',
    lines: [{ who: 'you', text: 'Gotcha. Do you ever have gaps the owner would want to fill for the team?' }],
    choices: [
      { label: '“Yes, we get gaps”', to: 'commission_gaps' },
      { label: '“No / we stay booked”', to: 'commission_booked' },
    ],
  },
  commission_gaps: {
    title: 'Has gaps → route to owner',
    lines: [],
    ask: 'That’s usually where missed calls hurt. Is the owner the right person for a 15-minute Zoom, or who should I ask for?',
    end: 'Get the owner’s name and the best time to reach them — drop it in the contact + a note, then snooze to that day.',
  },
  commission_booked: {
    title: 'Stays booked → route to owner',
    lines: [],
    ask: 'Nice. Who handles the phones — the owner?',
    end: 'Get the owner’s name — save it on the contact and call back asking for them.',
  },
  booth: {
    title: 'Booth renter',
    lines: [{ who: 'you', text: 'Do you book your own appointments?' }],
    choices: [
      { label: '“Yes, I book my own”', to: 'booth_own' },
      { label: '“No — the salon books”', to: 'booth_salon' },
    ],
  },
  booth_own: {
    title: 'Books their own → pitch text-back',
    lines: [
      { who: 'you', text: 'When you miss a call mid-client, what happens today?' },
      { who: 'them', text: '[answer]' },
      { who: 'you', text: 'Got it. For booth renters we usually do something simpler than a full receptionist — missed-call text-back. You keep your same number. The second you miss a call, the client gets a text with your booking link so they book you instead of the next stylist. About 3 minutes to set up, $49 a month.' },
    ],
    ask: 'Are you opposed to taking a look on a quick 15-minute Zoom call right now?',
    book: true,
    choices: [{ label: 'They shut it down', to: 'booth_shutdown' }],
  },
  booth_shutdown: {
    title: 'Shut it down · soft close',
    lines: [
      { who: 'you', text: 'No worries. Wasn’t trying to sell you. Most booth renters who try it just stop losing the clients that call while they’re with someone.' },
    ],
    ask: 'Is there another day that would make more sense to take a quick look?',
    book: true,
    end: 'If they name a day, book it — otherwise snooze the lead to that day.',
  },
  booth_salon: {
    title: 'Salon books → route to owner',
    lines: [],
    ask: 'Owner’s probably better. Who should I ask for?',
    end: 'Get the owner’s name — save it on the contact and call back asking for them.',
  },
};

function ScriptPanel({ lead }: { lead: Lead }) {
  const [path, setPath] = useState<string[]>(['open']);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setPath(['open']); }, [lead.id]);          // fresh call, fresh script
  useEffect(() => {
    if (path.length > 1) bodyRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [path]);
  // Picking a response at step i prunes anything after it, so re-picking an
  // earlier branch mid-call just rewrites the rest of the path.
  const pick = (i: number, to: string) => setPath((p) => [...p.slice(0, i + 1), to]);
  const bookName = lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name : lead.salon;
  return (
    <div className="ws-right">
      <div className="rp-head">
        <div className="ic">{Icon.flow}</div>
        <div><div className="nm">Cold-call script</div><div className="sp-sub">Tap how they respond — it branches</div></div>
        {path.length > 1 && <button className="btn sm sp-restart" onClick={() => setPath(['open'])}>↺ Restart</button>}
      </div>
      <div className="rp-body" ref={bodyRef}>
        {path.map((id, i) => {
          const n = SCRIPT_NODES[id];
          if (!n) return null;
          const chosen = path[i + 1];
          return (
            <div key={`${id}-${i}`} className="script-step">
              <div className="sn">{String(i + 1).padStart(2, '0')} — {n.title.toUpperCase()}</div>
              {n.lines.map((l, j) => (l.who === 'you'
                ? <div key={j} className="say">&quot;{l.text}&quot;</div>
                : <div key={j} className="aside">Them: {l.text} — let them talk.</div>))}
              {n.ask && (
                <div className="branch"><span className="q">The ask</span>
                  <div className="say">&quot;{n.ask}&quot;</div></div>
              )}
              {n.book && !chosen && (
                <button className="btn primary sm sp-book"
                  onClick={() => openCalendly({ name: bookName, email: lead.email, leadId: lead.id })}>
                  📅 They&apos;re in — book the Zoom
                </button>
              )}
              {n.choices && (
                <div className="sp-choices">
                  {n.choices.map((c) => (
                    <button key={c.to}
                      className={`sp-chip ${chosen === c.to ? 'on' : chosen ? 'dim' : ''}`}
                      onClick={() => pick(i, c.to)}>{c.label}</button>
                  ))}
                </div>
              )}
              {n.end && !chosen && <div className="aside sp-end">{n.end}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Flow action bar ───────────────────────────────────────────────────────────
// Shown when the rep has clicked a different lead in the queue while a flow is
// running. The flow's action stays on its current lead — this makes that
// explicit and offers a one-click way back, instead of a compose box that looks
// like it's addressed to the lead you're only peeking at.
function FlowPeekBar({ r, viewing }: { r: R; viewing: Lead }) {
  const cur = r.currentLead;
  return (
    <div className="flowbar peek">
      <span className="fb-badge">👀 Viewing {viewing.salon}</span>
      <span className="fb-what">Your flow is on <b>{cur?.salon || 'the current lead'}</b>. Jump here to work {viewing.salon} now — {cur?.salon || 'it'} resumes right after.</span>
      <div className="fb-actions">
        <button className="btn primary sm" onClick={() => r.workLeadNow(viewing.id)}>Work {viewing.salon} now</button>
        <button className="btn sm" onClick={() => cur && r.setActiveLeadId(cur.id)}>Back to flow →</button>
      </div>
    </div>
  );
}

function FlowBar({ r, lead }: { r: R; lead: Lead }) {
  const ch = r.currentChannel;
  const { phase } = r.flow;

  if (phase === 'incall') {
    return <div className="flowbar dispo"><span className="fb-badge live">On the call</span>
      <span className="fb-what">Live with {lead.contact?.name === '—' ? lead.salon : lead.contact?.name?.split(' ')[0]} — hit “End &amp; log” to pick the outcome →</span></div>;
  }
  if (phase === 'note') return <NoteBar r={r} />;
  if (phase === 'callback') return <CallbackPicker key={lead.id} lead={lead} onSet={(iso, note) => r.confirmFlowCallback(iso, note)} onCancel={r.cancelFlowCallback} flow />;
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
  // key by lead id so the draft always re-derives for the lead it's addressed to
  // (a stale body must never survive a lead change).
  const eff = ch ? resolveChannel(ch, lead) : ch;
  if (eff === 'dm') return <ComposeDm key={lead.id} r={r} lead={lead} />;
  if (eff === 'text') return <ComposeText key={lead.id} r={r} lead={lead} fallbackFromDm={ch === 'dm'} />;
  return <ComposeEmail key={lead.id} r={r} lead={lead} />;
}

function ComposeText({ r, lead, fallbackFromDm }: { r: R; lead: Lead; fallbackFromDm?: boolean }) {
  const cad = r.cadenceById(lead.cadenceId);
  const tpl0 = cad?.steps.find((s) => (s.channel === 'text' || (fallbackFromDm && s.channel === 'dm')) && s.template)?.template || DEFAULT_SMS;
  const [body, setBody] = useState(renderTemplate(tpl0, lead));
  const [tpl, setTpl] = useState(false);
  return (
    <div className="flowbar text compose">
      <div className="compose-head"><span className="fb-badge">{Icon.text} Text · Action {r.flow.actionCount + 1}</span>
        <span className="compose-meta">To {lead.contact?.name === '—' ? lead.contact?.role : lead.contact?.name} · {lead.phone} · review before sending{fallbackFromDm ? ' · DM window closed, sending as a text' : ''}</span></div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="fb-actions"><button className="btn sm" onClick={() => setTpl(true)}>📄 Templates</button><button className="btn sm" onClick={r.flowSkip}>Skip</button>
        <button className="btn primary sm" style={{ background: 'var(--purple)', borderColor: 'var(--purple)' }} onClick={() => r.flowSend('text', body)}>Send text</button></div>
      {tpl && <TemplatesSheet r={r} lead={lead} tab="text" onClose={() => setTpl(false)} onPickText={(b) => setBody(b)} />}
    </div>
  );
}

function ComposeDm({ r, lead }: { r: R; lead: Lead }) {
  const cad = r.cadenceById(lead.cadenceId);
  const tpl = cad?.steps.find((s) => s.channel === 'dm' && s.template)?.template || IG_DM;
  const [body, setBody] = useState(renderTemplate(tpl, lead));
  const left = lead.lastSocialAt ? Math.max(0, 24 * 3600_000 - (Date.now() - new Date(lead.lastSocialAt).getTime())) : 0;
  const hrs = Math.floor(left / 3600_000);
  return (
    <div className="flowbar text compose dm">
      <div className="compose-head"><span className="fb-badge" style={{ background: 'linear-gradient(105deg,#F58529,#DD2A7B 55%,#8134AF)' }}>{IgGlyph} DM · Action {r.flow.actionCount + 1}</span>
        <span className="compose-meta">To {lead.handle || 'her Instagram'} · window open {hrs} h more · review before sending</span></div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="fb-actions"><button className="btn sm" onClick={r.flowSkip}>Skip</button>
        <button className="btn primary sm" style={{ background: '#c2366b', borderColor: '#c2366b' }} onClick={() => r.flowSend('dm', body)}>Send DM</button></div>
    </div>
  );
}

const IgGlyph = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" /></svg>;

// Pick the callback time she asked for. Quick chips cover the usual answers;
// the datetime field handles "Thursday after 2". Sets a real reminder.
function CallbackPicker({ lead, onSet, onCancel, flow, initialNote }: { lead: Lead; onSet: (iso: string, note?: string) => void; onCancel: () => void; flow?: boolean; initialNote?: string }) {
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState(initialNote || '');
  const at = (d: Date) => { d.setSeconds(0, 0); return d; };
  const inHours = (h: number) => at(new Date(Date.now() + h * 3600_000));
  const dayAt = (addDays: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(hour, 0, 0, 0); return d; };
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const chips: { label: string; d: Date }[] = [
    { label: 'In 1 hour', d: inHours(1) }, { label: 'In 2 hours', d: inHours(2) },
    ...(new Date().getHours() < 13 ? [{ label: 'Today 2:00 PM', d: dayAt(0, 14) }] : []),
    { label: 'Tomorrow 10 AM', d: dayAt(1, 10) }, { label: 'Tomorrow 2 PM', d: dayAt(1, 14) },
  ];
  const localInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  return (
    <div className={`flowbar callback ${flow ? '' : 'card-mode'}`}>
      <div className="compose-head"><span className="fb-badge good">Callback · set a reminder</span>
        <span className="fb-sub">{lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name : lead.salon} asked you to call back — Relay buzzes your phone 5 min before</span></div>
      <div className="cb-chips">
        {chips.map((c) => <button key={c.label} className="btn sm" onClick={() => onSet(c.d.toISOString(), note.trim() || undefined)} title={fmt(c.d)}>{c.label}</button>)}
      </div>
      <div className="cb-custom">
        <input type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} />
        <input type="text" value={note} placeholder="Note — e.g. after the renters meeting" onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary sm" disabled={!custom} onClick={() => { const d = new Date(custom); if (!isNaN(d.getTime())) onSet(d.toISOString(), note.trim() || undefined); }}>Set reminder</button>
        <button className="btn sm" onClick={onCancel}>{flow ? 'Back' : 'Cancel'}</button>
      </div>
    </div>
  );
}

// The four ways to reach her, always in the same place. Relay greys out what
// can't work (no phone, no Instagram conversation / window closed, no email).
function ChannelRow({ r, lead }: { r: R; lead: Lead }) {
  const [dm, setDm] = useState(false);
  const [dmBody, setDmBody] = useState('');
  const [dmMsg, setDmMsg] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [text, setText] = useState(false);
  const [textBody, setTextBody] = useState('');
  const [tplPick, setTplPick] = useState(false);
  const canDm = dmOpen(lead);
  const leftH = lead.lastSocialAt ? Math.max(0, Math.floor((24 * 3600_000 - (Date.now() - new Date(lead.lastSocialAt).getTime())) / 3600_000)) : 0;
  const bridge = r.useBridge;
  return (
    <div className="chrow-wrap">
      <div className="chrow">
        <button className="chb pri" disabled={!lead.phone} onClick={() => r.startCall(lead.id)} title={bridge ? 'Relay rings your cell, then dials her from the Relay number' : 'Call from the in-app dialer'}>
          {Icon.call}<span>Call</span><small>{lead.phone ? (bridge ? 'rings my cell' : 'in-app') : 'no phone'}</small>
        </button>
        <button className={`chb ig ${canDm ? '' : 'off'}`} onClick={() => { if (canDm) { setDm((v) => !v); setDmMsg(null); } }} title={canDm ? 'Instagram DM' : lead.igUserId ? 'Her 24-hour DM window is closed — text her' : 'No Instagram conversation yet'}>
          {IgGlyph}<span>DM</span><small>{canDm ? `${leftH} h left` : lead.igUserId ? 'window closed' : lead.handle ? 'no DM yet' : '—'}</small>
        </button>
        <button className={`chb ${lead.phone ? '' : 'off'}`} onClick={() => lead.phone && setText((v) => !v)} title="Text from the Relay number">
          {Icon.text}<span>Text</span><small>{lead.phone ? 'Relay number' : 'no phone'}</small>
        </button>
        <button className={`chb ${lead.email ? '' : 'off'}`} onClick={() => lead.email && setEmailOpen(true)} title="Email from your own mail app">
          {Icon.email}<span>Email</span><small>{lead.email ? 'from your mail' : 'no email'}</small>
        </button>
      </div>
      {dm && (
        <div className="chrow-compose dm">
          <textarea value={dmBody} placeholder={`DM ${lead.handle || 'her'}…`} onChange={(e) => setDmBody(e.target.value)} />
          <div className="fb-actions">
            {dmMsg && <span className="fb-sub" style={{ color: dmMsg.startsWith('✓') ? '#2f855a' : 'var(--red)' }}>{dmMsg}</span>}
            <button className="btn sm" onClick={() => setDm(false)}>Close</button>
            <button className="btn primary sm" style={{ background: '#c2366b', borderColor: '#c2366b' }} disabled={!dmBody.trim()} onClick={async () => { const res = await r.sendLeadDm(lead.id, dmBody.trim()); setDmMsg(res.ok ? '✓ Sent' : res.error || 'Failed'); if (res.ok) setDmBody(''); }}>Send DM</button>
          </div>
        </div>
      )}
      {text && (
        <div className="chrow-compose">
          <textarea value={textBody} placeholder={`Text ${lead.phone}…`} onChange={(e) => setTextBody(e.target.value)} />
          <div className="fb-actions"><button className="btn sm" onClick={() => setTplPick(true)}>📄 Templates</button><button className="btn sm" onClick={() => setText(false)}>Close</button>
            <button className="btn primary sm" style={{ background: 'var(--purple)', borderColor: 'var(--purple)' }} disabled={!textBody.trim()} onClick={() => { r.sendReply(lead.id, textBody.trim(), 'text'); setTextBody(''); setText(false); }}>Send text</button></div>
        </div>
      )}
      {emailOpen && <EmailComposer r={r} lead={lead} onClose={() => setEmailOpen(false)} />}
      {tplPick && <TemplatesSheet r={r} lead={lead} tab="text" onClose={() => setTplPick(false)} onPickText={(b) => setTextBody(b)} />}
    </div>
  );
}

// Why she's here (her Instagram words + DM window) and the callback reminder.
function LeadContextCards({ r, lead }: { r: R; lead: Lead }) {
  const [pick, setPick] = useState(false);
  const social = lead.source === 'instagram' && (lead.notes || lead.lastSocialAt);
  const leftMs = lead.lastSocialAt ? 24 * 3600_000 - (Date.now() - new Date(lead.lastSocialAt).getTime()) : 0;
  const cb = lead.callbackAt ? new Date(lead.callbackAt) : null;
  const cbLate = cb ? cb.getTime() < Date.now() : false;
  const primed = r.pendingCallLead === lead.id;
  return (
    <>
      {primed && (
        <div className="ctx-card callback">
          <div className="ctx-h"><b>Reminder · call {lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name.split(' ')[0] : lead.salon} now</b><span className="grow" />
            <button className="btn primary sm" disabled={!lead.phone} onClick={() => { r.clearPendingCall(); r.startCall(lead.id); }}>{Icon.call} Call</button>
            <button className="btn sm" onClick={r.clearPendingCall}>Later</button></div>
          {lead.callbackNote && <div className="ctx-sub">{lead.callbackNote}</div>}
        </div>
      )}
      {social && (
        <div className="ctx-card social">
          <div className="ctx-h"><span className="soc-ig">{IgGlyph}</span><b>Why she&apos;s here</b>{lead.handle && <a href={`https://instagram.com/${lead.handle.replace(/^@/, '')}`} target="_blank" rel="noreferrer" className="ctx-link">{lead.handle}</a>}</div>
          {lead.notes && <div className="ctx-quote">{lead.notes}</div>}
          {lead.lastSocialAt && (
            <div className="ctx-win"><span>DM window</span><div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, (leftMs / (24 * 3600_000)) * 100))}%` }} /></div><b>{leftMs > 0 ? `${Math.floor(leftMs / 3600_000)} h left` : 'closed'}</b></div>
          )}
        </div>
      )}
      {cb && !pick && (
        <div className={`ctx-card callback ${cbLate ? 'late' : ''}`}>
          <div className="ctx-h"><b>Callback · {cb.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b>
            <span className="ctx-tag">{cbLate ? 'overdue' : 'reminder set'}</span>
            <span className="grow" />
            <button className="btn sm" onClick={() => setPick(true)}>Change</button>
            <button className="btn sm" onClick={() => r.setCallback(lead.id, null)}>Done</button>
          </div>
          {lead.callbackNote && <div className="ctx-sub">{lead.callbackNote}</div>}
          <div className="ctx-sub">Your phone buzzes 5 min before · she has {r.me?.phoneNumber || 'the Relay number'} and it rings you.</div>
        </div>
      )}
      {!cb && !pick && lead.stage !== 'won' && (
        <button className="ctx-set-cb" onClick={() => setPick(true)}>+ Set a callback reminder</button>
      )}
      {pick && <CallbackPicker lead={lead} initialNote={lead.callbackNote} onSet={(iso, note) => { r.setCallback(lead.id, iso, note); setPick(false); }} onCancel={() => setPick(false)} />}
    </>
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
  const placedRef = useRef(false); // StrictMode double-mount guard: one bridge per panel
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
      if (r.useBridge) {
        // Cell bridge: Relay rings the rep's phone, then dials her. Audio lives
        // on the cell, so this panel is just status + notes + End & log.
        if (placedRef.current) return;
        placedRef.current = true;
        setMode('real'); setStatus('Ringing your cell…');
        const res = await r.bridgeCall(lead.id);
        if (cancelled) return;
        if (res.ok) { setStatus('Pick up your phone — Relay is dialing her'); startTick(); }
        else { setStatus(res.code === 'no_cell' ? 'Add your cell in Team first' : `Call failed: ${res.error}`); }
        return;
      }
      const call = await placeCall(lead.phone || '', lead.id, r.me?.id);
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
      <div className="who">{direction === 'in' ? 'incoming' : r.useBridge ? 'cell bridge' : mode === 'real' ? 'live' : 'mobile'} · {lead.phone} · {lead.contact?.name === '—' ? lead.salon : lead.contact?.name}</div>
      {direction === 'out' && r.useBridge && (
        <div className="bridge-note">Talk on your phone. Give her <b>{r.me?.phoneNumber || 'the Relay number'}</b> — when she calls it back it rings <b>you</b>. Tap <b>End &amp; log</b> here when you hang up.</div>
      )}
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
  dm: { label: 'Instagram DM', icon: IgGlyph, color: '#c2366b' },
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

// One-click "move every lead on this cadence to another one" (admin). Moved
// leads restart at step 1 and become due today.
function MoveCadenceBar({ r, fromId, count }: { r: R; fromId: string; count: number }) {
  const [to, setTo] = useState('');
  const [flash, setFlash] = useState('');
  const others = r.cadences.filter((c) => c.id !== fromId);
  const doMove = () => {
    if (!to) return;
    const nm = r.cadences.find((c) => c.id === to)?.name || '';
    const n = r.moveCadenceLeads(fromId, to);
    setTo('');
    setFlash(`Moved ${n} lead${n === 1 ? '' : 's'} to “${nm}” — restarted at step 1, due today.`);
    setTimeout(() => setFlash(''), 6000);
  };
  return (
    <div className="cad-move">
      {flash ? <span className="cm-flash">✓ {flash}</span> : (
        <>
          <span className="cm-n"><b>{count}</b> lead{count === 1 ? '' : 's'} currently on this cadence</span>
          <span className="cm-sep">·</span>
          <label>Move all to</label>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose cadence…</option>
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn sm" disabled={!to} onClick={doMove}>Move {count}</button>
        </>
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
  // Insert a fresh step right after step i; everything after just shifts down,
  // its content and branches untouched (steps save by array order).
  const insertStep = (i: number) => patchDraft((d) => {
    const steps = d.steps.slice();
    steps.splice(i + 1, 0, { position: i + 1, channel: 'call', waitMinutes: 0 });
    return { ...d, steps };
  });
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
            {r.isAdmin && r.cadences.length > 1 && usedBy(draft.id) > 0 && (
              <MoveCadenceBar key={draft.id} r={r} fromId={draft.id} count={usedBy(draft.id)} />
            )}

            <div className="cad-steps">
              {draft.steps.map((s, i) => (
                <div key={i} className={`cad-step ch-${s.channel}`}>
                  <div className="cad-step-n" style={{ color: CH_META[s.channel].color }}>{i + 1}</div>
                  <div className="cad-step-body">
                    <div className="cad-step-row">
                      <label className="cad-chan">
                        <span className="cad-chan-ic" style={{ color: CH_META[s.channel].color }}>{CH_META[s.channel].icon}</span>
                        <select value={s.channel} onChange={(e) => updStep(i, { channel: e.target.value as Channel })}>
                          {(['call', 'text', 'dm', 'email', 'wait'] as Channel[]).map((ch) => <option key={ch} value={ch}>{CH_META[ch].label}</option>)}
                        </select>
                      </label>
                      <label className="cad-gap">Day gap
                        <input type="number" min={0} step={0.5} value={+(s.waitMinutes / 1440).toFixed(2)}
                          onChange={(e) => updStep(i, { waitMinutes: Math.max(0, Math.round(parseFloat(e.target.value || '0') * 1440)) })} />
                      </label>
                      <div className="cad-step-ctrls">
                        <button className="ico" title="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                        <button className="ico" title="Move down" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                        <button className="ico ins" title="Insert a step below this one" onClick={() => insertStep(i)}>＋</button>
                        <button className="ico del" title="Remove" onClick={() => removeStep(i)}>✕</button>
                      </div>
                    </div>
                    {s.channel === 'email' && (
                      <input className="cad-subj" value={s.subject || ''} onChange={(e) => updStep(i, { subject: e.target.value })} placeholder="Email subject — use {salon}, {first_name}" />
                    )}
                    {(s.channel === 'text' || s.channel === 'email' || s.channel === 'dm') && (
                      <textarea className="cad-tpl" value={s.template || ''} onChange={(e) => updStep(i, { template: e.target.value })}
                        placeholder={s.channel === 'text' ? 'Text message — use {salon}, {first_name}' : s.channel === 'dm' ? 'Instagram DM — sends as a text when her 24h window is closed. Use {salon}, {first_name}, {demo_link}' : 'Email body — use {salon}, {first_name}'} />
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
    const c = await placeCall(num, undefined, r.me?.id);
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

  // Hide while a call panel is up.
  if (r.activeCall) return null;

  const press = (d: string) => setNum((n) => (n + d).slice(0, 18));
  const back = () => setNum((n) => n.slice(0, -1));
  const endCall = () => { callRef.current?.disconnect?.(); callRef.current = null; r.logDial('call', num); setMode('idle'); setStatus(''); setSecs(0); };
  const call = async () => {
    if (!ready) return;
    setMode('calling'); setStatus('Connecting…'); setSecs(0);
    const c = await placeCall(num, undefined, r.me?.id);
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
