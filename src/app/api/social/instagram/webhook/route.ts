import { createHmac, timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { igProfile, igReplyToComment, igPrivateReply, igSendDm, matchRule, metaConfigured } from '@/lib/social';

// Instagram webhook (Meta Graph API).
//   GET  — subscription handshake (hub.mode / hub.verify_token / hub.challenge)
//   POST — events: DMs (object 'instagram', entry[].messaging[]) and comments
//          on our posts (entry[].changes[] field 'comments').
//
// Every event → social_events (deduped on the Meta id) → matched to a lead by
// IGSID or @handle, or a NEW lead is created on the Instagram warm cadence with
// her words in the notes. DMs also land in the Inbox as channel 'dm'. Keyword
// rules can reply publicly + DM the link when SOCIAL_AUTO_REPLY=on.
//
// Setup (Meta App Dashboard → Webhooks → Instagram): subscribe to `messages`
// and `comments`, callback = {PUBLIC_BASE_URL}/api/social/instagram/webhook.
// Until Meta app review passes, only the app's own test users trigger events.

export const dynamic = 'force-dynamic';
const INSTAGRAM_CADENCE = '22222222-2222-2222-2222-222222222222';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const mode = u.searchParams.get('hub.mode');
  const token = u.searchParams.get('hub.verify_token');
  const challenge = u.searchParams.get('hub.challenge') || '';
  if (mode === 'subscribe' && token && token === process.env.META_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
}

function verifySignature(raw: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET || '';
  if (!secret) return false; // never accept unsigned traffic
  const sig = (header || '').replace(/^sha256=/, '');
  if (!sig) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  try { return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature', { status: 403 });
  }
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return new Response('ok', { status: 200 }); }
  const db = supabaseAdmin();
  if (!db) return new Response('ok', { status: 200 });

  const ourId = process.env.META_IG_ACCOUNT_ID || '';
  const entries: any[] = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    // ── DMs ──────────────────────────────────────────────────────────────
    for (const ev of entry.messaging || []) {
      const senderId = String(ev.sender?.id || '');
      const text = String(ev.message?.text || '').trim();
      const mid = String(ev.message?.mid || '');
      if (!senderId || ev.message?.is_echo || senderId === ourId) continue; // our own outbound
      if (!text && !ev.message?.attachments) continue;
      await handleEvent(db, {
        kind: 'dm', externalId: mid || `dm-${senderId}-${ev.timestamp}`, igUserId: senderId,
        text: text || '[attachment]', receivedAt: ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : new Date().toISOString(), raw: ev,
      });
    }
    // ── Comments on our posts ─────────────────────────────────────────────
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      const fromId = String(v.from?.id || '');
      if (!fromId || fromId === ourId) continue; // our own replies
      await handleEvent(db, {
        kind: 'comment', externalId: String(v.id || ''), igUserId: fromId, handle: v.from?.username ? String(v.from.username) : undefined,
        text: String(v.text || '').trim(), postId: v.media?.id ? String(v.media.id) : undefined, commentId: String(v.id || ''),
        receivedAt: new Date().toISOString(), raw: v,
      });
    }
  }
  return new Response('ok', { status: 200 });
}

interface Incoming {
  kind: 'dm' | 'comment'; externalId: string; igUserId: string; handle?: string; text: string;
  postId?: string; commentId?: string; receivedAt: string; raw: any;
}

async function handleEvent(db: NonNullable<ReturnType<typeof supabaseAdmin>>, ev: Incoming) {
  // Dedupe: Meta retries webhooks; the Meta id is unique.
  if (ev.externalId) {
    const { data: dupe } = await db.from('social_events').select('id').eq('external_id', ev.externalId).maybeSingle();
    if (dupe) return;
  }

  // 1. Match an existing lead — by IGSID first, then @handle.
  let lead: any = null;
  const { data: byId } = await db.from('leads').select('id, salon, handle, ig_user_id, owner_rep_id, cadence_id, stage').eq('ig_user_id', ev.igUserId).limit(1).maybeSingle();
  lead = byId || null;
  let handle = ev.handle || '';
  let name = '';
  if (!lead && !handle && metaConfigured()) {
    const p = await igProfile(ev.igUserId);
    handle = p?.username || ''; name = p?.name || '';
  }
  if (!lead && handle) {
    const { data: byHandle } = await db.from('leads').select('id, salon, handle, ig_user_id, owner_rep_id, cadence_id, stage').ilike('handle', `@${handle.replace(/[_%\\]/g, '\\$&')}`).limit(1).maybeSingle();
    lead = byHandle || null;
  }

  const rule = matchRule(ev.text);
  const now = new Date().toISOString();

  // 2. Create the lead when she's new — on the Instagram warm cadence, her
  //    words in the notes, due now so she lands at the top of Flow.
  let created = false;
  if (!lead) {
    const { data: ins, error } = await db.from('leads').insert({
      salon: name || (handle ? `@${handle}` : 'Instagram lead'),
      handle: handle ? `@${handle}` : null,
      ig_user_id: ev.igUserId,
      source: 'instagram',
      notes: ev.text ? `${ev.kind === 'dm' ? 'DM' : 'Comment'}: "${ev.text.slice(0, 400)}"` : null,
      stage: 'new',
      cadence_id: INSTAGRAM_CADENCE,
      cadence_pos: 0,
      owner_rep_id: process.env.SOCIAL_DEFAULT_REP_ID || null,
      next_action_at: now,
      last_social_at: now,
    }).select('id, salon, handle, ig_user_id, owner_rep_id, cadence_id, stage').single();
    if (error && (error as any).code === '23505') {
      // Lost the race with a parallel delivery (unique index on ig_user_id) — use hers.
      const { data: again } = await db.from('leads').select('id, salon, handle, ig_user_id, owner_rep_id, cadence_id, stage').eq('ig_user_id', ev.igUserId).limit(1).maybeSingle();
      lead = again || null;
    } else if (error || !ins) { console.error('social lead insert', error); }
    else {
      lead = ins; created = true;
      await db.from('contacts').insert({ lead_id: ins.id, name: name || (handle ? `@${handle}` : '—'), role: 'Owner', is_primary: true });
    }
  } else {
    // Known lead: refresh the window + IGSID, wake her up in the queue.
    const patch: Record<string, any> = { last_social_at: now, updated_at: now };
    if (!lead.ig_user_id) patch.ig_user_id = ev.igUserId;
    if (!lead.handle && handle) patch.handle = `@${handle}`;
    if (lead.stage !== 'won') patch.next_action_at = now;
    await db.from('leads').update(patch).eq('id', lead.id);
  }

  // 3. Log the event (and the DM into the Inbox).
  await db.from('social_events').insert({
    platform: 'instagram', kind: ev.kind, external_id: ev.externalId || null, ig_user_id: ev.igUserId,
    handle: handle ? `@${handle}` : null, text: ev.text, post_id: ev.postId || null, lead_id: lead?.id || null,
    rule: rule?.id || null, received_at: ev.receivedAt, raw: ev.raw,
  });
  if (ev.kind === 'dm') {
    await db.from('messages').insert({
      lead_id: lead?.id || null, channel: 'dm', direction: 'in', from_addr: ev.igUserId, to_addr: process.env.META_IG_ACCOUNT_ID || null,
      body: ev.text, provider_id: ev.externalId || null, is_read: false, created_at: ev.receivedAt,
    });
  } else if (lead?.id) {
    await db.from('activities').insert({
      lead_id: lead.id, kind: 'note', direction: 'in',
      ai_note: `Commented on our post${handle ? ` as @${handle}` : ''}${rule ? ` · ${rule.tag}` : ''}.`,
      body: ev.text || '[comment]',
    });
  }

  // 4. Keyword rule → reply. Only when switched on, only for someone who is
  //    NEW or has never been touched (never auto-DM a lead mid-conversation).
  const autoOn = (process.env.SOCIAL_AUTO_REPLY || '').toLowerCase() === 'on';
  if (rule && autoOn && metaConfigured() && lead?.id) {
    let untouched = created;
    if (!created) {
      const [{ count: acts }, { count: msgs }] = await Promise.all([
        db.from('activities').select('id', { count: 'exact', head: true }).eq('lead_id', lead.id).eq('direction', 'out'),
        db.from('messages').select('id', { count: 'exact', head: true }).eq('lead_id', lead.id).eq('direction', 'out'),
      ]);
      untouched = (acts || 0) === 0 && (msgs || 0) === 0; // an earlier auto-reply counts as contact
    }
    if (untouched) {
      try {
        if (ev.kind === 'comment' && ev.commentId) {
          if (rule.reply) await igReplyToComment(ev.commentId, rule.reply);
          if (rule.dm) await igPrivateReply(ev.commentId, rule.dm);
        } else if (ev.kind === 'dm' && rule.dm) {
          await igSendDm(ev.igUserId, rule.dm);
        }
        if (rule.dm) {
          await db.from('messages').insert({
            lead_id: lead.id, channel: 'dm', direction: 'out', from_addr: process.env.META_IG_ACCOUNT_ID || null, to_addr: ev.igUserId,
            body: `${rule.dm}\n\n— auto-reply · rule "${rule.id}"`, is_read: true,
          });
        }
        await db.from('social_events').update({ auto_replied: true }).eq('external_id', ev.externalId);
      } catch (e: any) {
        console.error('social auto-reply', e?.message);
      }
    }
  }
  // A "call within N hours" rule pulls the callback reminder forward.
  if (rule?.callWithinHours && lead?.id) {
    const at = new Date(Date.now() + rule.callWithinHours * 3_600_000).toISOString();
    await db.from('leads').update({ callback_at: at, callback_note: `Warm from Instagram (${rule.tag})`, callback_notified_at: null }).eq('id', lead.id).is('callback_at', null);
  }
}
