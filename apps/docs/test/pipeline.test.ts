import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareContent } from '../scripts/prepare-content.mjs';
import { stampLastUpdate } from '../scripts/stamp-generated.mjs';

const appRoot = resolve(fileURLToPath(import.meta.url), '../..');
const repoRoot = resolve(appRoot, '../..');

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'docs-pipeline-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('prepare-content', () => {
  it('never writes outside docs/_generated and docs/api/reference', () => {
    const root = join(tmp, 'repo');
    for (const f of ['docs/api/openapi.json', 'docs/mcp/tools.json']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      cpSync(join(repoRoot, f), join(root, f));
    }
    mkdirSync(join(root, 'docs/reference'), { recursive: true });
    writeFileSync(join(root, 'docs/reference/product-reference.json'), '{}');
    const docsDir = join(root, 'apps/docs/docs');
    mkdirSync(join(docsDir, '../versioned_docs/version-1.0.0'), { recursive: true });
    writeFileSync(join(docsDir, '../versioned_docs/version-1.0.0/frozen.md'), 'frozen');

    const before = listFiles(root);
    const written = prepareContent(root, docsDir);

    expect(written).toHaveLength(3);
    for (const p of written) expect(p.startsWith(join(docsDir, '_generated') + '/')).toBe(true);
    const added = listFiles(root).filter((f) => !before.includes(f));
    for (const f of added) expect(f.startsWith('apps/docs/docs/_generated/')).toBe(true);
    expect(readFileSync(join(docsDir, '../versioned_docs/version-1.0.0/frozen.md'), 'utf8')).toBe(
      'frozen',
    );
  });
});

describe('stamp-generated', () => {
  const date = '2026-10-21T21:37:35+03:00';

  it('sets last_update and is idempotent', () => {
    const page = join(tmp, 'page.mdx');
    writeFileSync(page, '---\nid: list-comments\ntitle: "List comments"\n---\n\nBody\n');
    stampLastUpdate(page, date);
    const once = readFileSync(page, 'utf8');
    expect(once).toContain(`last_update:\n  date: ${date}`);
    expect(once).toContain('id: list-comments');
    expect(once.endsWith('\n\nBody\n')).toBe(true);
    stampLastUpdate(page, date);
    expect(readFileSync(page, 'utf8')).toBe(once);
  });

  it('replaces an existing last_update and adds front matter when absent', () => {
    const page = join(tmp, 'old.mdx');
    writeFileSync(page, '---\nlast_update:\n  date: 2020-01-01\ntitle: T\n---\nBody\n');
    stampLastUpdate(page, date);
    const text = readFileSync(page, 'utf8');
    expect(text).not.toContain('2020-01-01');
    expect(text.match(/last_update:/g)).toHaveLength(1);
    expect(text).toContain('title: T');

    const bare = join(tmp, 'bare.mdx');
    writeFileSync(bare, 'Body\n');
    stampLastUpdate(bare, date);
    expect(readFileSync(bare, 'utf8')).toBe(`---\nlast_update:\n  date: ${date}\n---\n\nBody\n`);
  });

  it('exits 1 when openapi.json has no git history', () => {
    const repo = join(tmp, 'norepo');
    mkdirSync(join(repo, 'apps/docs/scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps/docs/docs/api/reference'), { recursive: true });
    cpSync(
      join(appRoot, 'scripts/stamp-generated.mjs'),
      join(repo, 'apps/docs/scripts/stamp-generated.mjs'),
    );
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const run = spawnSync('node', ['apps/docs/scripts/stamp-generated.mjs'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('git history');
  });
});

describe('gitignore', () => {
  it('anchors generated dirs so versioned_docs snapshots stay tracked', () => {
    const check = (path: string) =>
      spawnSync('git', ['check-ignore', '-q', path], { cwd: appRoot }).status;
    expect(check('versioned_docs/version-9.9.9/api/reference/x.mdx')).toBe(1);
    expect(check('docs/api/reference/x.mdx')).toBe(0);
    expect(check('docs/_generated/openapi.json')).toBe(0);
    expect(check('build/index.html')).toBe(0);
    expect(check('.docusaurus/x')).toBe(0);
  });
});
