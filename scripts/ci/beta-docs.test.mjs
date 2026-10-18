// Keeps the private-beta docs honest: required sections exist, the action
// table matches the shipped actions, and nothing claims behaviour the product
// does not have.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BETA = join(ROOT, 'docs/beta');
const GUIDE = join(BETA, 'partner-guide.md');
const RUNBOOK = join(BETA, 'operator-runbook.md');
const DELETION = join(ROOT, 'docs/operations/data-deletion.md');

const read = (p) => {
  assert.ok(existsSync(p), `${p} is missing`);
  return readFileSync(p, 'utf8');
};

const betaFiles = () => [
  ...(existsSync(BETA)
    ? readdirSync(BETA)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(BETA, f))
    : []),
  DELETION,
];

const ALL_DOCS = [
  GUIDE,
  RUNBOOK,
  join(BETA, 'feedback-form.md'),
  join(BETA, 'beta-summary.md'),
  DELETION,
];

const GUIDE_HEADINGS = [
  '## Before you start: accept the tester invitation',
  '## Connect your Page or Instagram account',
  '## What FeedBouncer can do',
  '## See what FeedBouncer did and why',
  '## When FeedBouncer needs you to reconnect',
  '## Delays and limits',
  '## Known limitations',
  '## Moving to production',
  '## Leaving the beta and deleting your data',
  '## Contact',
];

/** Lines of the section that starts at `heading`, up to the next `## `. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `missing heading: ${heading}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

test('all beta docs exist', () => {
  for (const f of ALL_DOCS) assert.ok(existsSync(f), `${f} is missing`);
});

test('partner guide has the required sections in order', () => {
  const headings = read(GUIDE)
    .split('\n')
    .filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, GUIDE_HEADINGS);
});

test('action table lists exactly the shipped actions', () => {
  const messages = readFileSync(join(ROOT, 'apps/web/src/lib/messages.ts'), 'utf8');
  const block = /const ACTION_KINDS[^=]*=\s*\{([^}]*)\}/.exec(messages);
  assert.ok(block, 'ACTION_KINDS not found in messages.ts');
  const labels = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 7, 'expected the action labels');
  const rows = section(read(GUIDE), '## What FeedBouncer can do').filter((l) => l.startsWith('|'));
  assert.match(rows[0], /^\|\s*Action\s*\|\s*Facebook\s*\|\s*Instagram\s*\|\s*Undo\s*\|$/);
  const names = rows.slice(2).map((l) => l.split('|')[1].trim());
  assert.deepEqual([...names].sort(), [...labels, 'Flag for review'].sort());
});

test('Instagram ban row says not supported', () => {
  const rows = section(read(GUIDE), '## What FeedBouncer can do').filter((l) => l.startsWith('|'));
  for (const label of ['Ban author', 'Unban author']) {
    const row = rows.find((l) => l.split('|')[1].trim() === label);
    assert.ok(row, `no row for ${label}`);
    assert.match(
      row.split('|')[3],
      /not supported/i,
      `${label} must be not supported on Instagram`,
    );
  }
});

test('no unsupported claims in beta docs', () => {
  for (const file of betaFiles()) {
    const text = read(file);
    text.split('\n').forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      if (/\breport (a|the)? ?(comment|action)s?\b/i.test(line))
        assert.match(line, /no report/i, `${where} claims a report action`);
      assert.ok(
        !/purged? automatically|auto-?purge(?! is not)/i.test(line),
        `${where}: auto purge`,
      );
      assert.ok(!/token[^.]*deleted automatically/i.test(line), `${where}: token auto-delete`);
    });
  }
});

test('guide states reconnect behaviour and production re-authorization', () => {
  const text = read(GUIDE);
  for (const needle of ['reconnect_required', 'paused', 'reconnect once'])
    assert.ok(text.includes(needle), `guide must mention "${needle}"`);
  const reconnect = section(text, '## When FeedBouncer needs you to reconnect').join('\n');
  assert.match(reconnect, /until you disconnect/i);
  assert.match(reconnect, /resume|replayed/i);
});

test('guide quotes the shipped partner-facing messages', () => {
  const guide = read(GUIDE);
  const messages = readFileSync(join(ROOT, 'apps/web/src/lib/messages.ts'), 'utf8');
  const accounts = readFileSync(join(ROOT, 'apps/web/src/lib/accounts.ts'), 'utf8');
  assert.ok(messages.includes("Facebook didn't finish connecting."));
  assert.ok(guide.includes("Facebook didn't finish connecting."));
  const role = /insufficient_page_role:\s*'([^']+)'/.exec(accounts);
  assert.ok(role && guide.includes(role[1]), 'guide must quote the insufficient_page_role text');
  assert.ok(guide.includes('Processing delayed'));
});

test('classifier languages in guide match code default', () => {
  const config = readFileSync(join(ROOT, 'packages/classifier/src/config.ts'), 'utf8');
  const fallback = /'CLASSIFIER_LANGUAGES'[\s\S]*?fallback:\s*'([^']+)'/.exec(config);
  assert.ok(fallback, 'default languages not found');
  const limits = section(read(GUIDE), '## Delays and limits').join(' ').replace(/\s+/g, ' ');
  assert.ok(limits.includes(`\`${fallback[1]}\``), `guide must list \`${fallback[1]}\``);
  assert.match(limits, /flagged for review/i);
});

test('deletion procedure has owner, turnaround and existing commands', () => {
  const text = read(DELETION);
  for (const h of [
    '## Owner',
    '## Turnaround',
    '## Procedure',
    '## Confirmation email',
    '## Record',
  ])
    assert.ok(text.split('\n').includes(h), `missing ${h}`);
  assert.match(text, /Beta operator/);
  assert.ok(text.includes('5 business days'));
  assert.ok(text.includes('30 days'));
  assert.match(text, /\|\s*Request date\s*\|\s*Org id\s*\|\s*Completed\s*\|\s*By\s*\|/);
  assert.ok(
    text.includes('pnpm ops erase-org --org <id> --confirm "<name>" --delete-orphan-users'),
  );
  assert.match(section(text, '## Procedure').join('\n'), /backup retention|no backups beyond/i);
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  for (const file of betaFiles())
    for (const [, name] of read(file).matchAll(/`pnpm (?:run )?([a-z][\w:-]*)/g))
      assert.ok(name in scripts, `${file}: \`pnpm ${name}\` is not a root script`);
});

test('runbook covers invites, daily status, the DLQ and offboarding', () => {
  const text = read(RUNBOOK);
  for (const needle of [
    'SIGNUP_ALLOWED_EMAILS',
    'Tester',
    'pnpm ops beta-status',
    'exit code 2',
    'pnpm jobs dlq list',
    'pnpm jobs dlq replay',
    'BETA_FEEDBACK_URL',
    'BETA_SUPPORT_EMAIL',
    'INSTAGRAM_CONNECTOR_ENABLED',
    'data-deletion.md',
  ])
    assert.ok(text.includes(needle), `runbook must mention ${needle}`);
  for (const h of ['## Weekly check-in', '## Offboarding'])
    assert.ok(text.split('\n').includes(h), `runbook missing ${h}`);
});

test('feedback form has the fixed weekly questions', () => {
  const text = read(join(BETA, 'feedback-form.md'));
  for (const needle of ['False positives', 'False negatives', '1 to 5', 'Missing features', 'Bugs'])
    assert.ok(text.includes(needle), `feedback form must mention ${needle}`);
});

test('no emails other than @feedbouncer.com, no tokens, only the deletion placeholder', () => {
  for (const file of betaFiles()) {
    const text = read(file);
    assert.ok(!/EAA[A-Za-z0-9]{20,}/.test(text), `${file}: looks like a Meta token`);
    for (const [email] of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
      assert.ok(email.endsWith('@feedbouncer.com'), `${file}: foreign email ${email}`);
    const placeholders = [...text.matchAll(/<[A-Za-z][\w -]*>/g)].map((m) => m[0]);
    if (file !== DELETION && file !== RUNBOOK)
      assert.deepEqual(placeholders, [], `${file}: unexpected placeholders`);
  }
  assert.match(read(DELETION), /\[backup retention statement\]/);
});

test('relative links resolve', () => {
  const files = [
    ...betaFiles(),
    join(ROOT, 'docs/connectors/facebook.md'),
    join(ROOT, 'docs/connectors/instagram.md'),
  ];
  for (const file of files)
    for (const [, href] of read(file).matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g))
      assert.ok(existsSync(resolve(dirname(file), href)), `broken link in ${file}: ${href}`);
});

test('connector docs link to the beta guide and the deletion procedure', () => {
  const fb = read(join(ROOT, 'docs/connectors/facebook.md'));
  const ig = read(join(ROOT, 'docs/connectors/instagram.md'));
  assert.ok(fb.includes('../beta/partner-guide.md'));
  assert.ok(ig.includes('../beta/partner-guide.md'));
  assert.ok(ig.includes('../operations/data-deletion.md'));
  assert.ok(!/open question/i.test(ig));
});
