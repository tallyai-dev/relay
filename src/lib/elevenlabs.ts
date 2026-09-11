// ElevenLabs Conversational AI — the server side of "Eryn calls her".
// Outbound calls go through ElevenLabs' native Twilio integration: we hand it
// the agent, the number to dial from, the number to dial, and the lead's facts
// as dynamic variables. The post-call webhook (src/app/api/webhooks/elevenlabs)
// brings the transcript + analysis back.
import { createHmac, timingSafeEqual } from 'crypto';

const API = 'https://api.elevenlabs.io';

export function elevenConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_PHONE_ID);
}

export const ERYN = {
  agentId: () => process.env.ELEVENLABS_AGENT_ID || '',
  phoneId: () => process.env.ELEVENLABS_PHONE_ID || '',
  fromNumber: () => process.env.ELEVENLABS_FROM_NUMBER || '',
  name: () => process.env.AGENT_NAME || 'Eryn',
};

export type OutboundResult = { ok: true; conversationId: string; callSid: string } | { ok: false; error: string };

/** Place one call. `vars` become {{dynamic_variables}} inside the agent prompt. */
export async function startOutboundCall(toNumber: string, vars: Record<string, string | number | boolean>): Promise<OutboundResult> {
  if (!elevenConfigured()) return { ok: false, error: 'ElevenLabs not configured (ELEVENLABS_API_KEY / AGENT_ID / PHONE_ID).' };
  let res: Response;
  try {
    res = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: ERYN.agentId(),
        agent_phone_number_id: ERYN.phoneId(),
        to_number: toNumber,
        conversation_initiation_client_data: { dynamic_variables: vars },
      }),
    });
  } catch (e: any) {
    return { ok: false, error: e?.message || 'ElevenLabs unreachable.' };
  }
  let j: any = {};
  try { j = await res.json(); } catch {}
  if (!res.ok || j?.success === false) {
    const msg = j?.detail?.message || j?.detail || j?.message || `ElevenLabs ${res.status}`;
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
  return { ok: true, conversationId: String(j.conversation_id || ''), callSid: String(j.callSid || j.call_sid || '') };
}

/** Pull a conversation (transcript + analysis) — used if a webhook was missed. */
export async function getConversation(conversationId: string): Promise<any | null> {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch(`${API}/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * Verify the `ElevenLabs-Signature` header: "t=<unix>,v0=<hex hmac>" where the
 * hmac is sha256(secret, `${t}.${rawBody}`). Rejects anything older than 30 min.
 */
export function verifyElevenSignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const t = parts.t; const v0 = parts.v0;
  if (!t || !v0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > 30 * 60) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(v0));
  } catch { return false; }
}
