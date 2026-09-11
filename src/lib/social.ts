// Instagram (Meta Graph API) — server side.
//
// Env (all from the Meta app you create for Relay):
//   META_APP_SECRET        — verifies X-Hub-Signature-256 on every webhook POST
//   META_VERIFY_TOKEN      — the string you type into the webhook subscription
//   META_PAGE_TOKEN        — long-lived Page access token for the Facebook Page
//                            linked to @gettallyai (needs instagram_basic,
//                            instagram_manage_messages, instagram_manage_comments,
//                            pages_manage_metadata)
//   META_IG_ACCOUNT_ID     — the Instagram Business account id (17841…)
//   SOCIAL_AUTO_REPLY      — 'on' to let keyword rules reply/DM automatically
//   SOCIAL_DEFAULT_REP_ID  — rep uuid that new social leads are assigned to
//                            (blank = unassigned pool)
//
// Everything degrades: no token → webhook still logs events and makes leads,
// it just can't reply or pull profiles.

const GRAPH = 'https://graph.facebook.com/v21.0';

export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;

export function metaConfigured() {
  return Boolean(process.env.META_PAGE_TOKEN && process.env.META_IG_ACCOUNT_ID);
}

async function graph(path: string, init: RequestInit & { query?: Record<string, string> } = {}) {
  const token = process.env.META_PAGE_TOKEN || '';
  const q = new URLSearchParams({ ...(init.query || {}), access_token: token });
  const res = await fetch(`${GRAPH}/${path}?${q}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Graph ${res.status}`;
    throw Object.assign(new Error(msg), { code: data?.error?.code, status: res.status });
  }
  return data;
}

/** Send an Instagram DM to an IGSID (the id Meta gives a user in OUR inbox). */
export async function igSendDm(igsid: string, text: string, humanAgent = false) {
  const body: any = { recipient: { id: igsid }, message: { text } };
  if (humanAgent) { body.messaging_type = 'MESSAGE_TAG'; body.tag = 'HUMAN_AGENT'; }
  return graph(`${process.env.META_IG_ACCOUNT_ID}/messages`, { method: 'POST', body: JSON.stringify(body) });
}

/** Public reply under a comment on one of our posts. */
export async function igReplyToComment(commentId: string, text: string) {
  return graph(`${commentId}/replies`, { method: 'POST', body: JSON.stringify({ message: text }) });
}

/** Private DM to the author of a comment on one of our posts (allowed once per comment). */
export async function igPrivateReply(commentId: string, text: string) {
  return graph(`${process.env.META_IG_ACCOUNT_ID}/messages`, {
    method: 'POST', body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
}

/** Name + username for someone who DM'd us. */
export async function igProfile(igsid: string): Promise<{ name?: string; username?: string } | null> {
  try {
    const d = await graph(igsid, { query: { fields: 'name,username' } });
    return { name: d.name, username: d.username };
  } catch (e: any) { console.error('igProfile', e?.message); return null; }
}

export interface IgPublicProfile { username: string; name?: string; biography?: string; website?: string; followers?: number }
/** Public business/creator profile by @username (business_discovery). */
export async function igBusinessDiscovery(username: string): Promise<IgPublicProfile | null> {
  const u = username.replace(/^@+/, '').trim();
  if (!u || !metaConfigured()) return null;
  try {
    const d = await graph(process.env.META_IG_ACCOUNT_ID!, {
      query: { fields: `business_discovery.username(${u}){username,name,biography,website,followers_count}` },
    });
    const b = d.business_discovery;
    if (!b) return null;
    return { username: b.username, name: b.name, biography: b.biography, website: b.website, followers: b.followers_count };
  } catch (e: any) { console.error('business_discovery', e?.message); return null; }
}

// ── Keyword rules (what the mockup called "Rules") ──────────────────────────
// Kept in code for v1 so a bad rule is a code review, not a 2 am surprise.
export interface SocialRule { id: string; test: RegExp; tag: string; reply?: string; dm?: string; callWithinHours?: number }
export const SOCIAL_RULES: SocialRule[] = [
  {
    id: 'price', tag: 'pricing', test: /\b(price|pricing|how much|cost|\$|per month|monthly)\b/i,
    reply: "DM'd you the pricing!",
    dm: "Hey! Thanks for asking — Night Desk (answers after you close) is $49/mo and the 24/7 receptionist is $199/mo, month to month, no setup. Here's the 2-min demo: https://gettallyai.com/demo — want me to text it to you, or is a quick call easier? What's the best number?",
    callWithinHours: 1,
  },
  {
    id: 'demo', tag: 'demo', test: /\b(demo|try it|sign ?up|how do i|get started|interested)\b/i,
    reply: "Sent you a DM!",
    dm: "Hey! Here's the 2-min demo: https://gettallyai.com/demo. If you want to hear it live, call the demo salon at (385) 374-1473 — it'll book you. What's a good number to reach you?",
    callWithinHours: 1,
  },
  {
    id: 'software', tag: 'integration', test: /\b(vagaro|glossgenius|gloss genius|square|booksy|fresha|boulevard|mindbody|styleseat)\b/i,
    dm: "Good question — Tally sits next to your booking software, not instead of it. Your book doesn't change; Tally just answers the call and hands the client your booking link. Want the 2-min demo? https://gettallyai.com/demo",
  },
  {
    id: 'rent', tag: 'booth', test: /\b(rent|booth|suite|renters?)\b/i,
    dm: "Tally Booth collects rent automatically (a salon down the road runs 14 renters on it). Happy to show you — what's a good number, or want the 2-min demo link?",
    callWithinHours: 2,
  },
];

export function matchRule(text: string): SocialRule | null {
  const t = (text || '').trim();
  if (!t || !/[A-Za-z0-9]/.test(t)) return null; // emoji-only / punctuation → nothing
  for (const r of SOCIAL_RULES) if (r.test.test(t)) return r;
  return null;
}

/** Is a DM to this lead still inside Meta's 24-hour reply window? */
export function dmWindowOpen(lastSocialAt?: string | null): boolean {
  if (!lastSocialAt) return false;
  return Date.now() - new Date(lastSocialAt).getTime() < DM_WINDOW_MS;
}

/** Parse an Instagram / TikTok profile URL or @handle into {platform, handle}. */
export function parseSocialHandle(input: string): { platform: 'instagram' | 'tiktok' | null; handle: string } {
  const s = (input || '').trim();
  let m = s.match(/instagram\.com\/([A-Za-z0-9._]{1,30})/i);
  if (m) return { platform: 'instagram', handle: m[1].replace(/^@+/, '') };
  m = s.match(/tiktok\.com\/@([A-Za-z0-9._]{1,30})/i);
  if (m) return { platform: 'tiktok', handle: m[1] };
  m = s.match(/^@?([A-Za-z0-9._]{2,30})$/);
  if (m) return { platform: 'instagram', handle: m[1] };
  return { platform: null, handle: '' };
}
