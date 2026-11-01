import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walk } from '../test/walk';

const expected: Record<string, RegExp> = {
  'orgs/[orgId]/layout.tsx': /AppShell/,
  '(auth)/layout.tsx': /AuthShell/,
  '(app)/layout.tsx': /AppShell/,
  '(standalone)/layout.tsx': /StandaloneShell/,
  'scan/layout.tsx': /ScanShell/,
  'page.tsx': /StandaloneShell/,
};

function coveredByShell(page: string, listed: Record<string, RegExp>): boolean {
  const rel = relative('src/app', page);
  if (rel in listed) return true;
  let dir = dirname(rel);
  while (dir !== '.') {
    if (`${dir}/layout.tsx` in listed) return true;
    dir = dirname(dir);
  }
  return false;
}

describe('route shells', () => {
  it.each(Object.entries(expected))('%s uses its shell', (f, re) =>
    expect(readFileSync(`src/app/${f}`, 'utf8')).toMatch(re),
  );

  it('every page.tsx is covered by a shell', () => {
    for (const p of walk('src/app', ['.tsx']).filter((f) => f.endsWith('/page.tsx')))
      expect(coveredByShell(p, expected), p).toBe(true);
  });

  it('layouts never fetch', () => {
    for (const f of Object.keys(expected).filter((f) => f.endsWith('layout.tsx')))
      expect(readFileSync(`src/app/${f}`, 'utf8')).not.toMatch(/serverGet|requireMe|fetch\(/);
  });
});
