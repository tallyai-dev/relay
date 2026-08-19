import { supabaseAdmin } from '@/lib/supabase';

// POST /api/voice/recording?leadId=...  — Twilio recording status callback.
// Fires when a call recording is ready. We fetch the audio, transcribe it
// (OpenAI Whisper), summarize it into a real AI note + suggested disposition
// (OpenAI chat), and attach all of it to the lead's timeline. Best-effort:
// if OpenAI isn't configured or a step fails, the recording is still logged so
// nothing is lost.

export const maxDuration = 26; // platform ceiling — short salon calls finish well under this.

const DISPOSITIONS = ['booked', 'callback', 'not_interested', 'voicemail', 'no_answer', 'connected', 'quote', 'wrong_number'];

// Pull the call audio from Twilio (Basic auth) and transcribe with Whisper.
async function transcribe(recordingUrl: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!key || !sid || !tok) return null;
  const media = await fetch(`${recordingUrl}.mp3`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
  });
  if (!media.ok) { console.error('recording media fetch failed', media.status); return null; }
  const buf = await media.arrayBuffer();
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'call.mp3');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) { console.error('whisper failed', res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  return typeof data.text === 'string' ? data.text.trim() : null;
}

// Turn a transcript into a short summary + suggested disposition + next step.
async function summarize(transcript: string): Promise<{ summary: string; disposition?: string; nextStep?: string } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !transcript) return null;
  const sys =
    'You analyze outbound sales calls for Relay, a tool selling an AI phone ' +
    'receptionist to hair salons (it answers missed & after-hours calls and books ' +
    'appointments). Given a call transcript, return STRICT JSON with keys: ' +
    '"summary" (2-3 sentences: what happened, the salon\'s stance, any objection), ' +
    '"disposition" (one of ["booked","callback","not_interested","voicemail","no_answer","connected","quote","wrong_number"]), ' +
    '"next_step" (one short recommended action). Return only the JSON object.';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: transcript.slice(0, 12000) }],
    }),
  });
  if (!res.ok) { console.error('summary failed', res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  try {
    const j = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const disposition = DISPOSITIONS.includes(j.disposition) ? j.disposition : undefined;
    return { summary: String(j.summary || '').trim(), disposition, nextStep: j.next_step ? String(j.next_step).trim() : undefined };
  } catch { return null; }
}

export async function POST(req: Request) {
  const leadId = new URL(req.url).searchParams.get('leadId') || '';
  let form: FormData;
  try { form = await req.formData(); } catch { return new Response('', { status: 200 }); }

  const recordingUrl = String(form.get('RecordingUrl') || '');
  const durationS = parseInt(String(form.get('RecordingDuration') || '0'), 10) || null;
  const status = String(form.get('RecordingStatus') || 'completed');

  const db = supabaseAdmin();
  // Nothing to attach to (no DB, unknown lead, no audio, or not finished) — the
  // recording still lives on Twilio, so just acknowledge.
  if (!db || !leadId || !recordingUrl || status !== 'completed') {
    return new Response('', { status: 200 });
  }

  // Transcribe + summarize (best-effort — the recording is logged either way).
  let transcript: string | null = null;
  let ai: { summary: string; disposition?: string; nextStep?: string } | null = null;
  try {
    transcript = await transcribe(recordingUrl);
    if (transcript) ai = await summarize(transcript);
  } catch (e: any) {
    console.error('recording AI error', e?.message);
  }

  const aiNote = ai
    ? `✦ ${ai.summary}${ai.nextStep ? `\nNext: ${ai.nextStep}` : ''}`
    : transcript ? '✦ Transcript captured (summary unavailable).' : undefined;

  // Attach to the rep's just-logged call row if there is one (enriching its
  // placeholder note with the real summary); otherwise insert a fresh entry.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from('activities')
    .select('id, disposition')
    .eq('lead_id', leadId).eq('kind', 'call').is('recording_url', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();

  const patch: Record<string, any> = { recording_url: recordingUrl, transcript, duration_s: durationS };
  if (aiNote) patch.ai_note = aiNote;

  if (recent?.id) {
    // Don't overwrite the human's chosen outcome; only fill it if it was blank.
    if (!recent.disposition && ai?.disposition) patch.disposition = ai.disposition;
    const { error } = await db.from('activities').update(patch).eq('id', recent.id);
    if (error) console.error('recording attach update', error);
  } else {
    const { error } = await db.from('activities').insert({
      lead_id: leadId, kind: 'call', direction: 'out',
      disposition: ai?.disposition ?? null,
      ai_note: aiNote ?? null, recording_url: recordingUrl, transcript, duration_s: durationS,
    });
    if (error) console.error('recording attach insert', error);
  }

  return new Response('', { status: 200 });
}
