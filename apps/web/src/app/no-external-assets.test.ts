import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { walk } from '../test/walk';

const EXTERNAL =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|next\/font\/google|feedbouncer\.com|use\.typekit|cdn\.jsdelivr|unpkg\.com|url\(\s*["']?https?:/;

describe('no external assets', () => {
  it('references no font, CDN or marketing hosts in source', () => {
    const offenders = walk('src', ['.ts', '.tsx', '.css']).filter((f) =>
      EXTERNAL.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
