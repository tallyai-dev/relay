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

// Normalize a phone to E.164 (+1XXXXXXXXXX). Returns null if it can't be made sense of.
export function toE164(p?: string): string | null {
  if (!p) return null;
  const raw = p.replace(/[^\d+]/g, '');
  if (raw.startsWith('+') && raw.replace(/\D/g, '').length >= 11) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 8 && d.length <= 15) return '+' + d; // best-effort international
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmail(e?: string): boolean {
  return !!e && EMAIL_RE.test(e.trim());
}

export type RowStatus = 'ready' | 'dup_batch' | 'dup_existing' | 'invalid';
export interface AnalyzedRow {
  salon: string;
  city?: string;
  phone?: string;   // E.164 when valid
  email?: string;   // only kept when valid
  contactName?: string;
  role?: string;
  status: RowStatus;
  warnings: string[];
}
export interface ImportAnalysis {
  rows: AnalyzedRow[];
  detected: { field: string; column: string }[];
  hasHeader: boolean;
  summary: { total: number; ready: number; dupBatch: number; dupExisting: number; invalid: number; phonesFixed: number; emailsDropped: number };
}

const FIELD_ALIASES: Record<string, string[]> = {
  salon: ['salon', 'business', 'businessname', 'company', 'companyname', 'name', 'account'],
  city: ['city', 'location', 'town', 'area'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'tel', 'telephone', 'number'],
  email: ['email', 'emailaddress', 'mail'],
  contactName: ['contact', 'contactname', 'owner', 'ownername', 'firstname', 'fullname', 'person'],
  role: ['role', 'title', 'position'],
};

/**
 * Full import analysis: auto-maps columns, cleans phones to E.164, validates
 * emails, and flags duplicates (both within the file and against existing leads).
 * `existing` carries the current book's phone digits + salon|city keys.
 */
export function analyzeImport(text: string, existing: { phones: Set<string>; keys: Set<string> }): ImportAnalysis {
  const rows = parseCSV(text);
  const empty: ImportAnalysis = { rows: [], detected: [], hasHeader: false, summary: { total: 0, ready: 0, dupBatch: 0, dupExisting: 0, invalid: 0, phonesFixed: 0, emailsDropped: 0 } };
  if (!rows.length) return empty;

  const header = rows[0].map(norm);
  const hasHeader = header.some((h) => Object.values(FIELD_ALIASES).some((a) => a.includes(h)));
  const findCol = (field: string) => header.findIndex((h) => FIELD_ALIASES[field].includes(h));
  const cols = hasHeader
    ? { salon: findCol('salon'), city: findCol('city'), phone: findCol('phone'), email: findCol('email'), contactName: findCol('contactName'), role: findCol('role') }
    : { salon: 0, city: 1, phone: 2, email: 3, contactName: 4, role: 5 };

  const detected: { field: string; column: string }[] = [];
  const labels: Record<string, string> = { salon: 'Salon', city: 'City', phone: 'Phone', email: 'Email', contactName: 'Contact', role: 'Role' };
  for (const f of Object.keys(labels)) {
    const i = (cols as any)[f];
    if (i >= 0) detected.push({ field: labels[f], column: hasHeader ? (rows[0][i] || '').trim() || `column ${i + 1}` : `column ${i + 1}` });
  }

  const data = hasHeader ? rows.slice(1) : rows;
  const seen = new Set<string>();
  let phonesFixed = 0, emailsDropped = 0;
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] || '').trim() : '');

  const out: AnalyzedRow[] = data.map((r) => {
    const salon = get(r, cols.salon);
    const city = get(r, cols.city);
    const rawPhone = get(r, cols.phone);
    const rawEmail = get(r, cols.email);
    const warnings: string[] = [];

    let phone: string | undefined;
    if (rawPhone) {
      const e = toE164(rawPhone);
      if (e) { phone = e; if (e !== rawPhone) phonesFixed++; }
      else warnings.push('phone unreadable');
    }
    let email: string | undefined;
    if (rawEmail) {
      if (validEmail(rawEmail)) email = rawEmail.trim();
      else { warnings.push('bad email dropped'); emailsDropped++; }
    }

    let status: RowStatus = 'ready';
    if (!salon) status = 'invalid';
    else {
      const phone10 = phone ? phone.replace(/\D/g, '').slice(-10) : '';
      const key = phone10 || `${salon.toLowerCase()}|${city.toLowerCase()}`;
      if (phone10 && existing.phones.has(phone10)) status = 'dup_existing';
      else if (!phone10 && existing.keys.has(key)) status = 'dup_existing';
      else if (seen.has(key)) status = 'dup_batch';
      else seen.add(key);
    }
    return { salon, city: city || undefined, phone, email, contactName: get(r, cols.contactName) || undefined, role: get(r, cols.role) || undefined, status, warnings };
  });

  const count = (s: RowStatus) => out.filter((r) => r.status === s).length;
  return {
    rows: out, detected, hasHeader,
    summary: { total: out.length, ready: count('ready'), dupBatch: count('dup_batch'), dupExisting: count('dup_existing'), invalid: count('invalid'), phonesFixed, emailsDropped },
  };
}

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
