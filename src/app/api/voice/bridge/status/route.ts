import { supabaseAdmin } from '@/lib/supabase';

// POST /api/voice/bridge/status?leadId=&repId=  — Twilio status callback for
// the rep's leg of a bridged call. Keeps the `calls` row honest (answered /
// completed / no-answer + duration). The rep logs the OUTCOME themselves from
// the after-call sheet; the recording callback fills in transcript + summary.
export async function POST(req: Request) {
  let form: FormData;
  try { form = await req.formData(); } catch { return new Response('', { status: 200 }); }
  const sid = String(form.get('CallSid') || '');
  const status = String(form.get('CallStatus') || '');
  const duration = parseInt(String(form.get('CallDuration') || '0'), 10) || null;
  const db = supabaseAdmin();
  if (db && sid) {
    const patch: Record<string, any> = { status };
    if (duration != null && status === 'completed') patch.duration_s = duration;
    await db.from('calls').update(patch).eq('twilio_sid', sid);
  }
  return new Response('', { status: 200 });
}
