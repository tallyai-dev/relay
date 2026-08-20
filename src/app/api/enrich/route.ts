// POST /api/enrich  { salon, city? }
// Looks a business up on the Google Places API (New) and returns the fields we
// can fill: phone, website, a tidy "City, ST", the full address, and hours.
// Returns { found: false } when nothing matches or the key isn't configured.

// Booking detection probes a few pages, so give the function extra headroom.
export const maxDuration = 26;

// Booking-platform fingerprints — matched against the salon's website HTML.
// Domain-based on purpose (avoids false positives on words like "boulevard").
const BOOKING_FINGERPRINTS: [RegExp, string][] = [
  [/vagaro\.com/i, 'Vagaro'],
  [/blvd\.co|joinblvd|boulevard\.io/i, 'Boulevard'],
  [/booksy\.com/i, 'Booksy'],
  [/fresha\.com/i, 'Fresha'],
  [/glossgenius\.com/i, 'GlossGenius'],
  [/schedulicity\.com/i, 'Schedulicity'],
  [/mindbodyonline\.com/i, 'Mindbody'],
  [/styleseat\.com/i, 'StyleSeat'],
  [/acuityscheduling\.com|squarespacescheduling\.com/i, 'Acuity'],
  [/squareup\.com\/(appointments|book)|book\.squareup\.com|square\.site/i, 'Square Appointments'],
  [/gettimely\.com/i, 'Timely'],
  [/phorest\.com|phorestsalonsoftware/i, 'Phorest'],
  [/setmore\.com/i, 'Setmore'],
  [/booker\.com/i, 'Booker'],
  [/meevo\.com|meevo2/i, 'Meevo'],
  [/rosysalonsoftware\.com/i, 'Rosy'],
  [/saloniris|daysmart/i, 'DaySmart / Salon Iris'],
  [/wellnessliving\.com/i, 'WellnessLiving'],
  [/zenoti\.com/i, 'Zenoti'],
  [/jane\.app|janeapp\.com/i, 'Jane'],
  [/simplybook\.me/i, 'SimplyBook.me'],
  [/calendly\.com/i, 'Calendly'],
];
function detectBooking(html: string): string | undefined {
  for (const [re, name] of BOOKING_FINGERPRINTS) if (re.test(html)) return name;
  return undefined;
}

// Bounded fetch of a URL's HTML (empty string on any failure/timeout).
async function fetchText(url: string, ms: number): Promise<string> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RelayBot/1.0; +https://tallyai-relay.netlify.app)' }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return '';
    return (await res.text()).slice(0, 400000);
  } catch { return ''; }
}

// Pull the best business email out of a page's HTML: prefer mailto: links, then
// inline addresses; drop image sprites, platform/no-reply junk; prefer one on the
// salon's own domain.
function extractEmail(html: string, domain: string): string | undefined {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const mailto = /mailto:([^"'?>\s]+)/gi;
  while ((m = mailto.exec(html))) { try { found.add(decodeURIComponent(m[1]).trim().toLowerCase()); } catch { found.add(m[1].trim().toLowerCase()); } }
  const inline = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = inline.exec(html))) found.add(m[0].toLowerCase());
  const bad = /\.(png|jpe?g|gif|webp|svg|ico)$|@2x|@3x|sentry|wix|squarespace|godaddy|cloudflare|shopify|\.wixpress|example\.|yourname|your-?email|domain\.com|no-?reply|noreply|@sentry|placeholder/i;
  const list = [...found].filter((e) => e.includes('@') && e.length < 64 && !bad.test(e));
  if (!list.length) return undefined;
  const d = (domain || '').replace(/^www\./, '');
  return list.find((e) => d && e.endsWith('@' + d)) || list.find((e) => d && e.endsWith('.' + d)) || list[0];
}

// One website crawl that finds BOTH the booking platform and an email. Booking
// widgets and emails usually live on subpages (book / contact), and many salon
// homepages are JS-only stubs — so we scan the homepage plus its book/contact
// links plus a set of common paths, all in one pass.
const COMMON_PATHS = ['/book-online', '/book-now', '/book', '/booking', '/online-booking', '/appointments', '/schedule', '/contact', '/contact-us', '/about'];
async function scanSite(url: string): Promise<{ bookingSystem?: string; email?: string }> {
  const base = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let origin = ''; let domain = '';
  try { const u = new URL(base); origin = u.origin; domain = u.hostname.replace(/^www\./, ''); } catch { return {}; }

  const home = await fetchText(base, 4500);
  const candidates = new Set<string>();
  if (home) {
    const re = /href\s*=\s*["']([^"'#]+)["']/gi; let m: RegExpExecArray | null; let n = 0;
    while ((m = re.exec(home)) && n < 80) {
      n++;
      if (!/book|appoint|schedul|reserv|online|contact|about/i.test(m[1])) continue;
      try { const u = new URL(m[1], base); if (u.origin === origin) candidates.add(u.href.split('#')[0]); } catch { /* ignore */ }
    }
  }
  for (const p of COMMON_PATHS) candidates.add(origin + p);

  const others = await Promise.all([...candidates].slice(0, 8).map((u) => fetchText(u, 3500)));
  let bookingSystem: string | undefined; let email: string | undefined;
  for (const html of [home, ...others]) {
    if (!html) continue;
    if (!bookingSystem) bookingSystem = detectBooking(html);
    if (!email) email = extractEmail(html, domain);
    if (bookingSystem && email) break;
  }
  return { bookingSystem, email };
}

function cityStateFrom(addr: string): string | undefined {
  // "123 Main St, Denver, CO 80202, USA" -> "Denver, CO"
  const parts = (addr || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const m = parts[i].match(/^([A-Z]{2})\b/);
    if (m && parts[i - 1]) return `${parts[i - 1]}, ${m[1]}`;
  }
  return undefined;
}

export async function POST(req: Request) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return Response.json({ found: false, error: 'Places API not configured.' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const salon = String(body.salon || '').trim();
  const city = String(body.city || '').trim();
  if (!salon) return Response.json({ found: false, error: 'Salon name required.' }, { status: 400 });

  const textQuery = city ? `${salon} ${city}` : salon;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress,places.regularOpeningHours.weekdayDescriptions',
      },
      body: JSON.stringify({ textQuery, maxResultCount: 5 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('enrich places error', res.status, txt.slice(0, 200));
      return Response.json({ found: false, error: 'Lookup failed.' }, { status: 502 });
    }
    const data = await res.json();
    const places: any[] = data?.places || [];
    if (!places.length) return Response.json({ found: false });

    // Places returns the top matches; the first isn't always the best record.
    // Prefer a close name match that actually HAS a website (a suite/partial
    // listing often matches the name but carries no site), then phone.
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(salon);
    const p = places
      .map((pl) => {
        const nm = norm(pl.displayName?.text || '');
        let score = 0;
        if (nm && nm === target) score += 4;
        else if (nm && (nm.includes(target) || target.includes(nm))) score += 2;
        if (pl.websiteUri) score += 3;
        if (pl.nationalPhoneNumber || pl.internationalPhoneNumber) score += 1;
        return { pl, score };
      })
      .sort((a, b) => b.score - a.score)[0].pl;

    const website = p.websiteUri ? String(p.websiteUri).replace(/^https?:\/\//, '').replace(/\/$/, '') : undefined;
    // If they have a site, crawl it for the booking platform + an email (best-effort).
    const site = p.websiteUri ? await scanSite(p.websiteUri) : {};
    // Many salons' "website" IS their booking platform (glossgenius.com,
    // vagaro.com, booksy.com…). Detect that straight from the URL — no crawl
    // needed, and it works even when the page is a JS-only stub.
    const bookingSystem = site.bookingSystem || (p.websiteUri ? detectBooking(p.websiteUri) : undefined);
    return Response.json({
      found: true,
      name: p.displayName?.text || undefined,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || undefined,
      website,
      email: site.email,
      bookingSystem,
      city: p.formattedAddress ? cityStateFrom(p.formattedAddress) : undefined,
      address: p.formattedAddress || undefined,
      hours: p.regularOpeningHours?.weekdayDescriptions || undefined,
    });
  } catch (e: any) {
    console.error('enrich exception', e?.message);
    return Response.json({ found: false, error: 'Lookup failed.' }, { status: 502 });
  }
}
