// Keeps the connector developer guide honest: links resolve, every contract
// area is covered, every name it imports or mentions exists in the package,
// and code excerpts tagged `from=<file>` are lines that really exist there.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'packages/connectors/src');
const GUIDE = join(ROOT, 'docs/connectors/writing-a-connector.md');
const README = join(ROOT, 'packages/connectors/README.md');

const EXPORT_DECL =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/gm;
const EXPORT_STAR = /^export\s+\*\s+from\s+'(\.[^']+)'/gm;

/** Names exported by a module, following `export *` and `export { } from` re-exports. */
function exportsOf(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return new Set();
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  for (const [, n] of text.matchAll(EXPORT_DECL)) names.add(n);
  for (const [, list] of text.matchAll(EXPORT_LIST))
    for (const item of list.split(',')) {
      const n = item
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (n) names.add(n);
    }
  for (const [, rel] of text.matchAll(EXPORT_STAR))
    for (const n of exportsOf(resolve(dirname(file), rel.replace(/\.js$/, '.ts')), seen))
      names.add(n);
  return names;
}

const publicNames = {
  '@feedbouncer/connectors': exportsOf(join(SRC, 'index.ts')),
  '@feedbouncer/connectors/testing': exportsOf(join(SRC, 'testing/index.ts')),
};

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

const md = (path) => readFileSync(path, 'utf8');

test('guide and package README exist and their relative links resolve', () => {
  for (const file of [GUIDE, README]) {
    assert.ok(existsSync(file), `${file} is missing`);
    for (const [, href] of md(file).matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g))
      assert.ok(existsSync(resolve(dirname(file), href)), `broken link in ${file}: ${href}`);
  }
});

test('the guide covers every contract area, in order', () => {
  const text = md(GUIDE);
  let at = -1;
  for (const heading of [
    '## Overview',
    '## Declaring capabilities',
    '## OAuth',
    '## Token refresh',
    '## Reading',
    '## Acting',
    '## Webhooks',
    '## Rate limits',
    '## Errors',
    '## Security checklist',
    '## Running the conformance suite',
  ]) {
    const i = text.indexOf(`\n${heading}\n`);
    assert.ok(i > at, `missing or out-of-order section ${heading}`);
    at = i;
  }
});

test('every name the guide imports from the package is exported', () => {
  const text = md(GUIDE);
  let imports = 0;
  for (const [, list, from] of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(@feedbouncer\/connectors(?:\/testing)?)'/g,
  )) {
    for (const item of list.split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (!name) continue;
      imports += 1;
      assert.ok(publicNames[from].has(name), `${name} is not exported from ${from}`);
    }
  }
  assert.ok(imports > 0, 'the guide should show its imports');
});

test('names mentioned in backticks exist', () => {
  // Not part of this package: platform types and the secrets wrapper.
  const external = new Set([
    'Secret',
    'URL',
    'URLSearchParams',
    'Buffer',
    'Headers',
    'Date',
    'AbortSignal',
    'Promise',
    'Error',
    'Retry',
    'Postgres',
    'Redis',
    'PKCE',
    'HMAC',
    'OAuth',
    'HTTP',
    'ConnectionScope',
  ]);
  const all = new Set([
    ...publicNames['@feedbouncer/connectors'],
    ...publicNames['@feedbouncer/connectors/testing'],
  ]);
  const sourceText = sourceFiles(SRC)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  // Strip fenced code first so only prose mentions are checked here.
  const prose = md(GUIDE).replace(/```[\s\S]*?```/g, '');
  for (const [, name, call] of prose.matchAll(/`([A-Za-z_$][\w$]*)(\(\))?(?:\.[\w$]+)?`/g)) {
    if (/^[A-Z]/.test(name)) {
      assert.ok(all.has(name) || external.has(name), `\`${name}\` is not exported`);
    } else if (call) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(sourceText), `\`${name}()\` is not in the source`);
    }
  }
});

test('excerpts tagged from=<file> are made of real lines of that file', () => {
  const text = md(GUIDE);
  let blocks = 0;
  for (const [, file, body] of text.matchAll(/```ts from=(\S+)\n([\s\S]*?)```/g)) {
    blocks += 1;
    const target = join(SRC, file);
    assert.ok(existsSync(target), `from=${file} does not exist`);
    const lines = new Set(
      md(target)
        .split('\n')
        .map((l) => l.trim()),
    );
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('// ...')) continue;
      assert.ok(lines.has(line), `not a line of ${file}: ${line}`);
    }
  }
  assert.ok(blocks >= 5, 'the guide should excerpt the reference connector');
});

test('the guide does not describe behaviour that was removed', () => {
  const text = md(GUIDE);
  assert.ok(!/`deliveryId`/.test(text), 'WebhookSpec has no deliveryId');
  assert.ok(!/process\.env\.[A-Z]/.test(text.replace(/never[^\n]*process\.env[^\n]*/gi, '')));
});

test('the guide states the exact error code pattern from service-runtime', () => {
  const src = readFileSync(join(SRC, '../../service-runtime/src/error-class.ts'), 'utf8');
  const m = src.match(/const ERROR_CODE = \/(.+)\/;/);
  assert.ok(m, 'could not find ERROR_CODE in error-class.ts');
  assert.ok(md(GUIDE).includes(`\`${m[1]}\``), `guide must contain \`${m[1]}\` verbatim`);
});
