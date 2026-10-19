import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productPathsWithNodeChange } from './n8n-scope-guard.mjs';

const N = 'integrations/n8n-nodes-feedbouncer/nodes/x.ts';

test('node-only change passes', () => {
  assert.deepEqual(productPathsWithNodeChange([N, '.github/workflows/ci.yml']), []);
});

test('product-only change passes', () => {
  assert.deepEqual(productPathsWithNodeChange(['apps/api/src/a.ts', 'docs/api/openapi.json']), []);
});

test('node change plus product paths is reported', () => {
  assert.deepEqual(
    productPathsWithNodeChange([N, 'apps/api/a.ts', 'packages/x/b.ts', 'docs/api/openapi.json', 'docs/api/README.md']),
    ['apps/api/a.ts', 'packages/x/b.ts', 'docs/api/openapi.json'],
  );
});

test('CLI exits non-zero on violation and zero otherwise', () => {
  const run = (input) =>
    spawnSync(process.execPath, ['scripts/ci/n8n-scope-guard.mjs'], { input, encoding: 'utf8' });
  const bad = run(`${N}\napps/api/a.ts\n`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /apps\/api\/a\.ts/);
  assert.equal(run(`${N}\n`).status, 0);
  assert.equal(run('').status, 0);
});
