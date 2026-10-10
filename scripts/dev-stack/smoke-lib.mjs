// Pure helpers for smoke.mjs, kept separate so they can be unit tested
// (scripts/ci/smoke-lib.test.mjs) without touching Docker.
import { parseArgs } from 'node:util';

export const DESTROY_FLAG = 'yes-destroy-local-data';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseSmokeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { [DESTROY_FLAG]: { type: 'boolean', default: false } },
  });
  return { confirmed: values[DESTROY_FLAG] === true };
}

function assertInt(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer ${min}..${max}`);
  }
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !UUID.test(runId)) {
    throw new Error('runId must be a lowercase UUID');
  }
}

// Arguments for apps/worker/src/cli/enqueue-selftest.ts, as an argv array.
export function buildEnqueueArgv({ runId, count, delayMs }) {
  assertRunId(runId);
  assertInt('count', count, 1, 10_000);
  assertInt('delayMs', delayMs, 0, 1_000);
  return [
    'src/cli/enqueue-selftest.ts',
    '--run-id',
    runId,
    '--count',
    String(count),
    '--delay-ms',
    String(delayMs),
  ];
}

// SQL predicate for one selftest run. The id is validated as a UUID first, so
// the interpolation cannot carry anything but hex digits and dashes.
export function selftestWhere(runId) {
  assertRunId(runId);
  return `queue = 'system' and starts_with(job_id, 'selftest_${runId}_')`;
}

// `docker compose ps --format json` prints an array or NDJSON depending on version.
export function parsePs(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  return text.startsWith('[') ? JSON.parse(text) : text.split('\n').map((l) => JSON.parse(l));
}
