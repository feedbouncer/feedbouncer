// Lists every workspace package that ships a Dockerfile, for the CI build matrix.
// Adding apps/<name>/Dockerfile or packages/<name>/Dockerfile is the only step
// needed for CI to build a new image. Node built-ins only (runs before install).
import { appendFile, lstat, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const WORKSPACE_GROUPS = ['apps', 'packages'];
// Directory names flow into image tags and cache scopes; keep them boring.
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

async function lstatOrNull(p) {
  try {
    return await lstat(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function findDockerTargets(rootDir) {
  const targets = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupStat = await lstatOrNull(path.join(rootDir, group));
    if (!groupStat) continue;
    if (!groupStat.isDirectory())
      throw new Error(`${JSON.stringify(group)} must be a real directory, not a symlink or file`);

    const entries = await readdir(path.join(rootDir, group), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workspace entry ${JSON.stringify(`${group}/${entry.name}`)} is a symlink; CI refuses to follow it`,
        );
      }
      if (!entry.isDirectory()) continue;

      const dockerfile = await lstatOrNull(path.join(rootDir, group, entry.name, 'Dockerfile'));
      if (!dockerfile) continue;
      if (!dockerfile.isFile()) {
        throw new Error(
          `${JSON.stringify(`${group}/${entry.name}/Dockerfile`)} must be a regular file`,
        );
      }
      if (!SAFE_SEGMENT.test(entry.name)) {
        throw new Error(
          `Unsafe workspace directory name ${JSON.stringify(`${group}/${entry.name}`)}`,
        );
      }
      targets.push({
        name: `${group}-${entry.name}`,
        dockerfile: `${group}/${entry.name}/Dockerfile`,
      });
    }
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const targets = await findDockerTargets(process.cwd());
  const lines = `targets=${JSON.stringify(targets)}\nhas_targets=${targets.length > 0}\n`;
  // GITHUB_OUTPUT is provided by the Actions runner, not a turbo build input.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    await appendFile(outputFile, lines);
  } else {
    process.stdout.write(lines);
  }
}

// Compare realpaths: ESM import.meta.url is already resolved through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`docker-targets: ${err.message}\n`);
    process.exitCode = 1;
  });
}
