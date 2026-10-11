import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnqueueArgv,
  buildEnqueueExecArgv,
  parsePs,
  parseSmokeArgs,
  redactText,
  resolveSmokeConfig,
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

test('smoke config ignores ambient COMPOSE_PROJECT_NAME and sets own defaults', () => {
  const c = resolveSmokeConfig({ COMPOSE_PROJECT_NAME: 'feedbouncer' });
  assert.deepEqual(c, {
    project: 'feedbouncer-smoke',
    webPort: '23000',
    apiPort: '23001',
    mailpitPort: '28025',
    bind: '127.0.0.1',
  });
});

test('smoke config honours overrides and refuses non-smoke projects', () => {
  const c = resolveSmokeConfig({
    SMOKE_PROJECT: 'my-smoke-2',
    WEB_HOST_PORT: '4000',
    API_HOST_PORT: '4001',
    MAILPIT_UI_HOST_PORT: '4025',
    FB_BIND_ADDRESS: '0.0.0.0',
  });
  assert.equal(c.mailpitPort, '4025');
  assert.equal(c.project, 'my-smoke-2');
  assert.equal(c.webPort, '4000');
  assert.equal(c.bind, '0.0.0.0');
  assert.throws(() => resolveSmokeConfig({ SMOKE_PROJECT: 'feedbouncer' }), /smoke/);
  assert.throws(() => resolveSmokeConfig({ SMOKE_PROJECT: 'Smoke;rm' }));
});

test('smoke config validates ports as integers 1..65535', () => {
  for (const bad of ['0', '65536', '30a', '', '-1', '1.5', ' 3000']) {
    assert.throws(() => resolveSmokeConfig({ WEB_HOST_PORT: bad }), /WEB_HOST_PORT/, bad);
    assert.throws(() => resolveSmokeConfig({ API_HOST_PORT: bad }), /API_HOST_PORT/, bad);
    assert.throws(
      () => resolveSmokeConfig({ MAILPIT_UI_HOST_PORT: bad }),
      /MAILPIT_UI_HOST_PORT/,
      bad,
    );
  }
  assert.equal(resolveSmokeConfig({ API_HOST_PORT: '65535' }).apiPort, '65535');
});

test('redactText strips known secrets and URL credentials', () => {
  const out = redactText('pw=s3cret url=postgresql://u:p4ss@host/db ok', ['s3cret']);
  assert.doesNotMatch(out, /s3cret|p4ss/);
  assert.match(out, /ok/);
});

test('in-container enqueue is wrapped in timeout and targets replica 1', () => {
  const argv = buildEnqueueExecArgv({ runId, count: 2, delayMs: 0 });
  assert.deepEqual(argv.slice(0, 8), [
    'exec',
    '-T',
    '--index',
    '1',
    'worker',
    'timeout',
    '60',
    'node_modules/.bin/tsx',
  ]);
  assert.equal(argv.at(-1), '0');
});
