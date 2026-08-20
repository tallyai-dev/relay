import { supabaseAdmin } from '@/lib/supabase';

// GET /api/email/pixel?m=<messageId>
// Returns a 1x1 transparent GIF and records an email open for that message.
// No-store so opens aren't swallowed by a cache (note: Apple Mail Privacy and
// Gmail image proxying still make raw open counts noisy — clicks are the
// stronger signal, which is why "warm" also weights clicks).
export const dynamic = 'force-dynamic';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('m');
  if (id) {
    try {
      const db = supabaseAdmin();
      if (db) await db.rpc('track_email_open', { msg: id });
    } catch { /* never block the pixel on a logging failure */ }
  }
  return new Response(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}
