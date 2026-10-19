// Dev-time smoke test: installs the packed community node into a real n8n image
// and checks that both node types load.
// Usage: node scripts/smoke.mjs <path-to-tarball.tgz> <n8n-version>
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PACKAGE = '@feedbouncer/n8n-nodes-feedbouncer';
const NODE_TYPES = [`${PACKAGE}.feedBouncer`, `${PACKAGE}.feedBouncerTrigger`];
const NODES_DIR = '/home/node/.n8n/nodes';
const HEALTH_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const docker = async (...args) => {
  try {
    return (await run('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`docker ${args[0]} failed: ${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim());
  }
};
// `docker logs` writes the container's stderr to ours, so keep both streams.
const dockerLogs = async (name) => {
  const { stdout, stderr } = await run('docker', ['logs', name], { maxBuffer: 64 * 1024 * 1024 });
  return stdout + stderr;
};

function parseArgs([tarball, version, ...rest]) {
  if (!tarball || !version || rest.length > 0) {
    throw new Error('usage: node scripts/smoke.mjs <tarball.tgz> <n8n-version>');
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid n8n version: ${version}`);
  const path = resolve(tarball);
  if (!path.endsWith('.tgz') || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`tarball not found or not a .tgz file: ${tarball}`);
  }
  return { tarball: path, version };
}

async function waitForHealth(name) {
  const hostPort = (await docker('port', name, '5678/tcp')).trim().split('\n')[0].split(':').pop();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/healthz`);
      if (response.status === 200) return;
    } catch {
      // not accepting connections yet
    }
    await sleep(2000);
  }
  throw new Error(`n8n did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

async function main() {
  const { tarball, version } = parseArgs(process.argv.slice(2));
  const name = `fb-n8n-smoke-${randomBytes(4).toString('hex')}`;
  try {
    await docker(
      'run', '-d', '--name', name, '-p', '127.0.0.1::5678',
      '-e', 'N8N_COMMUNITY_PACKAGES_ENABLED=true',
      `n8nio/n8n:${version}`,
    );
    // First boot creates the community nodes directory; install only after it exists.
    await waitForHealth(name);
    await docker('cp', tarball, `${name}:/tmp/pkg.tgz`);
    // docker cp keeps the host owner and mode (mktemp files are 0600), which the node user cannot read.
    await docker('exec', '-u', 'root', name, 'chmod', '644', '/tmp/pkg.tgz');
    // Same flags n8n uses for community installs; scripts stay off because the image has no build toolchain.
    await docker(
      'exec', '-w', NODES_DIR, name,
      'npm', 'install', '--ignore-scripts', '--audit=false', '--fund=false', '--package-lock=false', '/tmp/pkg.tgz',
    );
    await docker('restart', name);
    await waitForHealth(name);

    const logs = await dockerLogs(name);
    const bad = logs.split('\n').filter((l) => /Error loading package/i.test(l) || (l.includes(PACKAGE) && /error/i.test(l)));
    if (bad.length > 0) throw new Error(`n8n reported a package error:\n${bad.join('\n')}`);

    await docker('exec', name, 'n8n', 'export:nodes', '--output=/tmp/nodes.json');
    const nodes = await docker('exec', name, 'cat', '/tmp/nodes.json');
    const missing = NODE_TYPES.filter((type) => !nodes.includes(type));
    if (missing.length > 0) throw new Error(`node types not registered: ${missing.join(', ')}`);
    console.log(`smoke ok: n8n ${version} loaded ${NODE_TYPES.join(' and ')}`);
  } finally {
    await docker('rm', '-f', name).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`smoke failed: ${error.message}`);
  process.exit(1);
});
