import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import { findDockerTargets } from './docker-targets.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./docker-targets.mjs', import.meta.url));

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'docker-targets-'));
  for (const rel of files) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), 'FROM scratch\n');
  }
  return root;
}

test('no apps/ or packages/ directories -> no targets', async () => {
  const root = await fixture([]);
  assert.deepEqual(await findDockerTargets(root), []);
  await rm(root, { recursive: true });
});

test('packages without Dockerfiles -> no targets', async () => {
  const root = await fixture(['packages/a/package.json', 'apps/b/package.json']);
  assert.deepEqual(await findDockerTargets(root), []);
  await rm(root, { recursive: true });
});

test('finds Dockerfiles in apps and packages, sorted, with collision-free names', async () => {
  const root = await fixture([
    'packages/worker/Dockerfile',
    'apps/web/Dockerfile',
    'apps/worker/Dockerfile',
    'apps/no-image/package.json',
    'apps/web/nested/Dockerfile', // deeper than one level: ignored
  ]);
  assert.deepEqual(await findDockerTargets(root), [
    { name: 'apps-web', dockerfile: 'apps/web/Dockerfile' },
    { name: 'apps-worker', dockerfile: 'apps/worker/Dockerfile' },
    { name: 'packages-worker', dockerfile: 'packages/worker/Dockerfile' },
  ]);
  await rm(root, { recursive: true });
});

test('stray files directly under apps/ are ignored', async () => {
  const root = await fixture(['apps/README.md']);
  assert.deepEqual(await findDockerTargets(root), []);
  await rm(root, { recursive: true });
});

test('unsafe directory name WITH a Dockerfile throws', async () => {
  const root = await fixture(['apps/Bad Name/Dockerfile']);
  await assert.rejects(findDockerTargets(root), /Unsafe workspace directory name/);
  await rm(root, { recursive: true });
});

test('unsafe directory name WITHOUT a Dockerfile is ignored', async () => {
  const root = await fixture(['apps/Bad Name/package.json']);
  assert.deepEqual(await findDockerTargets(root), []);
  await rm(root, { recursive: true });
});

test('symlinked workspace entry throws instead of being followed', async () => {
  const root = await fixture(['outside/Dockerfile', 'apps/.keep']);
  await symlink(path.join(root, 'outside'), path.join(root, 'apps', 'linked'));
  await assert.rejects(findDockerTargets(root), /symlink/i);
  await rm(root, { recursive: true });
});

test('symlinked Dockerfile throws', async () => {
  const root = await fixture(['outside/Dockerfile', 'apps/web/package.json']);
  await symlink(
    path.join(root, 'outside', 'Dockerfile'),
    path.join(root, 'apps', 'web', 'Dockerfile'),
  );
  await assert.rejects(findDockerTargets(root), /regular file/);
  await rm(root, { recursive: true });
});

test('CLI writes targets and has_targets to GITHUB_OUTPUT', async () => {
  const root = await fixture(['apps/web/Dockerfile']);
  const out = path.join(root, 'gh-output');
  await writeFile(out, '');
  await run(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(
    await readFile(out, 'utf8'),
    'targets=[{"name":"apps-web","dockerfile":"apps/web/Dockerfile"}]\nhas_targets=true\n',
  );
  await rm(root, { recursive: true });
});

test('CLI reports has_targets=false with an empty array when nothing is found', async () => {
  const root = await fixture([]);
  const { stdout } = await run(process.execPath, [SCRIPT], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  assert.equal(stdout, 'targets=[]\nhas_targets=false\n');
  await rm(root, { recursive: true });
});

test('CLI exits 1 with a one-line message on unsafe input', async () => {
  const root = await fixture(['apps/Bad Name/Dockerfile']);
  await assert.rejects(
    run(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: '' } }),
    (err) => err.code === 1 && /Unsafe workspace directory name/.test(err.stderr),
  );
  await rm(root, { recursive: true });
});

test('CLI still writes output when invoked through a symlinked path', async () => {
  const root = await fixture(['apps/web/Dockerfile']);
  const out = path.join(root, 'gh-output');
  await writeFile(out, '');
  await symlink(path.dirname(SCRIPT), path.join(root, 'tools'));
  await run(process.execPath, [path.join(root, 'tools', 'docker-targets.mjs')], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: out },
  });
  assert.equal(
    await readFile(out, 'utf8'),
    'targets=[{"name":"apps-web","dockerfile":"apps/web/Dockerfile"}]\nhas_targets=true\n',
  );
  await rm(root, { recursive: true });
});

test('symlink error message stays one line even if the name contains a newline', async () => {
  const root = await fixture(['outside/Dockerfile', 'apps/.keep']);
  await symlink(path.join(root, 'outside'), path.join(root, 'apps', 'evil\nname'));
  await assert.rejects(
    findDockerTargets(root),
    (err) => !err.message.includes('\n') && /symlink/i.test(err.message),
  );
  await rm(root, { recursive: true });
});
