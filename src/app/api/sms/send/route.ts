import { sendSmsServer } from '@/lib/sms-server';

// POST /api/sms/send  { to, body, leadId?, repId? }
// Returns { sid, status, messageId } on success, or { error } with a 4xx/5xx so
// the client can surface a real failure instead of silently dropping it.
// The actual send (from-number rule, DNC guard, messages log) lives in
// src/lib/sms-server.ts so the Eryn no-answer texts use the same path.
export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const r = await sendSmsServer({ to: body.to, body: body.body, leadId: body.leadId, repId: body.repId });
  if (!r.ok) return Response.json({ error: r.error, code: r.code }, { status: r.status });
  return Response.json({ sid: r.sid, status: r.status, messageId: r.messageId });
}
