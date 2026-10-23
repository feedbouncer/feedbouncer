// Keeps the launch document honest: structure, publishing gates, prepared-answer sources
// and a scan of docs/launch/ for secrets, foreign emails and placeholders.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertGates,
  CHANNELS,
  LAUNCH_DOC,
  parseLaunchDoc,
  section,
  sourcesOf,
  urlPatternFor,
} from './lib/launch-doc.mjs';
import { findSecretLike } from './lib/secret-patterns.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCH_DIR = join(ROOT, 'docs/launch');
const md = readFileSync(join(ROOT, LAUNCH_DOC), 'utf8');
const doc = parseLaunchDoc(md);

const CHECKLIST = [
  'README explains the problem, shows the demo, has a quick start and the license',
  'Contributing guide, issue templates and code of conduct are in place',
  'Release v0.1.0 is tagged and has release notes',
  'CI is green on main',
  'Docs site builds and the link check passes',
  'The published docs site returns 200',
  'Quick start works from a fresh clone',
  'Demo is under 60 seconds and reviewed for private data',
  'r/FacebookAds rules checked',
  'Launch date checked against holidays and known outages',
  'Prepared answers reviewed',
];

const fixture = ({ drop, rowStatus = 'draft', untick } = {}) => {
  const live = rowStatus !== 'draft';
  const text = `# Launch
## Status and approval
**Status:** ${live ? 'approved' : 'draft'}
**Approved by:** ${live ? '@maria on 2026-11-01' : 'not yet'}
## Owners and schedule
| Order | Channel | Post | Owner | Planned (UTC) | Status | Published URL |
| ----- | ------- | ---- | ----- | ------------- | ------ | ------------- |
| 1 | GitHub | Release notes | @maria | 2026-11-02T09:00Z | ${rowStatus} | ${rowStatus === 'published' ? 'https://github.com/feedbouncer/feedbouncer/releases/tag/v0.1.0' : '-'} |
Each owner signs their post and replies to comments and issues on that channel for the first 48 hours after it goes live.
## Readiness checklist
${CHECKLIST.map((t, i) => `- [${live && i !== untick ? 'x' : ' '}] ${t}`).join('\n')}
## Claims ledger
| Claim | Source |
| ----- | ------ |
| Licensed AGPL-3.0 | LICENSE |
${CHANNELS.map((c) => `## ${c}\n### Post\n\`\`\`text\nHello\n\`\`\``).join('\n')}
## Prepared answers
### Privacy
Answer.

Source: README.md
## Corrections
| Date (UTC) | Channel | What was wrong | Correction | Shown as | URL |
| ---------- | ------- | -------------- | ---------- | -------- | --- |
`;
  return drop ? text.replace(`${drop}\n`, '') : text;
};

test('parseLaunchDoc accepts the minimal fixture', () => {
  const parsed = parseLaunchDoc(fixture());
  assert.equal(parsed.status, 'draft');
  assert.equal(parsed.posts.length, CHANNELS.length);
  assert.equal(parsed.schedule[0].owner, '@maria');
});

test('parseLaunchDoc rejects a missing channel H2', () =>
  assert.throws(() => parseLaunchDoc(fixture({ drop: '## r/FacebookAds' })), /r\/FacebookAds/));

test('parseLaunchDoc rejects an unknown row status', () =>
  assert.throws(() => parseLaunchDoc(fixture({ rowStatus: 'live' })), /status/));

test('parseLaunchDoc rejects a malformed table row', () =>
  assert.throws(
    () => parseLaunchDoc(fixture().replace('| 1 | GitHub |', '| 1 | GitHub | extra |')),
    /cells/,
  ));

test('parseLaunchDoc ignores headings inside code fences', () => {
  const parsed = parseLaunchDoc(fixture().replace('Hello', '## not a heading\n### nor this'));
  assert.equal(parsed.h2.includes('not a heading'), false);
  assert.match(parsed.posts[0].copy, /nor this/);
});

test('launch doc has the H2s in order', () =>
  assert.deepEqual(doc.h2, [
    'Status and approval',
    'Owners and schedule',
    'Readiness checklist',
    'Claims ledger',
    ...CHANNELS,
    'Prepared answers',
    'Corrections',
  ]));

test('every channel has at least one post with copy', () => {
  for (const c of CHANNELS)
    assert.ok(
      doc.posts.some((p) => p.channel === c && p.copy.trim()),
      c,
    );
});

test('every published post has a schedule row and every row names a real post', () => {
  const key = (x) => `${x.channel}/${x.post ?? x.name}`;
  assert.deepEqual(doc.schedule.map(key).sort(), doc.posts.map(key).sort());
});

test('schedule orders are 1..n', () =>
  assert.deepEqual(
    doc.schedule.map((r) => r.order),
    doc.schedule.map((_, i) => i + 1),
  ));

test('48-hour reply commitment is stated', () =>
  assert.ok(
    section(md, 'Owners and schedule').includes(
      'Each owner signs their post and replies to comments and issues on that channel for the first 48 hours after it goes live.',
    ),
  ));

test('readiness checklist has the agreed boxes', () =>
  assert.deepEqual(
    doc.checklist.map((i) => i.text),
    CHECKLIST,
  ));

test('prepared answers cover the likely questions and cite sources that exist', () => {
  assert.deepEqual(
    doc.answers.map((a) => a.question),
    [
      'Privacy',
      'False positives',
      'Why open source',
      'How is this different from built-in platform moderation',
      'Is FeedBouncer affiliated with Meta or TikTok',
    ],
  );
  for (const a of doc.answers)
    for (const p of sourcesOf(a.body)) assert.ok(existsSync(join(ROOT, p.split('#')[0])), p);
});

test('claims ledger sources exist', () => {
  for (const c of doc.claims) assert.ok(existsSync(join(ROOT, c.source.split('#')[0])), c.source);
});

test('scheduled or published rows require approval, an owner and a fully ticked checklist', () =>
  assertGates(doc));

test('gate also fails on a fixture with a published row and an unticked box', () => {
  assert.doesNotThrow(() => assertGates(parseLaunchDoc(fixture({ rowStatus: 'published' }))));
  assert.throws(
    () => assertGates(parseLaunchDoc(fixture({ rowStatus: 'published', untick: 0 }))),
    /unticked/,
  );
});

test('gate fails when a live row is unassigned or the document is a draft', () => {
  const live = parseLaunchDoc(fixture({ rowStatus: 'scheduled' }));
  assert.throws(
    () => assertGates({ ...live, schedule: [{ ...live.schedule[0], owner: 'unassigned' }] }),
    /owner/,
  );
  assert.throws(() => assertGates({ ...live, status: 'draft' }), /approved/);
});

test('[[MAINTAINER]] only while draft', () => {
  if (doc.status !== 'draft') assert.ok(!md.includes('[[MAINTAINER]]'));
});

test('published and corrected rows have a URL on the channel host', () => {
  for (const r of doc.schedule.filter((x) => ['published', 'corrected'].includes(x.status))) {
    assert.ok(urlPatternFor(r)?.test(r.url), `${r.post}: ${r.url}`);
  }
});

test('url patterns accept real shapes and reject look-alikes', () => {
  const row = (channel, post, url) => ({ channel, post, url });
  const ok = (r) => urlPatternFor(r).test(r.url);
  assert.ok(
    ok(row('Hacker News (Show HN)', 'Show HN post', 'https://news.ycombinator.com/item?id=123')),
  );
  assert.ok(
    !ok(
      row(
        'Hacker News (Show HN)',
        'Show HN post',
        'https://news.ycombinator.com.evil.io/item?id=123',
      ),
    ),
  );
  assert.ok(ok(row('X and LinkedIn', 'X post', 'https://x.com/feedbouncer/status/1')));
  assert.ok(!ok(row('X and LinkedIn', 'LinkedIn post', 'https://x.com/feedbouncer/status/1')));
});

test('corrections rows are well formed', () => {
  for (const c of doc.corrections) {
    assert.match(c.dateUtc, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(CHANNELS.includes(c.channel), c.channel);
    assert.ok(['edited with visible note', 'reply'].includes(c.shown), c.shown);
  }
});

test('launch files contain no secrets, foreign emails or placeholders', () => {
  for (const f of readdirSync(LAUNCH_DIR).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(LAUNCH_DIR, f), 'utf8');
    assert.deepEqual(findSecretLike(text), [], f);
    assert.doesNotMatch(text, /\b(TODO|TBD|FIXME)\b/, f);
    for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])
      assert.match(email, /@feedbouncer\.com$/, f);
  }
});
