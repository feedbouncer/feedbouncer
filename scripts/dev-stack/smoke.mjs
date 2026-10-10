#!/usr/bin/env node
// End-to-end check of the local dev stack (compose.yaml). Used by CI
// ("Compose smoke") and by maintainers. DESTROYS the stack's database volume.
//
// Scope: the smoke owns its own Compose project (SMOKE_PROJECT, default
// "feedbouncer-smoke", must contain "smoke") and passes -p and its own host
// ports to every docker call. It ignores COMPOSE_PROJECT_NAME and .env ports, and
// uses compose.yaml only (no overlays), so a developer's "feedbouncer" stack is
// never touched. WEB_HOST_PORT / API_HOST_PORT / FB_BIND_ADDRESS override its defaults.
// Spawns docker with argument arrays only (no shell). Never prints env values.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DESTROY_FLAG,
  buildEnqueueExecArgv,
  parsePs,
  parseSmokeArgs,
  redactText,
  resolveSmokeConfig,
  selftestWhere,
} from './smoke-lib.mjs';

const exec = promisify(execFile);
const REQUIRED = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'REDIS_PASSWORD'];
const LONG_RUNNING = ['postgres', 'redis', 'api', 'worker', 'web'];
const WAIT = ['--wait', '--wait-timeout', '420'];
const JOBS = 200;

let cfg;
try {
  cfg = resolveSmokeConfig(process.env);
} catch (err) {
  console.error(`smoke: ${err.message}`);
  process.exit(2);
}
const API = `http://127.0.0.1:${cfg.apiPort}`;
const WEB = `http://127.0.0.1:${cfg.webPort}`;
const BIND = cfg.bind;
// Env for every child: the smoke's own project, ports and file set win over
// anything exported by the caller. Secrets still come from .env / the caller.
const CHILD_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: cfg.project,
  COMPOSE_FILE: 'compose.yaml',
  WEB_HOST_PORT: cfg.webPort,
  API_HOST_PORT: cfg.apiPort,
  FB_BIND_ADDRESS: cfg.bind,
};
delete CHILD_ENV.COMPOSE_PROFILES;
const secrets = [];
const SHORT = 60_000;
const LONG = 600_000;

let args;
try {
  args = parseSmokeArgs(process.argv.slice(2));
} catch (err) {
  console.error(`smoke: ${err.message}`);
  process.exit(2);
}
if (!args.confirmed) {
  console.error(
    `smoke: this deletes the "${cfg.project}" project's database volume. Re-run with --${DESTROY_FLAG}.`,
  );
  process.exit(2);
}

async function docker(argv, { allowFail = false, env = CHILD_ENV, timeout = SHORT } = {}) {
  try {
    const { stdout, stderr } = await exec('docker', argv, {
      env,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
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
const compose = (argv, opts) =>
  docker(['compose', '-p', cfg.project, '-f', 'compose.yaml', ...argv], opts);
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
  const bare = Object.fromEntries(Object.entries(CHILD_ENV).filter(([k]) => !REQUIRED.includes(k)));
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
  const project = cfg.project;
  const pgUser = config.services.postgres.environment.POSTGRES_USER;
  const pgDb = config.services.postgres.environment.POSTGRES_DB;
  secrets.push(
    config.services.postgres.environment.POSTGRES_PASSWORD,
    config.services.redis.environment.REDISCLI_AUTH,
  );
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
  await compose(['up', '-d', '--build', ...WAIT], { timeout: LONG });
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

  step(
    'exposure: only web and api are published (base compose.yaml, no overlay), on the bind address',
  );
  for (const c of running) {
    const published = (c.Publishers ?? []).filter((p) => p.PublishedPort > 0);
    if (c.Service === 'postgres' || c.Service === 'redis') {
      check(published.length === 0, `${c.Service} publishes no host port`);
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
  await compose(['run', '--rm', '--no-deps', 'migrate'], { timeout: 120_000 });
  await compose(['run', '--rm', '--no-deps', 'migrate'], { timeout: 120_000 });
  const after = await psql(countSql);
  check(
    before === after && Number(after) >= 1,
    `re-running migrate changes nothing (${after} applied)`,
  );

  step('two worker replicas never process a job twice');
  await compose(['up', '-d', ...WAIT, '--scale', 'worker=2'], { timeout: LONG });
  const runId = randomUUID();
  const enqueue = buildEnqueueExecArgv({ runId, count: JOBS, delayMs: 20 });
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
  await compose(['up', '-d', ...WAIT], { timeout: LONG });
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

async function diagnostics() {
  const tail = (text, n) => text.trim().split('\n').slice(-n).join('\n');
  const run = async (argv, n) => {
    const r = await compose(argv, { allowFail: true });
    console.error(redactText(tail(r.stdout + r.stderr, n), secrets));
  };
  console.error('\n-- compose ps');
  await run(['ps', '-a'], 30);
  console.error('\n-- last log lines (redacted)');
  await run(['logs', '--no-color', '--tail', '40'], 120);
}

main().catch(async (err) => {
  process.exitCode = 1;
  console.error(`\n${redactText(err.message, secrets)}`);
  await diagnostics().catch(() => {});
});
