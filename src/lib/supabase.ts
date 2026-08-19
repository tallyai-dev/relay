import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase is optional at runtime — the app falls back to seeded mock data when
 * env vars are absent, so `npm run dev` works with zero config.
 */
export function hasSupabase(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

// Browser/client — anon key, RLS-scoped.
let browserClient: SupabaseClient | null = null;
export function supabaseBrowser(): SupabaseClient | null {
  if (!hasSupabase()) return null;
  if (!browserClient) {
    browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return browserClient;
}

// Server — service role for webhooks (Twilio/email) that write without a user session.
export function supabaseAdmin(): SupabaseClient | null {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return null;
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
