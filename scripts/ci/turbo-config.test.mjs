// Guards the Turborepo config invariants that CI correctness depends on.
// Background: PR #1 shipped with shared root config missing from
// globalDependencies, so editing it could replay a stale cached green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const turbo = JSON.parse(await readFile(new URL('../../turbo.json', import.meta.url), 'utf8'));

// Every root-level file that a workspace package extends, imports, or whose
// value changes task results. Adding a new shared root config? Add it here
// AND to turbo.json globalDependencies.
const SHARED_ROOT_CONFIG = [
  'tsconfig.base.json',
  'eslint.config.base.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.nvmrc',
];

test('every shared root config file invalidates the Turborepo cache', () => {
  const globalDeps = turbo.globalDependencies ?? [];
  for (const file of SHARED_ROOT_CONFIG) {
    assert.ok(globalDeps.includes(file), `turbo.json globalDependencies is missing ${file}`);
  }
});

test('typecheck builds workspace dependencies first (clean-machine project references)', () => {
  assert.deepEqual(turbo.tasks.typecheck.dependsOn, ['^build']);
});

test('test task exists, builds workspace dependencies first, and caches no outputs', () => {
  assert.ok(turbo.tasks.test, 'turbo.json has no "test" task');
  assert.deepEqual(turbo.tasks.test.dependsOn, ['^build']);
  assert.deepEqual(turbo.tasks.test.outputs, []);
});
