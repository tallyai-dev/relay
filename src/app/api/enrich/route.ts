// POST /api/enrich  { salon, city? }
// Looks a business up on the Google Places API (New) and returns the fields we
// can fill: phone, website, a tidy "City, ST", the full address, and hours.
// Returns { found: false } when nothing matches or the key isn't configured.

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
    return Response.json({
      found: true,
      name: p.displayName?.text || undefined,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || undefined,
      website,
      city: p.formattedAddress ? cityStateFrom(p.formattedAddress) : undefined,
      address: p.formattedAddress || undefined,
      hours: p.regularOpeningHours?.weekdayDescriptions || undefined,
    });
  } catch (e: any) {
    console.error('enrich exception', e?.message);
    return Response.json({ found: false, error: 'Lookup failed.' }, { status: 502 });
  }
}
