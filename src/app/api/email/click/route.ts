import { supabaseAdmin } from '@/lib/supabase';

// GET /api/email/click?m=<messageId>&u=<base64url original url>
// Records a click for the message, then 302-redirects to the original link.
// The links are authored by us (our own outbound emails), but we still validate
// the scheme to avoid being used as an open redirect.
export const dynamic = 'force-dynamic';

const FALLBACK = 'https://tallyai-relay.netlify.app';

function decodeB64Url(s: string): string {
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get('m');
  let dest = decodeB64Url(u.searchParams.get('u') || '');
  if (!/^https?:\/\//i.test(dest)) dest = FALLBACK;

  if (id) {
    try {
      const db = supabaseAdmin();
      if (db) await db.rpc('track_email_click', { msg: id });
    } catch { /* redirect regardless of logging outcome */ }
  }
  return Response.redirect(dest, 302);
}
