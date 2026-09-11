// Web Push (VAPID) — server side. Reminders buzz the installed Relay PWA on
// the rep's phone. Needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in env
// (generate once: `npx web-push generate-vapid-keys`).
import webpush from 'web-push';
import { supabaseAdmin } from '@/lib/supabase';

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensure() {
  if (configured || !pushConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:sethbrockbank@gmail.com',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

export interface PushPayload { title: string; body: string; url?: string; tag?: string }

/** Send to every subscription a rep has; prunes dead ones (410/404). */
export async function pushToRep(repId: string, payload: PushPayload): Promise<number> {
  ensure();
  if (!configured) return 0;
  const db = supabaseAdmin();
  if (!db) return 0;
  const { data } = await db.from('reps').select('push_subscriptions').eq('id', repId).maybeSingle();
  const subs: any[] = Array.isArray(data?.push_subscriptions) ? data!.push_subscriptions : [];
  if (!subs.length) return 0;
  const keep: any[] = [];
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 600 });
      keep.push(s); sent++;
    } catch (e: any) {
      if (e?.statusCode === 410 || e?.statusCode === 404) continue; // expired — drop it
      console.error('push send', e?.statusCode, e?.message);
      keep.push(s);
    }
  }
  if (keep.length !== subs.length) await db.from('reps').update({ push_subscriptions: keep }).eq('id', repId);
  return sent;
}
