// Netlify scheduled function — every minute, poke the reminders tick so
// callback pushes go out on time. Needs CRON_SECRET in the site env; the
// site URL comes from Netlify's own URL var (or PUBLIC_BASE_URL).
export default async () => {
  const base = process.env.PUBLIC_BASE_URL || process.env.URL || 'https://tallyai-relay.netlify.app';
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return new Response('CRON_SECRET not set', { status: 200 });
  try {
    const res = await fetch(`${base}/api/reminders/tick`, { method: 'POST', headers: { 'x-relay-cron': secret } });
    const txt = await res.text();
    console.log('reminders-tick', res.status, txt.slice(0, 200));
  } catch (e) {
    console.error('reminders-tick failed', e?.message || e);
  }
  return new Response('ok', { status: 200 });
};

export const config = { schedule: '* * * * *' };
