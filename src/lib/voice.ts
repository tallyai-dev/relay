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
export async function placeCall(toDisplay: string, leadId?: string): Promise<Call | null> {
  const to = normalizePhone(toDisplay);
  if (!to) return null;
  const d = await ensureDevice();
  if (!d) return null;
  const params: Record<string, string> = { To: to };
  if (leadId) params.leadId = leadId;
  return d.connect({ params });
}

/** Register a handler for inbound calls (Answer/Decline UI hooks into this). */
export function onIncoming(handler: (call: Call) => void) {
  incomingHandler = handler;
  ensureDevice(); // warm up the device so we can receive
}

export async function voiceReady(): Promise<boolean> {
  return (await ensureDevice()) !== null;
}
