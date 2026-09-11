'use client';
// Web Push — client side. Subscribes this device (the installed Relay PWA) so
// callback reminders can buzz the lock screen. iOS needs the app added to the
// Home Screen first; Android/desktop Chrome work in the tab.

function b64ToUint8(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export type PushState = 'unsupported' | 'unavailable' | 'off' | 'on' | 'blocked';

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const r = await fetch('/api/push/vapid');
    if (!r.ok) return 'unavailable';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch { return 'unavailable'; }
}

/** Ask permission + subscribe + register with the server. Must run from a tap. */
import { authHeaders } from '@/lib/repo';

export async function enablePush(_repId: string): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: 'This browser cannot receive push. On iPhone, add Relay to your Home Screen first.' };
  try {
    const r = await fetch('/api/push/vapid');
    if (!r.ok) return { ok: false, error: 'Push is not configured on the server yet.' };
    const { publicKey } = await r.json();
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'Notifications were not allowed.' };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) as BufferSource }));
    const res = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) return { ok: false, error: 'Could not save this device.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Push setup failed.' };
  }
}
