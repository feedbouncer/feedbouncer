// Static guard for the local dev stack. Each assertion maps to an acceptance
// criterion or a Review Focus item in the compose plan. Runs inside the CI
// "Test" check with no Docker needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { parse } from 'yaml';

const run = promisify(execFile);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');
const parseCompose = (text) => parse(text, { merge: true }); // compose.yaml uses <<: merge keys

const composeText = await read('compose.yaml');
const compose = parseCompose(composeText);
const exposeText = await read('compose.expose-db.yaml');
const expose = parseCompose(exposeText);
const overrideText = await read('compose.override.example.yaml');
const envExample = await read('.env.example');
const nvmrc = (await read('.nvmrc')).trim();
const svc = compose.services;

const APPS = ['api', 'worker', 'web'];
const LONG_RUNNING = ['postgres', 'redis', ...APPS];
const REQUIRED = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'REDIS_PASSWORD'];

function envEntries() {
  const entries = new Map();
  for (const line of envExample.split(/\r?\n/)) {
    const m = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) entries.set(m[2], { commented: Boolean(m[1]), value: m[3].trim() });
  }
  return entries;
}
function referencedVars(text) {
  return new Set([...text.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
}
function memBytes(value) {
  const m = /^(\d+)([mMgG])$/.exec(String(value));
  assert.ok(m, `unparseable memory limit ${value}`);
  return Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 ** 3 : 1024 ** 2);
}

test('defines the five services plus the one-shot migrate service', () => {
  assert.deepEqual(Object.keys(svc).sort(), [
    'api',
    'migrate',
    'postgres',
    'redis',
    'web',
    'worker',
  ]);
  assert.equal(compose.name, 'feedbouncer');
});

test('required variables fail loudly at every reference', () => {
  for (const name of REQUIRED) {
    const refs = [
      ...composeText.matchAll(new RegExp(String.raw`(?<!\$)\$\{${name}([^}]*)\}`, 'g')),
    ];
    assert.ok(refs.length > 0, `${name} is never referenced`);
    for (const [, suffix] of refs) {
      assert.match(
        suffix,
        /^:\?.*copy \.env\.example to \.env/,
        `\${${name}${suffix}} must use :? with the hint`,
      );
    }
  }
});

test('.env.example covers every referenced variable, with dev-only credentials', () => {
  const entries = envEntries();
  for (const text of [composeText, exposeText, overrideText]) {
    for (const name of referencedVars(text))
      assert.ok(entries.has(name), `.env.example lacks ${name}`);
  }
  for (const name of REQUIRED) {
    const e = entries.get(name);
    assert.ok(
      e && !e.commented && e.value !== '',
      `${name} must be set (uncommented) in .env.example`,
    );
  }
  for (const [name, { value }] of entries) {
    if (/PASSWORD|SECRET|TOKEN|KEY/.test(name))
      assert.match(value, /^dev-only-/, `${name} must start with dev-only-`);
  }
});

test('postgres and redis are unpublished by default and localhost-only when opted in', () => {
  assert.equal(svc.postgres.ports, undefined);
  assert.equal(svc.redis.ports, undefined);
  for (const name of ['postgres', 'redis']) {
    for (const p of expose.services[name].ports) assert.match(p, /^127\.0\.0\.1:/);
  }
});

test('web and api publish on a configurable, localhost-default bind address', () => {
  assert.deepEqual(svc.api.ports, ['${FB_BIND_ADDRESS:-127.0.0.1}:${API_HOST_PORT:-3001}:3001']);
  assert.deepEqual(svc.web.ports, ['${FB_BIND_ADDRESS:-127.0.0.1}:${WEB_HOST_PORT:-3000}:3000']);
});

test('worker publishes nothing and every service is scalable', () => {
  assert.equal(svc.worker.ports, undefined);
  for (const [name, s] of Object.entries(svc))
    assert.equal(s.container_name, undefined, `${name} sets container_name`);
});

test('healthchecks gate startup in the right order', () => {
  for (const name of LONG_RUNNING)
    assert.ok(svc[name].healthcheck?.test, `${name} has no healthcheck`);
  // Review Focus #1: TCP probe, not the init-time Unix socket.
  assert.match(svc.postgres.healthcheck.test.join(' '), /pg_isready -h 127\.0\.0\.1/);
  for (const name of ['api', 'worker']) {
    assert.deepEqual(svc[name].depends_on, {
      postgres: { condition: 'service_healthy' },
      redis: { condition: 'service_healthy' },
      migrate: { condition: 'service_completed_successfully' },
    });
  }
  assert.deepEqual(svc.web.depends_on, { api: { condition: 'service_healthy' } });
  assert.deepEqual(svc.migrate.depends_on, { postgres: { condition: 'service_healthy' } });
  assert.equal(svc.migrate.restart, 'no');
});

test('app images build from apps/<name>/Dockerfile, dev target, repo-root context', () => {
  for (const name of APPS) {
    assert.deepEqual(svc[name].build, {
      context: '.',
      dockerfile: `apps/${name}/Dockerfile`,
      target: 'dev',
    });
  }
  assert.deepEqual(svc.migrate.build, {
    context: '.',
    dockerfile: 'apps/api/Dockerfile',
    target: 'dev',
  });
});

test("app services mount their own and their workspace dependencies' src read-only", async () => {
  const dirs = new Map();
  for (const group of ['apps', 'packages']) {
    for (const dir of await readdir(new URL(`${group}/`, root))) {
      try {
        dirs.set(JSON.parse(await read(`${group}/${dir}/package.json`)).name, `${group}/${dir}`);
      } catch {
        /* not a package */
      }
    }
  }
  async function closure(dir, seen = new Set()) {
    seen.add(dir);
    const pkg = JSON.parse(await read(`${dir}/package.json`));
    for (const dep of Object.keys({ ...pkg.dependencies })) {
      const depDir = dirs.get(dep);
      if (depDir && !seen.has(depDir)) await closure(depDir, seen);
    }
    return seen;
  }
  for (const name of APPS) {
    for (const dir of await closure(`apps/${name}`)) {
      assert.ok(
        svc[name].volumes.includes(`./${dir}/src:/repo/${dir}/src:ro`),
        `${name} must mount ./${dir}/src`,
      );
    }
  }
  assert.ok(svc.migrate.volumes.includes('./packages/db/prisma:/repo/packages/db/prisma:ro'));
});

test('redis: no eviction (BullMQ requirement) and no persistence', () => {
  const cmd = svc.redis.command.join(' ');
  assert.match(cmd, /--maxmemory-policy noeviction/);
  assert.match(cmd, /--appendonly no/);
});

test('memory limits fit a typical laptop Docker allocation', () => {
  let total = 0;
  for (const name of LONG_RUNNING) {
    const limit = svc[name].deploy?.resources?.limits?.memory;
    assert.ok(limit, `${name} has no memory limit`);
    total += memBytes(limit);
  }
  assert.ok(total <= 3.5 * 1024 ** 3, `total memory limits ${total} exceed 3.5 GiB`);
});

test('images are pinned to the ROADMAP majors, never latest', () => {
  assert.match(svc.postgres.image, /^postgres:17(\.\d+)?-alpine$/);
  assert.match(svc.redis.image, /^redis:8\.\d+(\.\d+)?-alpine$/);
});

test('services receive explicit environment only (no env_file)', () => {
  for (const [name, s] of Object.entries(svc))
    assert.equal(s.env_file, undefined, `${name} uses env_file`);
});

test('every app Dockerfile pins NODE_VERSION to .nvmrc and ends with the runtime stage', async () => {
  for (const name of APPS) {
    const text = await read(`apps/${name}/Dockerfile`);
    assert.match(
      text,
      new RegExp(`^ARG NODE_VERSION=${nvmrc}$`, 'm'),
      `${name}: ARG NODE_VERSION must equal .nvmrc`,
    );
    assert.match(text, /^FROM \S+ AS dev$/m);
    const stages = [...text.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1]);
    assert.equal(
      stages.at(-1),
      'runtime',
      `${name}: last stage must be runtime (CI builds the default target)`,
    );
  }
});

test('line endings are pinned to LF', async () => {
  assert.match(await read('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('local env and override files are git-ignored; the examples are not', async () => {
  const ignored = async (p) =>
    run('git', ['check-ignore', '-q', '--no-index', p], { cwd: root }).then(
      () => true,
      () => false,
    );
  assert.equal(await ignored('.env'), true);
  assert.equal(await ignored('compose.override.yaml'), true);
  assert.equal(await ignored('.env.example'), false);
  assert.equal(await ignored('compose.override.example.yaml'), false);
});
