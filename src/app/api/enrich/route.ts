// POST /api/enrich  { salon, city? }
// Looks a business up on the Google Places API (New) and returns the fields we
// can fill: phone, website, a tidy "City, ST", the full address, and hours.
// Returns { found: false } when nothing matches or the key isn't configured.

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
  [/calendly\.com/i, 'Calendly'],
];
function detectBooking(html: string): string | undefined {
  for (const [re, name] of BOOKING_FINGERPRINTS) if (re.test(html)) return name;
  return undefined;
}
// Fetch a salon's homepage (bounded) and sniff which booking platform it uses.
async function bookingFromSite(url: string): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RelayBot/1.0)' }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const html = (await res.text()).slice(0, 300000);
    return detectBooking(html);
  } catch { return undefined; }
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
      body: JSON.stringify({ textQuery, maxResultCount: 1 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('enrich places error', res.status, txt.slice(0, 200));
      return Response.json({ found: false, error: 'Lookup failed.' }, { status: 502 });
    }
    const data = await res.json();
    const p = data?.places?.[0];
    if (!p) return Response.json({ found: false });

    const website = p.websiteUri ? String(p.websiteUri).replace(/^https?:\/\//, '').replace(/\/$/, '') : undefined;
    // If they have a site, sniff the booking platform off it (best-effort).
    const bookingSystem = p.websiteUri ? await bookingFromSite(p.websiteUri) : undefined;
    return Response.json({
      found: true,
      name: p.displayName?.text || undefined,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || undefined,
      website,
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
