import type { SearchVersion } from './core';

/** Maps Docusaurus doc versions ({ name, path: '/base/docs/next' }) to search versions. */
export function docsVersions(
  docVersions: { name: string; path: string }[],
  baseUrl: string,
): SearchVersion[] {
  const prefix = `${baseUrl}docs`;
  return docVersions.map((v) => ({
    name: v.name,
    path: v.path.slice(prefix.length).replace(/^\//, '').replace(/\/$/, ''),
  }));
}
