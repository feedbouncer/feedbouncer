// The legacy API, MCP and moderation docs now live on the documentation site.
// The old files stay as short pointers so existing links keep working: each one
// links to its site page, names its source, and keeps every heading that another
// file in the repo links to by anchor.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'https://feedbouncer.github.io/feedbouncer/docs/';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const POINTERS = {
  'docs/api/README.md': 'api/overview',
  'docs/mcp/README.md': 'mcp/overview',
  'docs/mcp/tools.md': 'mcp/tools',
  'docs/mcp/approval.md': 'mcp/approvals',
};

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

const headingSlugs = (text) =>
  new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) => slug(m[1])));

const SKIP_DIRS = new Set(['node_modules', '.git', '.superpowers', '.docusaurus', 'build', 'dist']);
function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...markdownFiles(join(dir, entry.name)));
    } else if (/\.mdx?$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

// Anchors that files outside the pointers link to, as { pointer: Set<slug> }.
function referencedAnchors() {
  const wanted = {};
  const pointerPaths = new Set(Object.keys(POINTERS));
  for (const file of markdownFiles(ROOT)) {
    const rel = relative(ROOT, file);
    if (pointerPaths.has(rel) || rel.startsWith('apps/docs/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [, target, anchor] of text.matchAll(/\]\(([^)\s#]+\.md)#([^)\s]+)\)/g)) {
      const resolved = relative(ROOT, resolve(dirname(file), target));
      if (!pointerPaths.has(resolved)) continue;
      (wanted[resolved] ??= new Set()).add(anchor);
    }
  }
  return wanted;
}

for (const [file, page] of Object.entries(POINTERS)) {
  test(`${file} is a short pointer to the site`, () => {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
    const text = read(file);
    assert.ok(text.split('\n').length <= 60, `${file} is longer than 60 lines`);
    assert.ok(text.includes(SITE), `${file} does not link to ${SITE}`);
    assert.ok(text.includes(`${SITE}${page}/`), `${file} should link to ${SITE}${page}/`);
    assert.match(text, /^# .+/m, `${file} lost its H1`);
    assert.match(text, /This page moved to the documentation site: /);
    const source = text.match(/The source is `(apps\/docs\/docs\/[^`]+)`\./)?.[1];
    assert.ok(source, `${file} does not name its source`);
    assert.ok(existsSync(join(ROOT, source)), `${file} names a missing source ${source}`);
  });
}

test('pointers keep every heading that another file links to by anchor', () => {
  const wanted = referencedAnchors();
  for (const [file, anchors] of Object.entries(wanted)) {
    const have = headingSlugs(read(file));
    for (const anchor of anchors) {
      assert.ok(have.has(anchor), `${file} must keep the heading for #${anchor}`);
    }
  }
});
