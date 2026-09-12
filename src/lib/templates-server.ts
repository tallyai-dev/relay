// Server-side read of the template overrides (service role) so Eryn's
// post-call texts use whatever the admin last saved in Relay → Templates.
import { supabaseAdmin } from '@/lib/supabase';
import type { TplOverrides } from '@/lib/templates';

export async function loadTemplateOverrides(): Promise<TplOverrides> {
  const db = supabaseAdmin();
  if (!db) return {};
  const { data } = await db.from('template_overrides').select('key, subject, body, updated_at');
  const out: TplOverrides = {};
  for (const r of data || []) out[r.key] = { subject: r.subject, body: r.body, updatedAt: r.updated_at };
  return out;
}
