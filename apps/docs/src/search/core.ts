export interface SearchVersion {
  name: string;
  /** The segment after /docs/ ('' for the default version). */
  path: string;
}

export interface PagefindHit {
  url: string;
  meta: { title?: string };
  plain_excerpt?: string;
}

export interface Pagefind {
  search(
    term: string,
    options?: { filters: { version: string } },
  ): Promise<{ results: { id: string; data(): Promise<PagefindHit> }[] }>;
}

export interface SearchResult {
  url: string;
  title: string;
  excerpt: string;
}

export const SEARCH_SUGGESTIONS: { title: string; to: string }[] = [
  { title: 'Concepts', to: '/docs/concepts/overview' },
  { title: 'Rules', to: '/docs/rules/overview' },
  { title: 'API reference', to: '/docs/api/overview' },
  { title: 'MCP setup', to: '/docs/mcp/overview' },
  { title: 'Glossary', to: '/docs/concepts/glossary' },
  { title: 'API quickstart', to: '/docs/api/quickstart' },
  { title: 'Verify your MCP setup', to: '/docs/mcp/verify' },
];

const MAX_FALLBACK_TERMS = 5;
const MAX_FALLBACK_RESULTS = 5;

export function versionForPath(pathname: string, versions: SearchVersion[]): string {
  const segment = /\/docs\/([^/]+)/.exec(pathname)?.[1];
  const named = versions.find((v) => v.path !== '' && v.path === segment);
  return (named ?? versions.find((v) => v.path === '') ?? versions[0])?.name ?? 'current';
}

export function safeResultUrl(url: string, baseUrl: string): string | null {
  if (!url.startsWith(baseUrl) || url.includes('//') || /[\\\u0000-\u001f]/.test(url)) return null;
  const { pathname } = new URL(url, 'http://localhost');
  return pathname.startsWith(baseUrl) ? url : null;
}

export function fallbackQueries(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].slice(0, MAX_FALLBACK_TERMS);
}

async function load(
  pagefind: Pagefind,
  term: string,
  version: string,
  baseUrl: string,
): Promise<SearchResult[]> {
  const { results } = await pagefind.search(term, { filters: { version } });
  const hits = await Promise.all(results.map((r) => r.data()));
  return hits.flatMap((h) => {
    const url = safeResultUrl(h.url, baseUrl);
    return url ? [{ url, title: h.meta.title ?? url, excerpt: h.plain_excerpt ?? '' }] : [];
  });
}

export async function runSearch(
  pagefind: Pagefind,
  q: string,
  version: string,
  baseUrl: string,
): Promise<SearchResult[]> {
  const direct = await load(pagefind, q, version, baseUrl);
  if (direct.length > 0) return direct;
  const merged = new Map<string, SearchResult>();
  for (const term of fallbackQueries(q))
    for (const r of await load(pagefind, term, version, baseUrl)) merged.set(r.url, r);
  return [...merged.values()].slice(0, MAX_FALLBACK_RESULTS);
}
