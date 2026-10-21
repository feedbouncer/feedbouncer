// Keeps the self-hosting Meta app guide honest: structure, links, secrets and
// screenshots are checked here; scopes, paths and settings against the code.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findSecretLike } from './lib/secret-patterns.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = join(ROOT, 'docs/self-hosting');
const IMAGES = join(DOCS, 'images/meta-app');
const read = (p) => readFileSync(isAbsolute(p) ? p : join(ROOT, p), 'utf8');
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
  assert.equal(/\b\d{10,}\b/.test(guide), false);
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

const section = (title) => {
  const start = guide.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `no section ${title}`);
  const end = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, end === -1 ? undefined : end);
};

const tableRows = (md) =>
  md
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

const constBody = (file, name) => read(file).match(new RegExp(`${name} = \\[([^\\]]*)\\]`))[1];

const readScopes = (file, name) => {
  const body = constBody(file, name);
  const spread = [...body.matchAll(/\.\.\.(\w+)/g)].flatMap((m) => readScopes(file, m[1]));
  return [...[...body.matchAll(/'(\w+)'/g)].map((m) => m[1]), ...spread];
};

const FB_CONFIG = 'packages/connector-facebook/src/config.ts';
const IG_CONFIG = 'packages/connector-instagram/src/config.ts';

test('Written against version equals default FACEBOOK_GRAPH_API_VERSION', () => {
  const written = section('About this guide').match(/Written against: .*Graph API (v\d+\.0)/)?.[1];
  const current = read(FB_CONFIG).match(/'(v\d+\.0)'/)?.[1];
  assert.ok(written, 'About this guide has no "Written against" line');
  assert.equal(written, current);
});

const steps = guide
  .split(/^(?=### Step )/m)
  .slice(1)
  .map((block) => ({ block, ...block.match(/^### Step (?<n>\d+): (?<title>.+)/).groups }));

test('steps are numbered continuously and each has an image, config block or text marker and a verification line', () => {
  assert.ok(steps.length > 0, 'no steps');
  steps.forEach(({ block, n, title }, i) => {
    assert.equal(Number(n), i + 1, `step numbering breaks at "${title}"`);
    const image = block.match(/!\[([^\]]*)\]\(images\/meta-app\/([^)]+)\)/);
    if (image) {
      assert.ok(image[1].length >= 30, `step ${n} alt text is too short`);
      assert.ok(image[2].startsWith(`${String(n).padStart(2, '0')}-`), `step ${n} image name`);
      assert.ok(existsSync(join(IMAGES, image[2])), `step ${n} image is missing`);
    } else if (block.includes('<!-- step-kind: config -->')) {
      assert.ok(block.includes('```'), `config step ${n} has no code block`);
    } else {
      assert.ok(block.includes('<!-- step-kind: text -->'), `step ${n} has no image, config block or text marker`);
    }
    const prose = block.replace(/^### .*$/m, '').replace(/```[\s\S]*?```/g, '').replace(/!\[.*\)|<!--.*-->|^Last verified:.*$/gm, '');
    assert.ok(prose.trim().length >= 120, `step ${n} is too short to follow from the text alone`);
    assert.match(block, /^Last verified: (\d{4}-\d{2}-\d{2}|not yet checked on a live dashboard)$/m, `step ${n} verification line`);
  });
});

test('every image in images/meta-app is referenced exactly once', () => {
  const referenced = [...guide.matchAll(/\]\(images\/meta-app\/([^)]+)\)/g)].map((m) => m[1]);
  const onDisk = readdirSync(IMAGES).filter((f) => f.endsWith('.png'));
  assert.deepEqual([...referenced].sort(), onDisk.sort());
});

test('callback and redirect paths in the guide match the code', () => {
  const plugin = read('apps/api/src/webhooks/meta-webhooks.plugin.ts');
  for (const platform of ['facebook', 'instagram']) {
    assert.ok(plugin.includes(`/api/v1/webhooks/${platform}`), `code lost the ${platform} webhook path`);
    assert.ok(guide.includes(`/api/v1/webhooks/${platform}`), `guide lacks the ${platform} webhook path`);
    assert.ok(guide.includes(`/api/v1/oauth/${platform}/callback`), `guide lacks the ${platform} callback path`);
  }
});

test('configuration map names only settings documented in .env.example', () => {
  const rows = tableRows(section('Configuration map'));
  const settings = rows.map((r) => r[2]).join(' ');
  const envExample = read('.env.example');
  for (const name of ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_WEBHOOK_VERIFY_TOKEN', 'PUBLIC_WEB_URL', 'FACEBOOK_GRAPH_API_VERSION', 'INSTAGRAM_CONNECTOR_ENABLED'])
    assert.ok(settings.includes(name), `${name} is missing from the map`);
  for (const [name] of settings.matchAll(/\b[A-Z][A-Z_]{3,}\b/g))
    assert.ok(envExample.includes(name), `${name} is not in .env.example`);
  const token = rows.find((r) => r[0].startsWith('Access token'));
  assert.ok(token?.[2].startsWith('None'), 'access token row must say None');
});

test('permissions table lists exactly the Facebook and Instagram scopes', () => {
  const body = section('Permissions and why');
  const rows = tableRows(body);
  const expected = new Set([...readScopes(FB_CONFIG, 'FACEBOOK_SCOPES'), ...readScopes(IG_CONFIG, 'INSTAGRAM_SCOPES')]);
  assert.deepEqual(new Set(rows.map((r) => r[0].replaceAll('`', ''))), expected);
  assert.equal(rows.length, expected.size);
  for (const row of rows) assert.ok(row.length === 4 && row.every(Boolean), `empty cell in ${row[0]}`);
  assert.match(body, /Checked against Meta's documentation on \d{4}-\d{2}-\d{2}/);
});

test('troubleshooting covers the required symptoms', () => {
  const headings = [...section('Troubleshooting').matchAll(/^### (.+)$/gm)].map((m) => m[1].toLowerCase());
  for (const symptom of ["won't save the webhook", "don't show up", 'only your own comments', 'needs reconnect', 'instagram account', 'missing permissions', 'nothing gets hidden'])
    assert.ok(headings.some((h) => h.includes(symptom)), `no troubleshooting entry for "${symptom}"`);
});

test('Instagram prerequisites precede the first Instagram step', () => {
  const intro = section('Part 7: Connect Instagram (optional)').split('### Step')[0];
  for (const word of ['professional account', 'linked', 'Facebook Page', 'Advanced Access'])
    assert.ok(intro.includes(word), `Part 7 intro lacks "${word}"`);
});

test('required callouts are present', () => {
  const has = (title, ...words) => words.forEach((w) => assert.ok(section(title).includes(w), `"${title}" lacks "${w}"`));
  has('Development mode and Live mode', 'role on the app');
  has('Test it end to end', 'role on the app', 'Suggestions');
  has('Before you start', 'tunnel', 'HTTPS');
  has('Keep your app secret and tokens safe', '_FILE', 'rotate');
  has('About this guide', 'another language');
  has('When you need App Review or Business Verification', 'https://developers.facebook.com/');
});
