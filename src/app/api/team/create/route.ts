import { supabaseAdmin } from '@/lib/supabase';

// POST /api/team/create  { email, name, phoneNumber? }
// Admin-only. Creates the SDR's auth login (service role), fills in their rep
// row (name, number, role=rep), and returns a set-password link to hand them.
// The caller proves they're an admin by passing their access token as a Bearer
// header — we verify it and check their rep role before doing anything.
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

  const { email, name, phoneNumber } = await req.json();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return Response.json({ error: 'Enter a valid email.' }, { status: 400 });
  }

  // Create the login. email_confirm so they can set a password without a
  // separate confirmation step.
  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email: cleanEmail, email_confirm: true });
  if (cErr || !created.user) {
    return Response.json({ error: cErr?.message || 'Could not create the account (it may already exist).' }, { status: 400 });
  }
  const newUid = created.user.id;

  // The auth trigger inserts a rep on user creation; fill in the details. If the
  // trigger hasn't landed yet, insert the rep ourselves.
  const repRow = { name: String(name || cleanEmail).trim(), phone_number: phoneNumber || null, role: 'rep', active: true };
  const { data: updated } = await admin.from('reps').update(repRow).eq('auth_user_id', newUid).select('id');
  let repId = updated?.[0]?.id ?? null;
  if (!repId) {
    const { data: inserted } = await admin.from('reps').insert({ auth_user_id: newUid, email: cleanEmail, ...repRow }).select('id').single();
    repId = inserted?.id ?? null;
  }

  // Set-password link to hand the SDR (works whether or not SMTP is configured).
  const base = process.env.PUBLIC_BASE_URL || 'https://tallyai-relay.netlify.app';
  const { data: linkData } = await admin.auth.admin.generateLink({ type: 'recovery', email: cleanEmail, options: { redirectTo: base } });
  const inviteLink = (linkData as any)?.properties?.action_link || '';

  return Response.json({ ok: true, repId, inviteLink });
}
