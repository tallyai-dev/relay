import twilio from 'twilio';
import { supabaseAdmin } from '@/lib/supabase';
import { twilioClient } from '@/lib/twilio';
import { BASE, leadByPhone, ringOrder, twimlResponse, recordCall, updateCall } from '@/lib/voice-server';

// POST /api/voice/inbound — the Voice webhook on the Relay number.
//
// "One callback number that rings YOU." Every call and voicemail hands the salon
// the Relay number; when she calls it back we look the caller up, find who
// dialed her last (then her owner, then everyone active), and ring that rep's
// cell + in-app client first — with a whisper ("Blush Beauty Bar, calling back —
// press 1") so a cell voicemail can never swallow the call. No answer in 20 s →
// the other reps' cells → Relay voicemail, logged onto the lead.
//
// Twilio walks the steps through the <Dial action> callback:
//   step 1: preferred rep(s)      step 2: everyone else      step 3: voicemail
export async function POST(req: Request) {
  const u = new URL(req.url);
  const step = parseInt(u.searchParams.get('step') || '1', 10) || 1;
  const tried = (u.searchParams.get('tried') || '').split(',').filter(Boolean);
  const leadIdQ = u.searchParams.get('leadId') || '';

  let form: FormData;
  try { form = await req.formData(); } catch { form = new FormData(); }
  const from = String(form.get('From') || '');
  const dialStatus = String(form.get('DialCallStatus') || '');
  const callSid = String(form.get('CallSid') || '');

  const twiml = new twilio.twiml.VoiceResponse();

  // A previous step's <Dial> ended: answered → we're done; otherwise fall through.
  if (step > 1 && (dialStatus === 'completed' || dialStatus === 'answered')) {
    await logAnswered(leadIdQ, tried[tried.length - 1]);
    if (callSid) {
      // Who actually picked up: several phones ring at once, so ask Twilio which leg answered.
      const answeredBy = await whoAnswered(String(form.get('DialCallSid') || ''), tried);
      await updateCall(callSid, { rep_id: answeredBy });
      await updateCall(callSid, { dial_status: 'answered', talk_s: parseInt(String(form.get('DialCallDuration') || '0'), 10) || null });
    }
    twiml.hangup();
    return twimlResponse(twiml.toString());
  }

  const lead = step === 1 ? await leadByPhone(from) : (leadIdQ ? await leadById(leadIdQ) : null);
  const leadId = lead?.id || leadIdQ;
  // Call history: the row exists from the first ring, so a missed call still shows.
  if (step === 1 && callSid) {
    await recordCall({ twilio_sid: callSid, direction: 'in', status: 'ringing', lead_id: lead?.id || null, from_number: from || null, to_number: String(form.get('To') || '') || null });
  }
  const who = lead ? `${lead.salon}${lead.contactName ? `, ${lead.contactName}` : ''}` : 'Unknown caller';
  const whisper = `${BASE}/api/voice/whisper?${new URLSearchParams({ who, kind: lead ? 'callback' : 'new' })}`;

  const order = await ringOrder([lead?.last_rep_id, lead?.owner_rep_id]);
  // Step 1 rings the preferred rep (or the first active rep when the caller is
  // unknown); step 2 rings whoever is left. Each step is its own <Dial>.
  const candidates = step === 1 ? order.slice(0, 1) : order.filter((r) => !tried.includes(r.id));

  // Step 1 always rings the in-app dialer too (a team with no cells on file
  // still gets the call); step 2 only runs when there is someone left to ring.
  if (step === 1 || candidates.length) {
    const nextTried = [...tried, ...candidates.map((r) => r.id)].join(',');
    const action = `${BASE}/api/voice/inbound?${new URLSearchParams({ step: String(step + 1), tried: nextTried, leadId: leadId || '' })}`;
    // Show the salon's number on the rep's phone when Twilio allows it; an
    // anonymous/blocked caller falls back to the Relay number.
    const cid = /^\+\d{8,15}$/.test(from) ? from : undefined;
    const dial = twiml.dial({ timeout: 20, answerOnBridge: true, action, method: 'POST', callerId: cid });
    if (step === 1) dial.client('rep'); // the in-app dialer, if anyone has it open
    for (const r of candidates) dial.number({ url: whisper, method: 'POST' }, r.forward_to!);
    return twimlResponse(twiml.toString());
  }

  // Nobody picked up (or nobody has a cell on file) → voicemail onto the lead.
  twiml.say({ voice: 'Polly.Joanna' }, "Hi, you've reached Tally. Sorry we missed you — leave your name and salon after the tone and we'll call you right back.");
  twiml.record({
    maxLength: 120,
    playBeep: true,
    action: `${BASE}/api/voice/voicemail?${new URLSearchParams({ leadId: leadId || '' })}`,
    method: 'POST',
    recordingStatusCallback: `${BASE}/api/voice/voicemail?${new URLSearchParams({ leadId: leadId || '' })}`,
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: ['completed'],
  });
  twiml.hangup();
  return twimlResponse(twiml.toString());
}

// The rep whose phone answered a ring-through (null = the in-app dialer or unknown).
// Best-effort and capped at 2.5 s so the caller never waits on it.
async function whoAnswered(dialCallSid: string, tried: string[]): Promise<string | null> {
  const client = twilioClient();
  const db = supabaseAdmin();
  if (!client || !db || !/^CA[0-9a-f]{32}$/i.test(dialCallSid) || !tried.length) return null;
  try {
    const leg: any = await Promise.race([
      client.calls(dialCallSid).fetch(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    const to = String(leg?.to || '');
    if (!to || to.startsWith('client:')) return null;
    const { data } = await db.from('reps').select('id, forward_to').in('id', tried);
    const tail = (p?: string | null) => (p || '').replace(/\D/g, '').slice(-10);
    return (data || []).find((r: any) => tail(r.forward_to) === tail(to))?.id || null;
  } catch (e) { console.error('whoAnswered', e); return null; }
}

async function leadById(id: string) {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data } = await db.from('leads').select('id, salon, phone, last_rep_id, last_rep_at, owner_rep_id, contacts(name, is_primary)').eq('id', id).maybeSingle();
  if (!data) return null;
  const cs: any[] = (data as any).contacts || [];
  const c = cs.find((x) => x.is_primary) || cs[0];
  return { ...data, contactName: c?.name && c.name !== '—' ? String(c.name) : '' };
}

// The salon called back and a rep answered — put it on the timeline and warm the lead.
async function logAnswered(leadId: string, repId?: string) {
  const db = supabaseAdmin();
  if (!db || !leadId) return;
  let repName = '';
  if (repId) {
    const { data } = await db.from('reps').select('name').eq('id', repId).maybeSingle();
    repName = data?.name || '';
  }
  await db.from('activities').insert({
    lead_id: leadId, rep_id: repId || null, kind: 'call', direction: 'in', disposition: 'connected',
    ai_note: `They called the Relay number back${repName ? ` — rang through to ${repName}` : ''}.`,
    body: 'Inbound return call.',
  });
  await db.from('leads').update({ stage: 'hot', updated_at: new Date().toISOString() }).eq('id', leadId).in('stage', ['new', 'working']);
}
