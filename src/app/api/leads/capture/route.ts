import { supabaseAdmin } from '@/lib/supabase';
import { toE164 } from '@/lib/csv';

const DEFAULT_CADENCE = '11111111-1111-1111-1111-111111111111';

// POST /api/leads/capture
// Public inbound-lead capture (Book-a-demo page). Uses the service role so it
// works with no auth; new leads land unassigned (owner_rep_id null) so an admin
// sees them, tagged source='book-a-demo' and started as a hot inbound lead.
export async function POST(req: Request) {
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }

  const salon = String(payload.salon || '').trim();
  const contactName = String(payload.contactName || '').trim();
  const phone = String(payload.phone || '').trim();
  const email = String(payload.email || '').trim();
  const city = String(payload.city || '').trim();
  const notes = String(payload.notes || '').trim();
  // Optional overrides (e.g. the browser extension adds outbound prospects).
  const STAGES = ['new', 'working', 'hot', 'won', 'cold'];
  const source = ['book-a-demo', 'extension'].includes(payload.source) ? payload.source : 'book-a-demo';
  const stage = STAGES.includes(payload.stage) ? payload.stage : (source === 'extension' ? 'new' : 'hot');
  const inbound = source === 'book-a-demo';

  if (!salon) return Response.json({ error: 'Salon name is required.' }, { status: 400 });
  if (!phone && !email) return Response.json({ error: 'A phone or email is required.' }, { status: 400 });

  const db = supabaseAdmin();
  if (!db) return Response.json({ error: 'Not configured.' }, { status: 503 });

  const { data: lead, error } = await db
    .from('leads')
    .insert({
      salon,
      city: city || null,
      phone: toE164(phone) ?? (phone || null),
      email: email || null,
      source,
      stage,
      cadence_id: DEFAULT_CADENCE,
      cadence_pos: 0,
      owner_rep_id: null,
    })
    .select('id')
    .single();

  if (error || !lead) {
    console.error('capture insert', error);
    return Response.json({ error: 'Could not save.' }, { status: 500 });
  }

  if (contactName || phone || email) {
    await db.from('contacts').insert({
      lead_id: lead.id,
      name: contactName || salon,
      role: 'Owner',
      phone: toE164(phone) ?? (phone || null),
      email: email || null,
      is_primary: true,
    });
  }

  await db.from('activities').insert({
    lead_id: lead.id,
    kind: 'note',
    direction: inbound ? 'in' : 'out',
    ai_note: inbound ? 'Requested a demo through the booking page.' : 'Added from the browser while prospecting.',
    body: notes || (inbound ? 'Inbound demo request — no message left.' : 'Added via the Relay browser extension.'),
  });

  return Response.json({ ok: true, id: lead.id });
}
