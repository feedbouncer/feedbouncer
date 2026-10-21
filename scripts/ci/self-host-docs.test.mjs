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
  'Status of this guide',
  'About this guide',
  'Meta terms used in this guide',
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
  'Rotate secrets and tokens',
  'When you need App Review or Business Verification',
  'More Pages and accounts',
];
const NOTE_EXEMPT = ['Status of this guide', 'About this guide', 'Part 4: Configure FeedBouncer'];
const NOTE_RE =
  /^> Not yet verified against Meta's (dashboard|documentation) as of (\d{4}-\d{2}-\d{2})\. Check: .{10,}$/m;
const MARKER_RE =
  /^> \[SCREENSHOT: ([a-z0-9][a-z0-9 ,/'-]{3,59})\] Must show: .{15,}\. Redact: .{3,}\.$/gm;
const UI_STRINGS = [
  'FeedBouncer lacks the permission for this action',
  'Meta asked FeedBouncer to slow down',
  'Needs reconnect',
];
const ALLOWED_HOSTS = [
  'developers.facebook.com',
  'www.facebook.com',
  'business.facebook.com',
  'help.instagram.com',
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

test('guide exists and H2 headings appear in the planned order', { todo: 'Task 2' }, () => {
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
});

const section = (title) => {
  const start = guide.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `no section ${title}`);
  const end = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, end === -1 ? undefined : end);
};

const notedSections = () => EXPECTED_H2S.filter((h) => NOTE_RE.test(section(h)));
const markers = (md) => [...md.matchAll(MARKER_RE)].map((m) => m[1]);
const fences = (md) => [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
const h3Blocks = (md) => md.split(/^(?=### )/m).slice(1);

const webSrcText = () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [readFileSync(p, 'utf8')] : [];
    });
  return walk(join(ROOT, 'apps/web/src')).join('\n');
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

const constBody = (file, name) => {
  const match = read(file).match(new RegExp(`${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `${name} not found in ${file}`);
  return match[1];
};

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

const stepBody = (block) => block.split('\n').slice(1).join('\n');

test(
  'every step starts with a Goal line and has a marker or a code block',
  { todo: 'Task 2' },
  () => {
    assert.ok(steps.length > 0, 'no steps');
    steps.forEach(({ block, n, title }, i) => {
      assert.equal(Number(n), i + 1, `step numbering breaks at "${title}"`);
      const firstLine = stepBody(block)
        .split('\n')
        .find((l) => l.trim() !== '');
      assert.ok(firstLine?.startsWith('**Goal:** '), `step ${n} lacks a Goal line`);
      assert.ok(
        [...block.matchAll(MARKER_RE)].length > 0 || block.includes('```'),
        `step ${n} has neither a screenshot marker nor a code block`,
      );
    });
  },
);

test(
  'every Meta-dependent section carries a dated not-yet-verified note first',
  { todo: 'Task 2' },
  () => {
    for (const t of EXPECTED_H2S.filter((h) => !NOTE_EXEMPT.includes(h))) {
      const firstPara = section(t)
        .trim()
        .split(/\n\s*\n/)[1];
      assert.match(firstPara, NOTE_RE, `${t} lacks a leading note`);
      assert.ok(new Date(firstPara.match(NOTE_RE)[2]) <= new Date(), `${t} note dated in future`);
    }
  },
);

test(
  'status block lists every noted section and says nothing is verified',
  { todo: 'Task 2' },
  () => {
    const s = section('Status of this guide');
    const rows = tableRows(s);
    const noted = notedSections();
    assert.deepEqual(rows.map((r) => r[0]).sort(), [...noted].sort());
    for (const [name, status] of rows)
      assert.match(
        status,
        noted.includes(name) ? /^Not yet verified$/ : /^Verified \d{4}-\d{2}-\d{2}$/,
      );
    if (rows.every((r) => r[1] === 'Not yet verified'))
      assert.ok(
        s.includes('Nothing in this guide has been verified against a live Meta dashboard yet.'),
      );
    assert.ok(s.includes('](meta-app-verification.md'));
  },
);

test('guide never claims verification', { todo: 'Task 2' }, () => {
  for (const banned of [/Checked against/i, /^Last verified: 20/m, /\bverified on\b/i])
    assert.doesNotMatch(guide, banned);
});

test(
  'screenshot markers are well-formed and unique, and no real images are embedded',
  { todo: 'Task 2' },
  () => {
    const names = markers(guide);
    assert.ok(names.length >= 15);
    assert.equal(new Set(names).size, names.length);
    assert.equal(guide.split('\n').filter((l) => l.includes('[SCREENSHOT')).length, names.length);
    assert.doesNotMatch(guide, /!\[/);
    assert.equal(existsSync(join(DOCS, 'images')), false);
  },
);

test('each Part 1-7 ends with a Checkpoint', { todo: 'Task 2' }, () => {
  const parts = EXPECTED_H2S.filter((h) => /^Part [1-7]:/.test(h));
  assert.equal(parts.length, 7);
  for (const t of parts) {
    const body = section(t);
    const lastStep = body.lastIndexOf('\n### Step ');
    const checkpoint = body.lastIndexOf('\n**Checkpoint:** ');
    assert.ok(checkpoint > lastStep, `${t}: Checkpoint must follow the last step`);
    const line = body
      .slice(checkpoint + 1)
      .split('\n')[0]
      .slice('**Checkpoint:** '.length);
    assert.ok(line.length >= 40, `${t}: Checkpoint is too short`);
  }
});

test('code blocks use placeholders only', () => {
  const code = fences(guide).join('\n');
  for (const [, name, value] of code.matchAll(
    /^(FACEBOOK_APP_ID|FACEBOOK_APP_SECRET|FACEBOOK_WEBHOOK_VERIFY_TOKEN)=(.*)$/gm,
  ))
    assert.match(value, /^<[A-Z_]+>$/, `${name} must be a placeholder`);
  const urls = [...code.matchAll(/PUBLIC_WEB_URL[:=]\s*(\S+)/g)];
  assert.ok(urls.length > 0, 'no PUBLIC_WEB_URL example found');
  for (const [, value] of urls) assert.equal(value, 'https://feedbouncer.example.com');
  const tokens = [...guide.matchAll(/hub\.verify_token=([^\s&"'`]*)/g)];
  assert.ok(tokens.length > 0, 'no hub.verify_token example found');
  for (const [, value] of tokens) assert.equal(value, 'wrong');
});

test('external links are https and on allowed Meta hosts', () => {
  for (const file of selfHostingDocs())
    for (const [, href] of stripFences(read(file)).matchAll(/\]\((https?:[^)\s]+)/g)) {
      const url = new URL(href);
      const name = `${relative(ROOT, file)}: ${href}`;
      assert.equal(url.protocol, 'https:', `${name} is not https`);
      assert.ok(ALLOWED_HOSTS.includes(url.hostname), `${name} is not on an allowed host`);
    }
});

test('troubleshooting covers the required symptoms', { todo: 'Task 3' }, () => {
  const blocks = h3Blocks(section('Troubleshooting'));
  const heading = (b) => b.split('\n')[0].toLowerCase();
  for (const symptom of [
    "won't save the webhook",
    "don't show up",
    'only your own comments',
    'needs reconnect',
    'instagram account',
    'missing permissions',
    'nothing gets hidden',
    'permission error',
    'slow down',
  ])
    assert.ok(
      blocks.some((b) => heading(b).includes(symptom)),
      `troubleshooting lacks "${symptom}"`,
    );
  const webhook = blocks.find((b) => heading(b).includes("won't save the webhook"));
  for (const term of ['reverse proxy', 'HTTPS', 'X-Hub-Signature-256'])
    assert.ok(webhook?.includes(term), `webhook entry lacks "${term}"`);
});

test('quoted FeedBouncer UI strings exist in apps/web/src', { todo: 'Task 3' }, () => {
  const web = webSrcText();
  for (const s of UI_STRINGS) {
    assert.ok(guide.includes(s), `guide lacks "${s}"`);
    assert.ok(web.includes(s), `UI no longer says "${s}"`);
  }
});

test('required callouts are present', { todo: 'Task 3' }, () => {
  const expectations = {
    'Before you start': ['personal profile', 'professional account', 'HTTPS', 'admin'],
    'Development mode and Live mode': ['role on the app'],
    'Test it end to end': ['role on the app', 'Suggestion'],
    'Keep your app secret and tokens safe': ['redact', 'App ID', 'query string', 'opaque'],
    'Rotate secrets and tokens': ['app secret', 'verify token', 'FB_ENCRYPTION_KEYS', 'Reconnect'],
    'More Pages and accounts': ['same app'],
    'Meta terms used in this guide': [
      'Development mode',
      'Live mode',
      'App Review',
      'Business Verification',
      'system user',
    ],
    'When you need App Review or Business Verification': [
      'https://developers.facebook.com',
      "Meta's documentation says",
    ],
  };
  for (const [title, terms] of Object.entries(expectations)) {
    const body = section(title);
    for (const term of terms)
      assert.ok(body.toLowerCase().includes(term.toLowerCase()), `${title} lacks "${term}"`);
  }
});

test('verification doc lists every slot and every noted section', { todo: 'Task 4' }, () => {
  const v = read(join(DOCS, 'meta-app-verification.md'));
  const vh2s = h2s(v);
  for (const h of [
    'Scope',
    'Screenshots',
    'Permissions and policy check',
    'Two-reader dry run',
    'Removing a "not yet verified" note',
    'Dry-run record',
  ])
    assert.ok(vh2s.includes(h), `verification doc lacks "${h}"`);
  const checklist = (title) => {
    const start = v.indexOf(`\n## ${title}\n`);
    assert.notEqual(start, -1, `no section ${title}`);
    const end = v.indexOf('\n## ', start + 1);
    return v
      .slice(start, end === -1 ? undefined : end)
      .split('\n')
      .filter((l) => l.startsWith('- [ ] '))
      .map((l) => l.slice(6).replaceAll('`', '').trim());
  };
  assert.deepEqual(new Set(checklist('Screenshots')), new Set(markers(guide)));
  assert.deepEqual(
    new Set(checklist('Removing a "not yet verified" note')),
    new Set(notedSections()),
  );
  assert.ok(read(join(DOCS, 'README.md')).includes('](meta-app-verification.md'));
});

test('webhook and OAuth callback paths in the guide match the code', () => {
  const metaDeps = read('apps/api/src/meta-deps.ts');
  assert.ok(
    metaDeps.includes('/api/v1/oauth/${p}/callback'),
    'code changed the OAuth callback path',
  );
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
  assert.ok(body.includes('](https://developers.facebook.com/docs/permissions'));
  assert.ok(
    body.includes('](https://developers.facebook.com/docs/graph-api/overview/access-levels'),
  );
});
