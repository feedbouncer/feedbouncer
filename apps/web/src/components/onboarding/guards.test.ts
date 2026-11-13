import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../..');
const webRoot = join(repoRoot, 'apps/web');

const GUARDED_DIRS = [
  join(repoRoot, 'apps/api/src/onboarding'),
  join(webRoot, 'src/components/onboarding'),
  join(webRoot, 'src/app/orgs/[orgId]/onboarding'),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = GUARDED_DIRS.flatMap(walk).filter((f) => !/\.test\./.test(f));
const tsxFiles = files.filter((f) => f.endsWith('.tsx'));
const read = (f: string): string => readFileSync(f, 'utf8');

const messages = JSON.parse(readFileSync(join(webRoot, 'messages/en.json'), 'utf8')) as Record<
  string,
  unknown
>;

function flatten(obj: unknown, prefix = ''): string[] {
  if (typeof obj === 'string') return [prefix];
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}
const leafKeys = flatten(messages);

describe('onboarding guards', () => {
  it('finds files to guard', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(tsxFiles.length).toBeGreaterThan(5);
  });

  it('no deployment branching or hosted dependencies', () => {
    const re =
      /process\.env|https?:\/\/|feedbouncer-cloud|paddle|billing|checkout|signup|telemetry/i;
    const offenders = files.filter((f) => re.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('no raw HTML', () => {
    const offenders = files.filter((f) => read(f).includes('dangerouslySetInnerHTML'));
    expect(offenders).toEqual([]);
  });

  it('all copy translatable', () => {
    // (?<!=) skips arrow functions (`=> expr`), which are not JSX text.
    const re = /(?<!=)>\s*[A-Za-z][^<{]*</;
    const offenders = tsxFiles.filter((f) => re.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('every t(...) key used exists in messages/en.json', () => {
    const missing: string[] = [];
    for (const f of tsxFiles) {
      const src = read(f);
      const ns = /(?:useTranslations|getTranslations)\(\s*'([^']+)'\s*\)/.exec(src)?.[1];
      if (!ns) continue;
      const callRe = /\bt(?:\.rich|\.has)?\(\s*(['`])((?:(?!\1).)*)\1/g;
      for (const m of src.matchAll(callRe)) {
        const key = m[2] ?? '';
        const full = `${ns}.${key}`;
        const pattern = new RegExp(
          `^${full
            .split(/\$\{[^}]*\}/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^.]+')}$`,
        );
        if (!leafKeys.some((k) => pattern.test(k))) missing.push(`${f}: ${full}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
