import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnqueueArgv,
  parsePs,
  parseSmokeArgs,
  selftestWhere,
} from '../dev-stack/smoke-lib.mjs';

const runId = '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f10';

test('smoke refuses to run without the destroy flag', () => {
  assert.equal(parseSmokeArgs([]).confirmed, false);
  assert.equal(parseSmokeArgs(['--yes-destroy-local-data']).confirmed, true);
});

test('smoke rejects unknown arguments', () => {
  assert.throws(() => parseSmokeArgs(['--yes-destroy-local-data', '--oops']));
});

test('enqueue argv is a validated array', () => {
  assert.deepEqual(buildEnqueueArgv({ runId, count: 200, delayMs: 20 }), [
    'src/cli/enqueue-selftest.ts',
    '--run-id',
    runId,
    '--count',
    '200',
    '--delay-ms',
    '20',
  ]);
});

test('enqueue inputs are validated', () => {
  const bad = [
    { runId: "x'; drop table processed_job; --", count: 1, delayMs: 0 },
    { runId: runId.toUpperCase(), count: 1, delayMs: 0 },
    { runId, count: 0, delayMs: 0 },
    { runId, count: 10_001, delayMs: 0 },
    { runId, count: 1.5, delayMs: 0 },
    { runId, count: '3', delayMs: 0 },
    { runId, count: 1, delayMs: -1 },
    { runId, count: 1, delayMs: 1_001 },
  ];
  for (const input of bad) assert.throws(() => buildEnqueueArgv(input), JSON.stringify(input));
});

test('selftest filter only accepts a UUID run id', () => {
  assert.match(selftestWhere(runId), new RegExp(`selftest_${runId}_`));
  assert.throws(() => selftestWhere("' or 1=1 --"));
});

test('parsePs handles array and NDJSON output', () => {
  assert.deepEqual(parsePs(''), []);
  assert.deepEqual(parsePs('[{"Service":"a"}]'), [{ Service: 'a' }]);
  assert.deepEqual(parsePs('{"Service":"a"}\n{"Service":"b"}\n'), [
    { Service: 'a' },
    { Service: 'b' },
  ]);
});
