import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app/globals.css', 'utf8');

describe('base layer', () => {
  it.each([
    [
      ':focus-visible outline',
      /:where\(:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--fb-accent\)/,
    ],
    [
      'reduced-motion block',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*var\(--fb-dur-reduced\) !important/,
    ],
    ['overflow-wrap', /overflow-wrap:\s*anywhere/],
    ['accent-color', /accent-color:\s*var\(--fb-accent\)/],
    ['scrollbar-color', /scrollbar-color:/],
    ['aria-invalid', /\[aria-invalid=["']?true["']?\]/],
    ['dialog', /\[role=["']?dialog["']?\]/],
    ['empty state', /\[data-state=["']?empty["']?\]/],
    ['autofill', /-webkit-autofill/],
    ['row header reset', /th\[scope=['"]?row['"]?\]/],
    ['control height', /min-height:\s*40px/],
  ])('has %s', (_name, re) => {
    expect(css).toMatch(re);
  });
});
