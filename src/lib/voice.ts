'use client';
// Client-side Twilio Voice SDK wrapper. Everything is lazy/dynamic so it never
// runs on the server and never bundles into SSR. Returns null when Twilio Voice
// isn't configured (token endpoint 503s) — callers fall back to the sim.

import type { Call, Device } from '@twilio/voice-sdk';

let device: Device | null = null;
let incomingHandler: ((call: Call) => void) | null = null;

export function normalizePhone(p?: string): string {
  if (!p) return '';
  const digits = p.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits;
}

async function ensureDevice(identity = 'rep'): Promise<Device | null> {
  try {
    const res = await fetch(`/api/voice/token?identity=${encodeURIComponent(identity)}`);
    if (!res.ok) return null; // 503 = not configured
    const { token } = await res.json();
    if (device) { device.updateToken(token); return device; }
    const { Device } = await import('@twilio/voice-sdk');
    device = new Device(token, { logLevel: 'error', closeProtection: true });
    device.on('incoming', (call: Call) => incomingHandler?.(call));
    await device.register();
    return device;
  } catch (e) {
    console.warn('Twilio Voice unavailable, using sim:', e);
    return null;
  }
}

/** Place a real outbound call. Returns the Call, or null if not configured.
 * leadId (when known) rides along so the server can attach the recording +
 * AI summary to the right lead's timeline. */
export async function placeCall(toDisplay: string, leadId?: string, repId?: string): Promise<Call | null> {
  const to = normalizePhone(toDisplay);
  if (!to) return null;
  const d = await ensureDevice();
  if (!d) return null;
  const params: Record<string, string> = { To: to };
  if (leadId) params.leadId = leadId;
  if (repId) params.repId = repId; // dial from this rep's own number
  const call = await d.connect({ params });
  attachRingback(call);
  return call;
}

// ── Local ringback ──────────────────────────────────────────────────────────
// The dial uses answerOnBridge, so Twilio sends no ringback of its own; the
// SDK only plays audio when the far end sends early media. When it doesn't,
// play the standard US ring (440+480 Hz, 2s on / 4s off) until the call is
// answered or ends, so the rep knows the call is live.
let ringCtx: AudioContext | null = null;
let ringStop: (() => void) | null = null;

function startRingback() {
  if (ringStop) return;
  try {
    const AC: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ringCtx = ringCtx || new AC();
    const ctx = ringCtx;
    ctx.resume?.().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const oscs = [440, 480].map((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(gain);
      o.start();
      return o;
    });
    const cycle = () => {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
      gain.gain.setValueAtTime(0.12, t + 1.98);
      gain.gain.linearRampToValueAtTime(0, t + 2);
    };
    cycle();
    const timer = setInterval(cycle, 6000);
    ringStop = () => {
      clearInterval(timer);
      try { gain.gain.cancelScheduledValues(ctx.currentTime); gain.gain.setValueAtTime(0, ctx.currentTime); } catch { /* noop */ }
      oscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch { /* noop */ } });
      try { gain.disconnect(); } catch { /* noop */ }
    };
  } catch (e) {
    console.warn('ringback unavailable', e);
  }
}

function stopRingback() {
  const s = ringStop;
  ringStop = null;
  s?.();
}

function attachRingback(call: Call) {
  call.on('ringing', (hasEarlyMedia: boolean) => { if (!hasEarlyMedia) startRingback(); });
  for (const ev of ['accept', 'disconnect', 'cancel', 'reject', 'error']) call.on(ev, stopRingback);
}

/** Register a handler for inbound calls (Answer/Decline UI hooks into this). */
export function onIncoming(handler: (call: Call) => void) {
  incomingHandler = handler;
  ensureDevice(); // warm up the device so we can receive
}

export async function voiceReady(): Promise<boolean> {
  return (await ensureDevice()) !== null;
}
