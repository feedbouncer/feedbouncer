import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, flatten, mix } from '../test/contrast';
import { readCssVars } from '../test/css';

const v = readCssVars('src/app/globals.css');
const SURFACES = ['--fb-bg', '--fb-bg-elevated', '--fb-bg-card'];

describe('design tokens', () => {
  it('copies website tokens verbatim', () => {
    expect(v).toMatchObject({
      '--fb-bg': '#0b0e14',
      '--fb-bg-elevated': '#121622',
      '--fb-bg-card': '#161b29',
      '--fb-border': '#242b3d',
      '--fb-text': '#e8eaf0',
      '--fb-text-dim': '#9aa3b8',
      '--fb-text-faint': '#7f889d',
      '--fb-accent': '#e06952',
      '--fb-accent-dim': '#e0695233',
      '--fb-accent-hover': '#ea7e67',
      '--fb-good': '#34b483',
      '--fb-shadow-color': '10, 6, 5',
      '--radius': '12px',
      '--fb-maxw': '1120px',
      '--fb-gutter': '24px',
      '--fb-header-h': '68px',
      '--fb-text-ui': '14.5px',
      '--fb-text-section': '22px',
      '--fb-text-page': 'clamp(26px, 4vw, 36px)',
      '--fb-text-hero': 'clamp(36px, 6vw, 62px)',
      '--fb-radius-control': '8px',
      '--fb-radius-pill': '999px',
      '--fb-ease-out': 'cubic-bezier(.16,1,.3,1)',
      '--fb-dur-hover': '200ms',
      '--fb-shadow-raised': '0 18px 40px -22px rgba(var(--fb-shadow-color), 0.7)',
    });
  });

  it.each([
    '--fb-text',
    '--fb-text-dim',
    '--fb-text-faint',
    '--fb-accent',
    '--fb-good',
    '--fb-danger',
  ])('%s meets 4.5:1 on every surface', (fg) => {
    for (const bg of SURFACES) expect(contrastRatio(v[fg]!, v[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('coral-strong meets 4.5:1 on the coral tint over every surface', () => {
    for (const bg of SURFACES)
      expect(
        contrastRatio(v['--fb-accent-strong']!, flatten(v['--fb-accent-dim']!, v[bg]!)),
      ).toBeGreaterThanOrEqual(4.5);
  });

  it('good text meets 4.5:1 on the good/15 tint; danger text on the danger/12 tint', () => {
    for (const bg of SURFACES) {
      expect(
        contrastRatio(v['--fb-good']!, mix(v['--fb-good']!, v[bg]!, 0.15)),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(v['--fb-danger']!, mix(v['--fb-danger']!, v[bg]!, 0.12)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('on-coral text meets 4.5:1 on accent and accent-hover', () => {
    expect(contrastRatio(v['--fb-accent-text']!, v['--fb-accent']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v['--fb-accent-text']!, v['--fb-accent-hover']!)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('control borders and focus ring meet 3:1 (WCAG 1.4.11)', () => {
    for (const bg of SURFACES) {
      expect(contrastRatio(v['--fb-input']!, v[bg]!)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(v['--fb-accent']!, v[bg]!)).toBeGreaterThanOrEqual(3);
    }
  });

  it('raw values live only in :root', () => {
    const rest = readFileSync('src/app/globals.css', 'utf8').replace(/:root\s*\{[^}]*\}/, '');
    expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rest).not.toMatch(/\b\d+(\.\d+)?ms\b|cubic-bezier\(/);
  });

  it('is dark-only', () => {
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toMatch(/color-scheme:\s*dark/);
    expect(css).not.toMatch(/^\.dark\s*\{/m);
  });
});
