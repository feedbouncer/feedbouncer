import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_URL, SITE_URL } from '../site.config';
import { appRoot } from './lib/content';

const toml = readFileSync(join(appRoot, 'lychee.toml'), 'utf8');
const quoted = (key: string): string[] => {
  const block = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'm').exec(toml)?.[1] ?? '';
  return [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
};

describe('lychee.toml', () => {
  it('maps the base path onto the build directory, which has no such folder', () => {
    const [remap] = quoted('remap');
    expect(remap).toBeDefined();
    const [pattern, replacement] = remap!.split(' ') as [string, string];
    const root = 'file:///repo/apps/docs/build';
    const base = BASE_URL.replace(/\/$/, '');
    for (const path of [`${base}/docs/x`, `${base}/docs/x/`, base])
      expect(`${root}${path}`.replace(new RegExp(pattern), replacement)).toBe(
        `${root}${path.slice(base.length)}`,
      );
  });

  it('excludes the product repository with or without a trailing slash', () => {
    const patterns = quoted('exclude').map((p) => new RegExp(p));
    for (const url of [
      'https://github.com/feedbouncer/feedbouncer',
      'https://github.com/feedbouncer/feedbouncer/blob/main/x',
    ])
      expect(
        patterns.some((p) => p.test(url)),
        url,
      ).toBe(true);
    expect(patterns.some((p) => p.test('https://github.com/feedbouncer/other'))).toBe(false);
  });

  it("excludes the site's own published URLs, which do not exist before the first deploy", () => {
    const patterns = quoted('exclude').map((p) => new RegExp(p));
    const base = SITE_URL + BASE_URL;
    for (const url of [base, `${base}docs/rules/precedence/`, `${base}search/`])
      expect(
        patterns.some((p) => p.test(url)),
        url,
      ).toBe(true);
  });
});
