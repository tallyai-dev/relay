import { supabaseAdmin } from '@/lib/supabase';

// POST /api/team/reset  { email }
// Admin-only. Generates a fresh set-password link for an existing user (invite
// expired, forgot password, etc.) to hand them. Same admin check as
// /api/team/create — caller passes their access token as a Bearer header.
export async function POST(req: Request) {
  const admin = supabaseAdmin();
  if (!admin) return Response.json({ error: 'Server not configured.' }, { status: 503 });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Not authenticated.' }, { status: 401 });
  const { data: userData } = await admin.auth.getUser(token);
  const uid = userData.user?.id;
  if (!uid) return Response.json({ error: 'Invalid session.' }, { status: 401 });
  const { data: caller } = await admin.from('reps').select('role').eq('auth_user_id', uid).maybeSingle();
  if (caller?.role !== 'admin') return Response.json({ error: 'Admins only.' }, { status: 403 });

  const { email } = await req.json();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return Response.json({ error: 'No email.' }, { status: 400 });

  const base = process.env.PUBLIC_BASE_URL || 'https://tallyai-relay.netlify.app';
  const { data: linkData, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: cleanEmail, options: { redirectTo: base } });
  const inviteLink = (linkData as any)?.properties?.action_link || '';
  if (error || !inviteLink) return Response.json({ error: error?.message || 'Could not generate a link.' }, { status: 400 });

  return Response.json({ ok: true, inviteLink });
}
