import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cn, FONT_SIZES } from './utils';

describe('cn', () => {
  it.each(FONT_SIZES)('keeps custom font size text-%s next to a text colour', (size) => {
    expect(cn(`text-${size}`, 'text-good')).toBe(`text-${size} text-good`);
  });

  it('registers exactly the --text-* sizes declared in globals.css', () => {
    const css = readFileSync('src/app/globals.css', 'utf8');
    const declared = [...css.matchAll(/^\s*--text-([\w-]+):/gm)]
      .map((m) => m[1]!)
      .filter((name) => !name.includes('--'));
    expect([...FONT_SIZES].sort()).toEqual(declared.sort());
  });

  it('still dedupes real conflicts', () => {
    expect(cn('text-ui', 'text-small')).toBe('text-small');
    expect(cn('text-good', 'text-danger')).toBe('text-danger');
  });
});
