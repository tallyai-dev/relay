import type { ImportRow } from './repo';

// Minimal, dependency-free CSV parser that handles quoted fields and commas.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

// Map arbitrary CSV headers to our import shape. Recognizes common column names.
export function mapToImportRows(text: string): ImportRow[] {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const header = rows[0].map(norm);
  const hasHeader = header.some((h) =>
    ['salon', 'business', 'name', 'company', 'phone', 'email', 'city'].includes(h)
  );
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const cols = hasHeader
    ? {
        salon: idx(['salon', 'business', 'businessname', 'company', 'name']),
        city: idx(['city', 'location']),
        phone: idx(['phone', 'phonenumber', 'mobile', 'tel']),
        email: idx(['email', 'emailaddress']),
        contactName: idx(['contact', 'contactname', 'owner', 'ownername', 'firstname']),
        role: idx(['role', 'title']),
      }
    : { salon: 0, city: 1, phone: 2, email: 3, contactName: 4, role: 5 };

  const dataRows = hasHeader ? rows.slice(1) : rows;
  return dataRows
    .map((r) => ({
      salon: cols.salon >= 0 ? r[cols.salon] || '' : '',
      city: cols.city >= 0 ? r[cols.city] : undefined,
      phone: cols.phone >= 0 ? r[cols.phone] : undefined,
      email: cols.email >= 0 ? r[cols.email] : undefined,
      contactName: cols.contactName >= 0 ? r[cols.contactName] : undefined,
      role: cols.role >= 0 ? r[cols.role] : undefined,
    }))
    .filter((r) => r.salon.trim());
}
