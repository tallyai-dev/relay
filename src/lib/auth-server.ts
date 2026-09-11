import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase';

// Who is calling this API route? The browser sends its Supabase session as
// `Authorization: Bearer <access_token>`; we verify it with the anon client and
// map the auth user to their rep row. Routes that ring phones or receive pushes
// use this so a bare curl can't act as another rep.
export async function repFromRequest(req: Request): Promise<{ id: string; name: string; role: string; forward_to: string | null; phone_number: string | null } | null> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return null;
  try {
    const sb = createClient(url, anon, { auth: { persistSession: false } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return null;
    const db = supabaseAdmin();
    if (!db) return null;
    const { data: rep } = await db.from('reps').select('id, name, role, forward_to, phone_number, active').eq('auth_user_id', data.user.id).maybeSingle();
    if (!rep || rep.active === false) return null;
    return rep;
  } catch { return null; }
}
