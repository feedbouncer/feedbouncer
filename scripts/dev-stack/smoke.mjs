#!/usr/bin/env node
// End-to-end check of the local dev stack (compose.yaml). Used by CI
// ("Compose smoke") and by maintainers. DESTROYS the stack's database volume.
//
// Scope: every docker call goes through `docker compose` in this directory, so
// it only touches the Compose project that compose.yaml resolves to
// ("feedbouncer", or COMPOSE_PROJECT_NAME if set). Use COMPOSE_PROJECT_NAME
// and the *_HOST_PORT variables to run it beside a stack you want to keep.
// Spawns docker with argument arrays only (no shell). Never prints env values.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DESTROY_FLAG,
  buildEnqueueArgv,
  parsePs,
  parseSmokeArgs,
  selftestWhere,
} from './smoke-lib.mjs';

const exec = promisify(execFile);
const REQUIRED = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'REDIS_PASSWORD'];
const LONG_RUNNING = ['postgres', 'redis', 'api', 'worker', 'web'];
const WAIT = ['--wait', '--wait-timeout', '420'];
const JOBS = 200;

function port(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (!/^\d{1,5}$/.test(raw)) {
    console.error(`smoke: ${name} must be a port number`);
    process.exit(2);
  }
  return raw;
}
const API = `http://127.0.0.1:${port('API_HOST_PORT', '3001')}`;
const WEB = `http://127.0.0.1:${port('WEB_HOST_PORT', '3000')}`;
const bindName = 'FB_BIND_ADDRESS';
const BIND = process.env[bindName] ?? '127.0.0.1';

let args;
try {
  args = parseSmokeArgs(process.argv.slice(2));
} catch (err) {
  console.error(`smoke: ${err.message}`);
  process.exit(2);
}
if (!args.confirmed) {
  console.error(
    `smoke: this deletes the feedbouncer database volume. Re-run with --${DESTROY_FLAG}.`,
  );
  process.exit(2);
}

async function docker(argv, { allowFail = false, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await exec('docker', argv, { env, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (allowFail) {
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }
    // Only the subcommand is named: arguments and env may carry credentials.
    throw new Error(`docker ${argv.slice(0, 2).join(' ')} failed:\n${err.stderr ?? err.message}`, {
      cause: err,
    });
  }
}
const compose = (argv, opts) => docker(['compose', ...argv], opts);
const step = (name) => console.log(`\n== ${name}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ps(all = false) {
  return parsePs((await compose(['ps', ...(all ? ['-a'] : []), '--format', 'json'])).stdout);
}
async function getText(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

async function main() {
  step('missing .env fails loudly instead of starting with empty credentials');
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-smoke-'));
  const emptyEnv = path.join(dir, 'empty.env');
  await writeFile(emptyEnv, '');
  const bare = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !REQUIRED.includes(k)),
  );
  const missing = await compose(['--env-file', emptyEnv, 'config', '--quiet'], {
    allowFail: true,
    env: bare,
  });
  await rm(dir, { recursive: true });
  check(missing.code !== 0, 'compose config exits non-zero without required variables');
  check(
    /copy \.env\.example to \.env/.test(missing.stderr),
    'error message tells the user to copy .env.example',
  );

  const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  const project = config.name;
  const pgUser = config.services.postgres.environment.POSTGRES_USER;
  const pgDb = config.services.postgres.environment.POSTGRES_DB;
  console.log(`smoke: target compose project is "${project}"`);
  const psql = async (sql) =>
    (
      await compose([
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        pgUser,
        '-d',
        pgDb,
        '-v',
        'ON_ERROR_STOP=1',
        '-tAc',
        sql,
      ])
    ).stdout.trim();

  step('cold start from an empty volume');
  await compose(['down', '-v', '--remove-orphans']);
  await compose(['up', '-d', '--build', ...WAIT]);
  const running = await ps();
  for (const name of LONG_RUNNING) {
    const c = running.find((r) => r.Service === name);
    check(c?.State === 'running' && c?.Health === 'healthy', `${name} is running and healthy`);
    const restarts = (
      await docker(['inspect', '--format', '{{.RestartCount}}', c.Name])
    ).stdout.trim();
    check(restarts === '0', `${name} did not restart during cold start`);
  }
  const migrate = (await ps(true)).find((r) => r.Service === 'migrate');
  check(migrate?.State === 'exited' && migrate?.ExitCode === 0, 'migrate ran once and exited 0');

  step('exposure: only web and api are published, on the bind address');
  for (const c of running) {
    const published = (c.Publishers ?? []).filter((p) => p.PublishedPort > 0);
    if (c.Service === 'postgres' || c.Service === 'redis') {
      check(
        published.every((p) => p.URL === '127.0.0.1'),
        `${c.Service} is unpublished or localhost-only`,
      );
    } else if (c.Service === 'worker') {
      check(published.length === 0, 'worker publishes no port');
    } else {
      check(
        published.length > 0 && published.every((p) => p.URL === BIND),
        `${c.Service} publishes on ${BIND}`,
      );
    }
  }

  step('HTTP endpoints from the host');
  const health = await getText(`${API}/healthz`);
  check(health.status === 200, 'api /healthz is 200');
  check(
    JSON.stringify(JSON.parse(health.text)) ===
      '{"status":"ok","checks":{"postgres":"up","redis":"up"}}',
    'api /healthz reports postgres and redis up, nothing else',
  );
  check((await getText(`${WEB}/api/health`)).status === 200, 'web /api/health is 200');
  const home = await getText(WEB, 30_000);
  check(/data-testid="api-status"[^>]*>up</.test(home.text), 'web home page shows API: up');

  step('migrations are idempotent');
  const countSql = 'select count(*) from _prisma_migrations where finished_at is not null';
  const before = await psql(countSql);
  await compose(['run', '--rm', '--no-deps', 'migrate']);
  await compose(['run', '--rm', '--no-deps', 'migrate']);
  const after = await psql(countSql);
  check(
    before === after && Number(after) >= 1,
    `re-running migrate changes nothing (${after} applied)`,
  );

  step('two worker replicas never process a job twice');
  await compose(['up', '-d', ...WAIT, '--scale', 'worker=2']);
  const runId = randomUUID();
  const enqueue = [
    'exec',
    '-T',
    '--index',
    '1',
    'worker',
    'node_modules/.bin/tsx',
    ...buildEnqueueArgv({ runId, count: JOBS, delayMs: 20 }),
  ];
  await compose(enqueue);
  await compose(enqueue); // same ids again: must be a no-op
  const where = selftestWhere(runId);
  let stats = '';
  for (let i = 0; i < 120; i += 1) {
    stats = await psql(
      `select count(*), coalesce(sum(duplicate_deliveries), 0), count(distinct processed_by) from processed_job where ${where}`,
    );
    if (stats.startsWith(`${JOBS}|`)) break;
    await sleep(1_000);
  }
  const [count, dups, workers] = stats.split('|').map(Number);
  check(count === JOBS, `all ${JOBS} jobs processed (got ${count})`);
  check(dups === 0, `no duplicate deliveries (got ${dups})`);
  check(workers === 2, `both replicas processed jobs (got ${workers})`);

  step('data persists across down/up');
  await compose(['down']);
  await compose(['up', '-d', ...WAIT]);
  check(
    (await psql(`select count(*) from processed_job where ${where}`)) === String(JOBS),
    'rows survive down/up',
  );

  step('down -v resets to a clean state');
  await compose(['down', '-v', '--remove-orphans']);
  const vols = await docker([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  check(vols.stdout.trim() === '', 'no project volumes remain');

  console.log('\nsmoke: all checks passed');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
