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

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const BIND = /^[0-9a-fA-F.:]+$/;

function portValue(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`${name} must be an integer port 1..65535`);
  }
  return String(n);
}

// The smoke owns a dedicated Compose project and its own host ports, so that it
// can never `down -v` a contributor's real stack or collide with it. An ambient
// COMPOSE_PROJECT_NAME is deliberately ignored.
export function resolveSmokeConfig(env) {
  const project = env.SMOKE_PROJECT ?? 'feedbouncer-smoke';
  if (!PROJECT.test(project)) throw new Error('SMOKE_PROJECT is not a valid project name');
  if (!project.includes('smoke')) {
    throw new Error(`refusing to run against project "${project}": the name must contain "smoke"`);
  }
  const bind = env.FB_BIND_ADDRESS ?? '127.0.0.1';
  if (!BIND.test(bind)) throw new Error('FB_BIND_ADDRESS must be an IP address');
  return {
    project,
    webPort: portValue(env, 'WEB_HOST_PORT', '23000'),
    apiPort: portValue(env, 'API_HOST_PORT', '23001'),
    bind,
  };
}

// Best-effort scrub for diagnostic output: known secret values plus any
// user:password@ part of a URL.
export function redactText(text, secrets = []) {
  let out = text.replace(/(\w+:\/\/)[^\s/@]*@/g, '$1***@');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}
