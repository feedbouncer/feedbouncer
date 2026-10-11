// Static guards for secrets hygiene. Runs in the CI "Test" check (pnpm test:scripts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

// Only these env-style files may be tracked.
const ALLOWED_ENV_FILES = new Set(['.env.example']);
const ENV_FILE = /(^|\/)(\.env(\..+)?|[^/]+\.env|\.envrc)$/;

function envFileOffenders(paths) {
  return paths.filter(Boolean).filter((p) => ENV_FILE.test(p) && !ALLOWED_ENV_FILES.has(p));
}

async function trackedFiles(cwd) {
  const { stdout } = await run('git', ['ls-files', '-z', '--cached'], { cwd });
  return stdout.split('\0');
}

function documentedVars(text) {
  return new Set([...text.matchAll(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

function secretExampleProblems(text) {
  const problems = [];
  for (const name of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'AUTH_SECRET']) {
    const v = new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '';
    if (!/^dev-only-/.test(v)) problems.push(`${name} must start with dev-only-`);
  }
  if (!/^FB_ENCRYPTION_KEYS=dev-example:/m.test(text)) {
    problems.push('FB_ENCRYPTION_KEYS example must use the dev-example key id');
  }
  return problems;
}

test('no populated env file is tracked or staged', async () => {
  const offenders = envFileOffenders(await trackedFiles(root));
  assert.deepEqual(offenders, [], `env files must not be committed: ${offenders.join(', ')}`);
});

test('the tracked-env-file guard rejects a populated env file that is force-added', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'env-guard-'));
  try {
    await run('git', ['init', '-q'], { cwd: dir });
    await writeFile(join(dir, '.env.production'), 'AUTH_SECRET=real-looking-secret\n');
    await writeFile(join(dir, 'prod.env'), 'FB_ENCRYPTION_KEYS=prod:abc\n');
    await writeFile(join(dir, '.env.example'), 'AUTH_SECRET=dev-only-x\n');
    await run('git', ['add', '-f', '.env.production', 'prod.env', '.env.example'], { cwd: dir });
    assert.deepEqual(envFileOffenders(await trackedFiles(dir)).sort(), ['.env.production', 'prod.env']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('.gitignore ignores .env and .env.* but not .env.example', async () => {
  for (const p of ['.env', '.env.local', '.env.production', 'apps/api/.env']) {
    await run('git', ['check-ignore', '-q', p], { cwd: root }); // rejects (exit 1) if not ignored
  }
  await assert.rejects(run('git', ['check-ignore', '-q', '.env.example'], { cwd: root }));
});

test('.env.example documents every setting the services read', async () => {
  const documented = documentedVars(await read('.env.example'));
  const loaders = [
    'apps/api/src/env.ts',
    'apps/worker/src/env.ts',
    'packages/secrets/src/config.ts',
    'packages/service-runtime/src/env.ts',
  ];
  const missing = [];
  let seen = 0;
  for (const file of loaders) {
    const src = await read(file);
    for (const m of src.matchAll(/\benv,\s*'([A-Z][A-Z0-9_]+)'/g)) {
      seen += 1;
      if (!documented.has(m[1])) missing.push(`${m[1]} (${file})`);
    }
  }
  assert.ok(seen > 0, 'the loader pattern matched nothing; update this guard');
  assert.deepEqual(missing, [], 'add these to .env.example (commented out if compose sets them)');
});

test('the completeness check notices an undocumented setting', () => {
  const documented = documentedVars('# PORT=3001\nLOG_LEVEL=info\n');
  assert.ok(documented.has('PORT') && documented.has('LOG_LEVEL'));
  assert.ok(!documented.has('FB_ENCRYPTION_KEYS'));
});

test('.env.example secret values are clearly development-only', async () => {
  assert.deepEqual(secretExampleProblems(await read('.env.example')), []);
});

test('the dev-only check rejects real-looking secret values', () => {
  const populated = [
    'POSTGRES_PASSWORD=hunter2',
    'REDIS_PASSWORD=dev-only-ok',
    'AUTH_SECRET=dev-only-ok',
    'FB_ENCRYPTION_KEYS=prod-2026:abc',
  ].join('\n');
  assert.deepEqual(secretExampleProblems(populated), [
    'POSTGRES_PASSWORD must start with dev-only-',
    'FB_ENCRYPTION_KEYS example must use the dev-example key id',
  ]);
});

test('ESLint restricts process.env to the config entry points', async () => {
  const RULE = /no-restricted-properties/;
  const lintOutput = async (cwd, file) => {
    const p = run('pnpm', ['exec', 'eslint', '--stdin', '--stdin-filename', file], {
      cwd: new URL(cwd, root),
    });
    p.child.stdin.end('export const x = process.env.FOO;\n');
    try {
      return (await p).stdout;
    } catch (e) {
      return e.stdout ?? '';
    }
  };
  for (const [cwd, file] of [
    ['apps/api/', 'src/routes/foo.ts'],
    ['apps/worker/', 'src/jobs/foo.ts'],
    ['packages/secrets/', 'src/foo.ts'],
  ]) {
    assert.match(await lintOutput(cwd, file), RULE, `${cwd}${file} must be rejected`);
  }
  for (const [cwd, file] of [
    ['apps/api/', 'src/main.ts'],
    ['apps/worker/', 'src/cli/foo.ts'],
    ['packages/secrets/', 'src/bin.ts'],
  ]) {
    assert.doesNotMatch(await lintOutput(cwd, file), RULE, `${cwd}${file} must be exempt`);
  }
});
