import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScanShell } from './scan-shell';

const html = renderToStaticMarkup(
  <ScanShell>
    <p>child</p>
  </ScanShell>,
);

describe('ScanShell', () => {
  it('renders the scan header, grain wrapper and two decorative glows', () => {
    expect(html).toContain('data-shell="scan"');
    expect(html).toContain('scan-grain');
    expect(html).toContain('href="/scan"');
    expect(html).toContain('id="content"');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('leaves the skip link to the root layout', () => {
    expect(html).not.toContain('Skip to content');
  });
});

describe('scan effects in globals.css', () => {
  const css = readFileSync('src/app/globals.css', 'utf8');
  const rule = (sel: string) =>
    new RegExp(`${sel.replace(/[.:]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';

  it('embeds the grain as a data URI with no remote url', () => {
    const grain = rule('.scan-grain::after');
    expect(grain).toContain('data:image/svg+xml');
    expect(css).not.toContain('url(http');
  });

  it('hides all three effects under reduced motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)[\s\S]*$/.exec(css)?.[0] ?? '';
    for (const sel of ['.scan-glow-accent', '.scan-glow-good', '.scan-grain::after'])
      expect(block).toContain(sel);
    expect(block).toMatch(/display:\s*none/);
  });
});
