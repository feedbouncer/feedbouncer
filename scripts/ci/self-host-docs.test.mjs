// Keeps the self-hosting Meta app guide honest: structure, links and secrets are
// checked here; scopes, paths and settings against the code.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findSecretLike } from './lib/secret-patterns.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = join(ROOT, 'docs/self-hosting');
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

test('guide contains no secret-shaped strings or ID-length numbers', () => {
  assert.deepEqual(findSecretLike(guide), []);
  assert.equal(/\b\d{10,}\b/.test(guide), false);
  assert.deepEqual(findSecretLike('set <APP_SECRET> and restart'), []);
  assert.equal(findSecretLike('token EAA' + 'x'.repeat(40)).length, 1);
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
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );

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

test('steps are numbered continuously and each has a verification line', () => {
  assert.ok(steps.length > 0, 'no steps');
  steps.forEach(({ block, n, title }, i) => {
    assert.equal(Number(n), i + 1, `step numbering breaks at "${title}"`);
    assert.match(
      block,
      /^Last verified: (\d{4}-\d{2}-\d{2}|not yet checked on a live dashboard)$/m,
      `step ${n} verification line`,
    );
  });
});

test('callback and redirect paths in the guide match the code', () => {
  const plugin = read('apps/api/src/webhooks/meta-webhooks.plugin.ts');
  for (const platform of ['facebook', 'instagram']) {
    assert.ok(
      plugin.includes(`/api/v1/webhooks/${platform}`),
      `code lost the ${platform} webhook path`,
    );
    assert.ok(
      guide.includes(`/api/v1/webhooks/${platform}`),
      `guide lacks the ${platform} webhook path`,
    );
    assert.ok(
      guide.includes(`/api/v1/oauth/${platform}/callback`),
      `guide lacks the ${platform} callback path`,
    );
  }
});

test('configuration map names only settings documented in .env.example', () => {
  const rows = tableRows(section('Configuration map'));
  const settings = rows.map((r) => r[2]).join(' ');
  const envExample = read('.env.example');
  for (const name of [
    'FACEBOOK_APP_ID',
    'FACEBOOK_APP_SECRET',
    'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
    'PUBLIC_WEB_URL',
    'FACEBOOK_GRAPH_API_VERSION',
    'INSTAGRAM_CONNECTOR_ENABLED',
  ])
    assert.ok(settings.includes(name), `${name} is missing from the map`);
  for (const [name] of settings.matchAll(/\b[A-Z][A-Z_]{3,}\b/g))
    assert.ok(envExample.includes(name), `${name} is not in .env.example`);
  const token = rows.find((r) => r[0].startsWith('Access token'));
  assert.ok(token?.[2].startsWith('None'), 'access token row must say None');
});

test('permissions table lists exactly the Facebook and Instagram scopes', () => {
  const body = section('Permissions and why');
  const rows = tableRows(body);
  const expected = new Set([
    ...readScopes(FB_CONFIG, 'FACEBOOK_SCOPES'),
    ...readScopes(IG_CONFIG, 'INSTAGRAM_SCOPES'),
  ]);
  assert.deepEqual(new Set(rows.map((r) => r[0].replaceAll('`', ''))), expected);
  assert.equal(rows.length, expected.size);
  for (const row of rows)
    assert.ok(row.length === 4 && row.every(Boolean), `empty cell in ${row[0]}`);
  assert.match(body, /Checked against Meta's documentation on \d{4}-\d{2}-\d{2}/);
});
