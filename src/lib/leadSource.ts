// Lead source helpers shared by the Leads filter and the Staging deploy picker.
// A lead's `source` is free text; null/empty means "no source" (e.g. CSV imports).

/** Filter value for a source picker: 'all', NO_SOURCE, or a literal source string. */
export const ALL_SOURCES = 'all';
export const NO_SOURCE = '__none__';

const FRIENDLY: Record<string, string> = {
  instagram: 'Instagram',
  'book-a-demo': 'Book a demo',
  extension: 'Chrome extension',
  'new salon sourced by grok bot': 'New salon (Grok Bot)',
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'No source';
  return FRIENDLY[source] || source;
}

/** Distinct non-empty sources, sorted by label. */
export function distinctSources(leads: { source?: string | null }[]): string[] {
  const set = new Set<string>();
  for (const l of leads) if (l.source) set.add(l.source);
  return Array.from(set).sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
}

/** Does a lead match a picker value ('all' | NO_SOURCE | source)? */
export function matchesSource(source: string | null | undefined, filter: string): boolean {
  if (filter === ALL_SOURCES) return true;
  if (filter === NO_SOURCE) return !source;
  return source === filter;
}

/**
 * deployLeads' sourceFilter: undefined = any source (legacy behavior),
 * null = only leads with no source, string = only that source.
 */
export type DeploySourceFilter = string | null | undefined;

export function pickerToDeployFilter(filter: string): DeploySourceFilter {
  if (filter === ALL_SOURCES) return undefined;
  if (filter === NO_SOURCE) return null;
  return filter;
}

export function deployFilterMatches(source: string | null | undefined, f: DeploySourceFilter): boolean {
  if (f === undefined) return true;
  if (f === null) return !source;
  return source === f;
}

/** Pick the oldest `count` staged ids matching the filter (pool must be oldest-first). */
export function pickStaged<T extends { id: string; deployed?: boolean; source?: string | null }>(
  leads: T[], count: number, f: DeploySourceFilter,
): string[] {
  return leads
    .filter((l) => l.deployed === false && deployFilterMatches(l.source, f))
    .slice(0, Math.max(0, count))
    .map((l) => l.id);
}
