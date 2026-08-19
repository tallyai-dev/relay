'use client';
import { useState } from 'react';

// Public "Book a demo" capture page. Salons land here from an email/text link;
// submissions POST to /api/leads/capture and appear in Relay as hot inbound leads.
export default function BookDemo() {
  const [f, setF] = useState({ salon: '', contactName: '', phone: '', email: '', city: '', notes: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.salon.trim()) { setErr('Please add your salon name.'); return; }
    if (!f.phone.trim() && !f.email.trim()) { setErr('Add a phone or email so we can reach you.'); return; }
    setErr(''); setState('sending');
    try {
      const res = await fetch('/api/leads/capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Something went wrong.'); }
      setState('done');
    } catch (e: any) { setErr(e.message || 'Something went wrong.'); setState('error'); }
  };

  return (
    <div className="book-wrap">
      <div className="book-card">
        <div className="book-logo">R</div>
        {state === 'done' ? (
          <div className="book-done">
            <div className="book-tick">✓</div>
            <h1>You’re booked in.</h1>
            <p>Thanks{f.contactName ? `, ${f.contactName.split(' ')[0]}` : ''} — we’ll reach out to <b>{f.salon}</b> shortly to set up your demo.</p>
          </div>
        ) : (
          <>
            <h1>See Relay for your salon</h1>
            <p className="book-sub">A quick demo of the AI receptionist that answers your missed &amp; after‑hours calls and books clients for you. Drop your details and we’ll be in touch.</p>
            <form onSubmit={submit} className="book-form">
              <label>Salon name<input value={f.salon} onChange={on('salon')} placeholder="e.g. Luxe Hair Studio" autoFocus /></label>
              <label>Your name<input value={f.contactName} onChange={on('contactName')} placeholder="First & last" /></label>
              <div className="book-row">
                <label>Phone<input value={f.phone} onChange={on('phone')} placeholder="(555) 123‑4567" inputMode="tel" /></label>
                <label>City<input value={f.city} onChange={on('city')} placeholder="City, ST" /></label>
              </div>
              <label>Email<input value={f.email} onChange={on('email')} placeholder="you@salon.com" inputMode="email" /></label>
              <label>Anything we should know?<textarea value={f.notes} onChange={on('notes')} placeholder="Best time to reach you, what you’re hoping to fix…" /></label>
              {err && <div className="book-err">{err}</div>}
              <button className="book-btn" type="submit" disabled={state === 'sending'}>
                {state === 'sending' ? 'Sending…' : 'Book my demo'}
              </button>
              <div className="book-fine">No spam. We’ll only use this to set up your demo.</div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
