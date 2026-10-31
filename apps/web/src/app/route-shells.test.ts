import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walk } from '@/test/walk';

const expected: Record<string, RegExp> = {
  'orgs/[orgId]/layout.tsx': /AppShell/,
  'orgs/[orgId]/brands/[brandId]/layout.tsx': /BrandSubNav/,
  ...Object.fromEntries(
    ['login', 'sign-up', 'forgot-password', 'reset-password', 'invite', 'verified'].map((r) => [
      `${r}/layout.tsx`,
      /AuthShell/,
    ]),
  ),
  ...Object.fromEntries(
    ['account', 'hidden-today', 'alerts', 'reports'].map((r) => [
      `${r}/layout.tsx`,
      /StandaloneShell/,
    ]),
  ),
  'orgs/page.tsx': /AppShell/,
  'page.tsx': /StandaloneShell/,
};

function coveredByShell(page: string, listed: Record<string, RegExp>): boolean {
  const rel = relative('src/app', page);
  if (rel in listed || rel.startsWith('scan/')) return true;
  let dir = dirname(rel);
  while (dir !== '.') {
    if (`${dir}/layout.tsx` in listed) return true;
    dir = dirname(dir);
  }
  return false;
}

function pagesUnder(dir: string): string[] {
  return walk(dir, ['.tsx'])
    .filter((f) => f.endsWith('/page.tsx'))
    .map((f) => relative(dir, dirname(f)))
    .sort();
}

describe('route shells', () => {
  it.each(Object.entries(expected))('%s uses its shell', (f, re) =>
    expect(readFileSync(`src/app/${f}`, 'utf8')).toMatch(re),
  );

  it('every page.tsx is covered by a shell', () => {
    for (const p of walk('src/app', ['.tsx']).filter((f) => f.endsWith('/page.tsx')))
      expect(coveredByShell(p, expected), p).toBe(true);
  });

  it("top-level alerts/ and reports/ only hold the brief's pages", () => {
    expect(pagesUnder('src/app/alerts')).toEqual(['confirm', 'unsubscribe']);
    expect(pagesUnder('src/app/reports')).toEqual(['unsubscribe']);
  });

  it('layouts never fetch', () => {
    for (const f of Object.keys(expected).filter((f) => f.endsWith('layout.tsx')))
      expect(readFileSync(`src/app/${f}`, 'utf8')).not.toMatch(/serverGet|requireMe|fetch\(/);
  });

  it('there is no orgs/layout.tsx', () =>
    expect(existsSync('src/app/orgs/layout.tsx')).toBe(false));
});
