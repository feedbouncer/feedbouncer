import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sets front matter `last_update: { date: <iso> }` on one generated page, replacing any existing
 * `last_update` block. Idempotent.
 */
export function stampLastUpdate(file, isoDate) {
  const text = readFileSync(file, 'utf8');
  const stamp = ['last_update:', `  date: ${isoDate}`];
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) {
    writeFileSync(file, `---\n${stamp.join('\n')}\n---\n\n${text}`);
    return;
  }
  const kept = [];
  let skipping = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^last_update:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s+\S/.test(line)) continue;
    skipping = false;
    kept.push(line);
  }
  const front = [...kept, ...stamp].join('\n');
  writeFileSync(file, `---\n${front}\n---${m[2]}${text.slice(m[0].length)}`);
}

function* mdxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* mdxFiles(p);
    else if (entry.name.endsWith('.mdx')) yield p;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../..');
  let date = '';
  try {
    date = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'docs/api/openapi.json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No repository or no commits yet: treated the same as an empty history.
  }
  if (!date) {
    console.error(
      'No git history for docs/api/openapi.json; fetch the full history (fetch-depth: 0).',
    );
    process.exit(1);
  }
  let count = 0;
  for (const file of mdxFiles(resolve(here, '../docs/api/reference'))) {
    stampLastUpdate(file, date);
    count += 1;
  }
  console.log(`stamped ${count} pages with ${date}`);
}
