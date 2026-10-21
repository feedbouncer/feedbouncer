// Keeps the self-hosting Meta app guide honest: structure, links, secrets and
// screenshots are checked here; scopes, paths and settings against the code.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findSecretLike } from './lib/secret-patterns.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = join(ROOT, 'docs/self-hosting');
const IMAGES = join(DOCS, 'images/meta-app');
const read = (p) => readFileSync(p.startsWith('/') ? p : join(ROOT, p), 'utf8');
const guide = read(join(DOCS, 'meta-app.md'));

const EXPECTED_H2S = [
  'About this guide',
  'Before you start',
  'Part 1: Create your Meta developer account and app',
  'Part 2: Add the products FeedBouncer needs',
  'Part 3: Collect your app credentials',
  'Part 4: Configure FeedBouncer',
  'Part 5: Configure the webhook',
  'Part 6: Connect your Facebook Page',
  'Part 7: Connect Instagram (optional)',
  'Configuration map',
  'Permissions and why',
  'Development mode and Live mode',
  'Tokens: how long they last',
  'Test it end to end',
  'Troubleshooting',
  'Keep your app secret and tokens safe',
  'When you need App Review or Business Verification',
  'More Pages and accounts',
];

const stripFences = (md) => md.replace(/```[\s\S]*?```/g, '');
const h2s = (md) => [...stripFences(md).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

/** GitHub-style heading slug. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const anchorsOf = (file) => {
  const seen = new Map();
  const out = new Set();
  for (const [, heading] of stripFences(read(file)).matchAll(/^#{1,6} (.+)$/gm)) {
    const base = slug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
};

const selfHostingDocs = () =>
  readdirSync(DOCS)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(DOCS, f));

/** Placeholders such as <APP_ID> are fine; long digit runs look like real Meta IDs. */
const stripCodeOfPlaceholders = (md) => md.replace(/<[A-Z_]+>/g, '');

/** Chunk list of a PNG: [{ type, length }]. */
function pngChunks(buf) {
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'not a PNG file');
  const chunks = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    chunks.push({ type: buf.toString('latin1', at + 4, at + 8), length });
    at += 12 + length;
  }
  return chunks;
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('guide exists and H2 headings appear in the planned order', () => {
  assert.deepEqual(h2s(guide), EXPECTED_H2S);
});

test('guide is linked from README, self-hosting index, facebook.md and instagram.md', () => {
  assert.ok(read('README.md').includes('](docs/self-hosting/meta-app.md'));
  assert.ok(read('README.md').includes('](docs/self-hosting/README.md'));
  assert.ok(read(join(DOCS, 'README.md')).includes('](meta-app.md'));
  for (const f of ['facebook.md', 'instagram.md'])
    assert.ok(
      read(`docs/connectors/${f}`).includes('](../self-hosting/meta-app.md'),
      `${f} does not link the guide`,
    );
});

test('all relative links and #anchors in docs/self-hosting/*.md resolve', () => {
  for (const file of selfHostingDocs()) {
    const text = stripFences(read(file));
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [path, anchor] = href.split('#');
      const target = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
      const name = `${relative(ROOT, file)}: ${href}`;
      assert.ok(existsSync(target), `${name} is a broken link`);
      if (anchor && target.endsWith('.md'))
        assert.ok(anchorsOf(target).has(anchor), `${name} has no such heading`);
    }
  }
});

test('guide and images contain no secret-shaped strings or metadata', () => {
  assert.deepEqual(findSecretLike(guide), []);
  assert.equal(/\b\d{10,}\b/.test(stripCodeOfPlaceholders(guide)), false);
  const pngs = readdirSync(IMAGES).filter((f) => f.endsWith('.png'));
  for (const name of pngs) {
    const buf = readFileSync(join(IMAGES, name));
    const types = pngChunks(buf).map((c) => c.type);
    for (const banned of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'])
      assert.ok(!types.includes(banned), `${name} has a ${banned} chunk`);
    assert.ok(statSync(join(IMAGES, name)).size <= 500 * 1024, `${name} is over 500 KB`);
    assert.ok(pngSize(buf).width <= 1600, `${name} is wider than 1600 px`);
  }
});

test('secret finder flags secret shapes and ignores plain prose', () => {
  assert.equal(findSecretLike('token EAA' + 'x'.repeat(40)).length, 1);
  assert.deepEqual(findSecretLike('set <APP_SECRET> and restart'), []);
});

test('PNG helpers report chunk types and size', () => {
  const header = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(800, 16);
  header.writeUInt32BE(600, 20);
  assert.deepEqual(
    pngChunks(header).map((c) => c.type),
    ['IHDR'],
  );
  assert.deepEqual(pngSize(header), { width: 800, height: 600 });
});

// Written when the sections they check are filled in (Tasks 2-5 of the plan).
const later = (task) => ({ todo: task });
test('Written against version equals default FACEBOOK_GRAPH_API_VERSION', later('Task 3'));
test('every step has an image or config block, alt text and a Last verified date', later('Task 3'));
test('every image in images/meta-app is referenced exactly once', later('Task 3'));
test('callback and redirect URLs in the guide match code', later('Task 3'));
test('configuration map names only settings documented in .env.example', later('Task 3'));
test('permissions table lists exactly the Facebook and Instagram scopes', later('Task 2'));
test('troubleshooting covers the required symptoms', later('Task 5'));
test('Instagram prerequisites precede the first Instagram step', later('Task 4'));
test('required callouts are present', later('Task 5'));
