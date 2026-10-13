// Production dependencies must be license-compatible with the project license.
// Unknown licenses fail until reviewed. Add a REVIEWED entry with a reason; never widen
// the allowlist to make a red test green without checking compatibility.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootManifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const PERMISSIVE = [
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Zlib',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
];
// Licenses whose code may be combined with and distributed under each project license.
const COMPATIBLE = {
  'AGPL-3.0-only': new Set([
    ...PERMISSIVE,
    'MPL-2.0',
    'LGPL-2.1-or-later',
    'LGPL-3.0-only',
    'LGPL-3.0-or-later',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
  ]),
};

// package name -> "<real SPDX id>, checked at <URL>" for packages with mislabeled metadata.
const REVIEWED = new Map();

/**
 * Accepts SPDX "A OR B" if any side is allowed, "A AND B" only if all are.
 * Only a single wrapping pair of parentheses is understood; any other grouping is
 * rejected so it gets a manual REVIEWED entry instead of being misread.
 */
function allowed(expr, ok) {
  const e = (expr.match(/^\(([^()]*)\)$/)?.[1] ?? expr).trim();
  if (/[()]/.test(e)) return false;
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some((p) => allowed(p, ok));
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every((p) => allowed(p, ok));
  return ok.has(e);
}

test('production dependency licenses are compatible with the project license', () => {
  const ok = COMPATIBLE[rootManifest.license];
  assert.ok(ok, `no compatibility table for ${rootManifest.license}; add one`);
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const bad = [];
  for (const [license, pkgs] of Object.entries(JSON.parse(out)))
    for (const p of pkgs)
      if (!allowed(license, ok) && !REVIEWED.has(p.name))
        bad.push(`${p.name}@${p.versions} (${license})`);
  assert.deepEqual(bad, [], `incompatible or unknown licenses:\n${bad.join('\n')}`);
});

test('SPDX expressions are evaluated strictly', () => {
  const ok = new Set(['MIT', 'Apache-2.0']);
  assert.ok(allowed('MIT', ok));
  assert.ok(allowed('(MIT OR SSPL-1.0)', ok));
  assert.ok(allowed('MIT AND Apache-2.0', ok));
  assert.ok(!allowed('MIT AND SSPL-1.0', ok));
  assert.ok(!allowed('(MIT OR Apache-2.0) AND SSPL-1.0', ok));
  assert.ok(!allowed('constructor', ok));
});
