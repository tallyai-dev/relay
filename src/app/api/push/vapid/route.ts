// GET /api/push/vapid → { publicKey } so the PWA can subscribe. 503 when push
// isn't configured (the UI hides the "turn on reminders" button).
export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  if (!publicKey) return Response.json({ error: 'Push not configured (VAPID_PUBLIC_KEY).' }, { status: 503 });
  return Response.json({ publicKey });
}
