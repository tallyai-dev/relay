'use client';
import { useMemo, useState } from 'react';
import type { useRelay } from '@/hooks/useRelay';
import { TEXT_TEMPLATES, EMAIL_TEMPLATES_LIB, PRODUCT_TEMPLATES, renderTpl, ERYN_TEXT_KEYS, TPL_TOKENS, type TplKind } from '@/lib/templates';
import { CALENDLY_URL } from '@/lib/calendly';

// Relay → Templates. Every prospecting template, editable in place. What you
// save here is what the lead-card sheet shows, what the email composer starts
// from, and what Eryn texts after her calls. "Reset" drops back to the wording
// shipped in code (src/lib/templates.ts).
type R = ReturnType<typeof useRelay>;

const seg = (s: string) => Math.max(1, Math.ceil(s.length / 160));

function Row({ r, kind, tpl, sample }: { r: R; kind: TplKind; tpl: { key: string; label: string; when?: string; subject?: string; body: string; price?: string }; sample: any }) {
  const k = `${kind}:${tpl.key}`;
  const ov = r.tplOverrides[k];
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(tpl.subject || '');
  const [body, setBody] = useState(tpl.body);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = body !== tpl.body || (tpl.subject !== undefined && subject !== tpl.subject);
  const preview = useMemo(() => renderTpl(body, sample), [body, sample]);
  const save = async () => {
    const err = await r.saveTemplate(kind, tpl.key, { subject: tpl.subject !== undefined ? subject : null, body });
    setMsg(err ? `Could not save: ${err}` : 'Saved'); if (!err) setOpen(false);
  };
  const reset = async () => {
    const err = await r.resetTemplate(kind, tpl.key);
    setMsg(err ? `Could not reset: ${err}` : 'Back to default');
    if (!err) { setOpen(false); }
  };
  // Keep local state in step when the override changes underneath (reset / reload).
  const [seen, setSeen] = useState(tpl.body + '|' + (tpl.subject || ''));
  const now = tpl.body + '|' + (tpl.subject || '');
  if (seen !== now) { setSeen(now); setBody(tpl.body); setSubject(tpl.subject || ''); }
  const eryn = kind === 'text' && ERYN_TEXT_KEYS[tpl.key];
  return (
    <div className={`tpe-row ${open ? 'open' : ''} ${ov ? 'edited' : ''}`}>
      <button className="tpe-head" onClick={() => { setOpen((v) => !v); setMsg(null); }}>
        <span className="tpe-lab">{tpl.label}{eryn && <span className="tpe-eryn" title={`Eryn sends this after: ${eryn}`}>Eryn</span>}{ov && <span className="tpe-chip">edited</span>}</span>
        <span className="tpe-when">{tpl.when || tpl.price || ''}</span>
        {!open && <span className="tpe-prev">{tpl.subject ? <b>{tpl.subject} · </b> : null}{tpl.body}</span>}
      </button>
      {open && (
        <div className="tpe-edit">
          {tpl.subject !== undefined && <input className="tpe-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />}
          <textarea className="tpe-body" value={body} rows={kind === 'text' ? 4 : 10} onChange={(e) => setBody(e.target.value)} />
          <div className="tpe-meta">
            {kind === 'text' && <span>{preview.length} chars · {seg(preview)} SMS segment{seg(preview) > 1 ? 's' : ''}{preview.length > 320 ? ' · long for a cold text' : ''}</span>}
            {eryn && <span>Eryn sends this: {eryn}</span>}
            {ov?.updatedAt && <span>edited {new Date(ov.updatedAt).toLocaleDateString()}</span>}
          </div>
          <div className="tpe-preview"><span className="tpe-plab">Preview · {sample.lead.salon}</span>{tpl.subject !== undefined && <b>{renderTpl(subject, sample)}</b>}<div>{preview}</div></div>
          {msg && <div className="tpe-msg">{msg}</div>}
          <div className="fb-actions">
            {ov && <button className="btn sm" onClick={reset}>Reset to default</button>}
            <button className="btn sm" onClick={() => { setBody(tpl.body); setSubject(tpl.subject || ''); setOpen(false); }}>Cancel</button>
            <button className="btn primary sm" disabled={!dirty || !body.trim()} onClick={save}>Save</button>
          </div>
        </div>
      )}
      {!open && msg && <div className="tpe-msg">{msg}</div>}
    </div>
  );
}

export function TemplatesEditor({ r }: { r: R }) {
  const [tab, setTab] = useState<TplKind>('text');
  const [showTokens, setShowTokens] = useState(false);
  const sampleLead = r.activeLeads[0] || r.leads[0] || { id: 'x', salon: 'Lush & Co', city: 'Lehi, UT', phone: '', stage: 'new' as const, cadenceId: '', cadencePos: 0, contact: { id: 'c', name: 'Jenna Ortiz', role: 'Owner' }, bookingSystem: 'Vagaro', email: 'jenna@lushandco.com' };
  const sample = useMemo(() => ({ lead: sampleLead, me: r.me, product: 'Night Desk', callbackTime: 'Thursday at 2', meetingTime: '10:30', meetingLink: 'zoom.us/j/…', calendly: CALENDLY_URL, season: 'prom season', when: 'in June', nurtureItem: '[one useful thing]' }), [sampleLead, r.me]);
  const edited = Object.keys(r.tplOverrides).length;
  const lists: Record<TplKind, any[]> = { text: r.textTemplates, email: r.emailTemplates, product: r.productTemplates };
  const defaults: Record<TplKind, any[]> = { text: TEXT_TEMPLATES, email: EMAIL_TEMPLATES_LIB, product: PRODUCT_TEMPLATES };
  return (
    <section className="view on tpe-view">
      <div className="page-head">
        <div><h1>Templates</h1><p>One voice across the team. Edit here and the lead card, the email composer, and Eryn's follow-up texts all use it.{edited ? ` ${edited} edited.` : ''}</p></div>
        <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => setShowTokens((v) => !v)}>{showTokens ? 'Hide tokens' : 'Tokens'}</button><button className="btn" onClick={() => r.setView('cadences')}>← Cadences</button></div>
      </div>
      {!r.isAdmin && <div className="agent-note">Only admins can change templates. You can read them here.</div>}
      {!r.enabled && <div className="agent-note">Demo mode — edits stay in this tab.</div>}
      {showTokens && (
        <div className="tpe-tokens">{TPL_TOKENS.map((t) => <div key={t.token}><code>{t.token}</code><span>{t.means}</span></div>)}<div><code>[missing]</code><span>a token with no value shows as a visible [placeholder] so the rep sees what to type — never a silent blank.</span></div></div>
      )}
      <div className="tpl-tabs" style={{ maxWidth: 520 }}>
        <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Texts · {lists.text.length}</button>
        <button className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}>Emails · {lists.email.length}</button>
        <button className={tab === 'product' ? 'on' : ''} onClick={() => setTab('product')}>Product emails · {lists.product.length}</button>
      </div>
      {tab === 'text' && <div className="tpe-hint">Texts go from the Relay number. The first text to any salon should keep "Reply STOP to opt out." The three marked <span className="tpe-eryn">Eryn</span> are what she sends after a no-answer, a voicemail, or a front-desk message.</div>}
      <div className="tpe-list">
        {lists[tab].map((t, i) => <Row key={t.key} r={r} kind={tab} tpl={{ ...t, ...(defaults[tab][i]?.when ? { when: defaults[tab][i].when } : {}) }} sample={sample} />)}
      </div>
    </section>
  );
}
