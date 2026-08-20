// Gmail API helpers — send as sales@gettallyai.com and read replies back in.
// Server-side only. Uses an OAuth refresh token for the sending mailbox, so no
// Postmark/SendGrid or DNS setup is needed. Configure with:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
//   GMAIL_SENDER=sales@gettallyai.com
// Refresh token needs scopes: gmail.send + gmail.readonly.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function gmailConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GMAIL_SENDER
  );
}

// Exchange the long-lived refresh token for a short-lived access token.
async function accessToken(): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) { console.error('gmail token', res.status, (await res.text()).slice(0, 200)); return null; }
  const j = await res.json();
  return j.access_token || null;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeB64Url = (s: string) => { try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; } };
const emailOf = (v: string) => { const m = v.match(/<([^>]+)>/); return (m ? m[1] : v).trim().toLowerCase(); };

// Send a plaintext email from the configured mailbox.
export async function sendGmail(to: string, subject: string, body: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const from = process.env.GMAIL_SENDER || '';
  const tok = await accessToken();
  if (!tok) return { ok: false, error: 'Gmail auth failed — check the refresh token.' };
  const mime = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject || ''}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body || '',
  ].join('\r\n');
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  if (!res.ok) { const t = await res.text(); console.error('gmail send', res.status, t.slice(0, 200)); return { ok: false, error: t.slice(0, 200) }; }
  const j = await res.json();
  return { ok: true, id: j.id };
}

export interface GmailReply { id: string; from: string; subject: string; body: string }

// Pull recent inbound replies (last 2 weeks, excluding our own sends) so they can
// be threaded into the app's Inbox.
export async function fetchReplies(maxResults = 25): Promise<GmailReply[]> {
  const from = process.env.GMAIL_SENDER || '';
  const tok = await accessToken();
  if (!tok) return [];
  const q = encodeURIComponent(`in:inbox -from:${from} newer_than:14d`);
  const listRes = await fetch(`${GMAIL}/messages?q=${q}&maxResults=${maxResults}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!listRes.ok) { console.error('gmail list', listRes.status); return []; }
  const ids: string[] = ((await listRes.json()).messages || []).map((m: any) => m.id);
  const out: GmailReply[] = [];
  for (const id of ids) {
    const mRes = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!mRes.ok) continue;
    const m = await mRes.json();
    const hdrs: any[] = m.payload?.headers || [];
    const h = (n: string) => (hdrs.find((x) => x.name?.toLowerCase() === n)?.value || '');
    out.push({ id, from: emailOf(h('from')), subject: h('subject'), body: extractBody(m.payload) || (m.snippet || '') });
  }
  return out;
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeB64Url(payload.body.data);
  for (const part of payload.parts || []) { const b = extractBody(part); if (b) return b; }
  return '';
}
