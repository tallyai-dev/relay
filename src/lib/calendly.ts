'use client';
// Calendly embed helper. Opens Calendly's own scheduling widget in a popup over
// Relay (Calendly has no API to create a booking, so the widget is the supported
// path). A booking there lands on the real calendar and fires the
// invitee.created webhook → /api/calendly/webhook logs it back onto the lead.

export const CALENDLY_URL =
  process.env.NEXT_PUBLIC_CALENDLY_URL ||
  'https://calendly.com/gettallyai-sales/15-minute-demo-of-tallys-missed-call-solutions';

let scriptReady: Promise<void> | null = null;

function ensureWidget(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).Calendly) return Promise.resolve();
  if (scriptReady) return scriptReady;
  scriptReady = new Promise<void>((resolve) => {
    if (!document.getElementById('calendly-css')) {
      const l = document.createElement('link');
      l.id = 'calendly-css'; l.rel = 'stylesheet';
      l.href = 'https://assets.calendly.com/assets/external/widget.css';
      document.head.appendChild(l);
    }
    const s = document.createElement('script');
    s.src = 'https://assets.calendly.com/assets/external/widget.js';
    s.async = true;
    s.onload = () => resolve();
    document.body.appendChild(s);
  });
  return scriptReady;
}

// Open the scheduler, prefilled with the salon contact so the rep (or the salon
// on a screen-share) just picks a time. `leadId` rides along as a UTM value so
// the webhook can fall back to it when email matching misses.
export async function openCalendly(opts: { name?: string; email?: string; leadId?: string } = {}) {
  await ensureWidget();
  const Calendly = (window as any).Calendly;
  if (!Calendly) { window.open(CALENDLY_URL, '_blank'); return; }
  Calendly.initPopupWidget({
    url: CALENDLY_URL,
    prefill: { name: opts.name || '', email: opts.email || '' },
    utm: opts.leadId ? { utmContent: opts.leadId } : undefined,
  });
}
