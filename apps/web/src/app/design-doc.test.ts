import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCssVars } from '../test/css';

const vars = readCssVars('src/app/globals.css');
const doc = readFileSync('DESIGN.md', 'utf8');
// readCssVars lower-cases values, so rows are compared case-insensitively.
const docLower = doc.toLowerCase();

function section(heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

describe('DESIGN.md', () => {
  it.each(Object.entries(vars).filter(([name]) => name.startsWith('--fb-')))(
    'documents %s with its exact value',
    (name, value) => {
      const row = docLower
        .split('\n')
        .find((line) => line.includes(`\`${name}\``) && line.includes(`\`${value}\``));
      expect(row, `${name}: ${value}`).toBeDefined();
    },
  );

  it.each([
    'Copied from feedbouncer-website',
    'App-only tokens',
    'Accessibility deviations',
    'Keeping in sync',
  ])('has the "%s" section', (heading) => {
    expect(doc).toContain(`## ${heading}`);
  });

  it('files app-only tokens and the accent-text deviation under the right headings', () => {
    const appOnly = section('App-only tokens');
    for (const name of [
      '--fb-input',
      '--fb-danger',
      '--fb-accent-strong',
      '--fb-leading-heading',
      '--fb-form-maxw',
    ])
      expect(appOnly).toContain(name);
    expect(section('Accessibility deviations')).toContain('--fb-accent-text');
  });
});
