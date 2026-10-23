// Keeps the launch document honest: structure, publishing gates, prepared-answer sources
// and a scan of docs/launch/ for secrets, foreign emails and placeholders.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_LINK_ORIGINS,
  assertAiVendors,
  assertClaims,
  assertDisclaimer,
  assertDistinct,
  assertGates,
  assertLinks,
  assertNoFigures,
  assertNoVoteAsks,
  assertPlainText,
  assertPlatformClaims,
  assertProblemFirst,
  CHANNELS,
  jaccard5,
  LAUNCH_DOC,
  LIMITS,
  linksIn,
  paragraphs,
  parseLaunchDoc,
  parsePlatformSupport,
  publishable,
  resolveCopyLink,
  section,
  sourcesOf,
  urlPatternFor,
  xLength,
  xPosts,
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

// ---- Channel copy: claims, links, limits and distinctness ----

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const post = (key) => {
  const found = doc.posts.find((p) => `${p.channel}/${p.name}` === key);
  assert.ok(found, `no post "${key}"`);
  return found;
};
const subsection = (h2, h3) =>
  section(md, h2)
    .split(/^### /m)
    .find((b) => b.startsWith(`${h3}\n`)) ?? '';
const PLATFORM_SUPPORT = parsePlatformSupport(read('apps/docs/docs/concepts/overview.md'));
const AI_PROVIDERS = [
  ...(/AI_PROVIDERS = \[([^\]]*)\]/.exec(read('packages/ai/src/config.ts'))?.[1] ?? '').matchAll(
    /'([a-z_]+)'/g,
  ),
].map((m) => m[1]);
const AI_NAMES = {
  openai: 'OpenAI',
  google: 'Google|Gemini',
  openai_compatible: 'OpenAI-compatible',
};

test('an H3 without a text fence is not a post', () => {
  const parsed = parseLaunchDoc(
    fixture().replace('## GitHub\n', '## GitHub\n### Notes only\nChecked on: 2026-01-01\n'),
  );
  assert.equal(
    parsed.posts.some((p) => p.name === 'Notes only'),
    false,
  );
});

test('platform support is read from the concepts overview', () => {
  assert.ok(PLATFORM_SUPPORT.supported.includes('Instagram'), PLATFORM_SUPPORT.supported.join());
  for (const name of ['TikTok', 'YouTube', 'X', 'LinkedIn'])
    assert.ok(PLATFORM_SUPPORT.planned.includes(name), name);
  for (const name of PLATFORM_SUPPORT.planned)
    assert.ok(!PLATFORM_SUPPORT.supported.includes(name), name);
});

test('the AI vendor names cover exactly the configured providers', () =>
  assert.deepEqual(Object.keys(AI_NAMES).sort(), [...AI_PROVIDERS].sort()));

test('channel posts are the agreed ones', () =>
  assert.deepEqual(
    doc.posts.map((p) => `${p.channel}/${p.name}`),
    [
      'GitHub/Release notes',
      'GitHub/Repository description',
      'Product Hunt/Name and tagline',
      'Product Hunt/Description',
      "Product Hunt/Maker's first comment",
      'Hacker News (Show HN)/Title',
      'Hacker News (Show HN)/URL',
      'Hacker News (Show HN)/First comment',
      'r/FacebookAds/Primary post',
      'r/FacebookAds/Fallback post (discussion, no links)',
      'X and LinkedIn/X thread',
      'X and LinkedIn/LinkedIn post',
    ],
  ));

test('first paragraph of every post leads with the problem', () => {
  for (const p of publishable(doc)) {
    const first = paragraphs(p.copy)[0];
    assert.match(first, /\b(spam|scams?|abuse|unwanted comments|bot comments)\b/i, p.name);
    assert.doesNotMatch(first, /^FeedBouncer is\b/, p.name);
  }
  assert.doesNotThrow(() => assertProblemFirst(doc));
});

test('no copy calls a planned platform supported', () =>
  assertPlatformClaims(doc, PLATFORM_SUPPORT));

test('no copy contains accuracy figures or percentages', () => assertNoFigures(doc));

test('AI vendors named in copy are configured providers and the AI is optional', () =>
  assertAiVendors(doc));

test(
  'copy states the README maturity label',
  { todo: 'passes once README status is rewritten (task 3)' },
  () => {
    const label = /## Project status\n\n\*\*([A-Za-z-]+)\./.exec(read('README.md'))[1];
    for (const n of [
      'Hacker News (Show HN)/First comment',
      'GitHub/Release notes',
      "Product Hunt/Maker's first comment",
    ])
      assert.match(post(n).copy, new RegExp(`\\b${label}\\b`, 'i'), n);
  },
);

test('every post naming a platform carries the non-affiliation statement', () =>
  assertDisclaimer(doc));

test('no copy solicits votes', () => assertNoVoteAsks(doc));

test('every copy link is on an allowed origin and resolves', () => {
  assertLinks(doc);
  assert.equal(resolveCopyLink('https://feedbouncer.github.io/feedbouncer/waitlist/').ok, false);
  assert.equal(
    resolveCopyLink('https://github.com/feedbouncer/feedbouncer/blob/main/no/such.md').ok,
    false,
  );
});

test('resolveCopyLink accepts real targets and rejects look-alikes', () => {
  const ok = (u) => resolveCopyLink(u).ok;
  for (const u of [
    'https://github.com/feedbouncer/feedbouncer',
    'https://github.com/feedbouncer/feedbouncer/blob/main/CONTRIBUTING.md',
    'https://github.com/feedbouncer/feedbouncer/tree/main/docs/self-hosting',
    'https://github.com/feedbouncer/feedbouncer/releases/tag/v0.1.0',
    'https://github.com/feedbouncer/feedbouncer/issues',
    'https://feedbouncer.github.io/feedbouncer/docs/concepts/overview/',
  ])
    assert.ok(ok(u), u);
  for (const u of [
    'http://github.com/feedbouncer/feedbouncer',
    'https://github.com/feedbouncer/feedbouncer-evil',
    'https://github.com/feedbouncer/feedbouncer?utm_source=hn',
    'https://github.com/feedbouncer/feedbouncer/blob/main/README.md?plain=1',
    'https://github.com/feedbouncer/feedbouncer/blob/dev/README.md',
    'https://github.com/feedbouncer/feedbouncer/pulls',
    'https://feedbouncer.github.io/feedbouncer/docs/no-such-page/',
    'https://feedbouncer.github.io/feedbouncer/docs/concepts/overview/?ref=x',
    'https://feedbouncer.github.io/feedbouncer/signup',
    'https://example.com/',
  ])
    assert.equal(ok(u), false, u);
  assert.deepEqual(ALLOWED_LINK_ORIGINS, [
    'https://github.com/feedbouncer/feedbouncer',
    'https://feedbouncer.github.io/feedbouncer/',
  ]);
});

test('Show HN URL is the repo or docs site', () =>
  assert.equal(
    post('Hacker News (Show HN)/URL').copy.trim(),
    'https://github.com/feedbouncer/feedbouncer',
  ));

test('Show HN title is plain and fits', () => {
  const t = post('Hacker News (Show HN)/Title').copy.trim();
  assert.match(t, /^Show HN: FeedBouncer – [^!]{10,}$/);
  assert.ok([...t].length <= LIMITS.hnTitle);
});

test('xLength counts each URL as 23 characters', () => {
  assert.equal(xLength('abc'), 3);
  assert.equal(xLength('see https://github.com/feedbouncer/feedbouncer/blob/main/README.md'), 27);
  assert.equal(xLength('é👍'), 2);
});

test('channel length limits hold', () => {
  const tagline = post('Product Hunt/Name and tagline').copy.split('\n')[1] ?? '';
  assert.ok(tagline.trim(), 'tagline is the second line');
  assert.ok([...tagline].length <= LIMITS.productHuntTagline, tagline);
  const tweets = xPosts(post('X and LinkedIn/X thread').copy);
  assert.ok(tweets.length >= 2, 'X thread has several posts');
  for (const t of tweets) assert.ok(xLength(t) <= LIMITS.xPost, `${xLength(t)}: ${t}`);
  assert.ok([...post('X and LinkedIn/LinkedIn post').copy].length <= LIMITS.linkedIn);
  assert.ok([...post('GitHub/Repository description').copy].length <= LIMITS.githubDescription);
});

test('the last X post carries the disclaimer and the thread has one link', () => {
  const tweets = xPosts(post('X and LinkedIn/X thread').copy);
  assert.match(tweets.at(-1), /not affiliated with or endorsed by/i);
  assert.equal(linksIn(tweets.join('\n')).length, 1);
  assert.equal(linksIn(post('X and LinkedIn/LinkedIn post').copy).length, 1);
});

test('fallback Reddit post has no links and no product name in its title', () => {
  const copy = post('r/FacebookAds/Fallback post (discussion, no links)').copy;
  assert.deepEqual(linksIn(copy), []);
  assert.doesNotMatch(copy, /\bwww\.|\.(com|io|org|dev)\b/i);
  assert.doesNotMatch(copy.split('\n')[0], /FeedBouncer/i);
});

test('Reddit rules check is recorded and gates the Reddit posts', () => {
  const rules = subsection('r/FacebookAds', 'Rules check');
  assert.match(rules, /https:\/\/www\.reddit\.com\/r\/FacebookAds\/about\/rules\//);
  const checked = /^Checked on: (\d{4}-\d{2}-\d{2}|not yet)$/m.exec(rules)?.[1];
  assert.ok(checked, 'Checked on: YYYY-MM-DD (or "not yet" while every Reddit row is a draft)');
  const contact =
    /^Moderator contact: (not yet|not needed|asked on \d{4}-\d{2}-\d{2}|approved|declined)$/m.exec(
      rules,
    )?.[1];
  assert.ok(contact, 'Moderator contact: not needed|asked on YYYY-MM-DD|approved|declined');
  const live = doc.schedule.filter((r) => r.channel === 'r/FacebookAds' && r.status !== 'draft');
  if (live.length) {
    assert.match(checked, /^\d{4}-\d{2}-\d{2}$/, 'rules must be checked before posting');
    assert.notEqual(contact, 'not yet', 'moderator contact must be settled before posting');
  }
});

test('copy that mentions the release links to the release notes', () => {
  assert.ok(
    linksIn(post('GitHub/Release notes').copy).some((u) =>
      /\/releases\/tag\/v0\.1\.0$|\/docs\/launch\/release-notes-v0\.1\.0\.md$/.test(u),
    ),
  );
});

test('channels are not copies of each other', () => assertDistinct(doc));

test('copy is plain text', () => assertPlainText(doc));

test('posts are signed by the maintainer placeholder while draft', () => {
  if (doc.status !== 'draft') return;
  for (const p of publishable(doc)) assert.ok(p.copy.includes('[[MAINTAINER]]'), p.name);
});

test('copy never credits a tool as its author', () => {
  for (const p of doc.posts)
    assert.doesNotMatch(p.copy, /\b(ChatGPT|Copilot|Claude|written by AI|AI-generated)\b/i, p.name);
});

describe('guards bite', () => {
  const base = () => ({
    posts: [
      {
        channel: 'GitHub',
        name: 'Release notes',
        copy: 'Scam comments under ads cost time.\n\nFacebook Pages work. Optional AI with OpenAI. Not affiliated with or endorsed by Meta.\nhttps://github.com/feedbouncer/feedbouncer',
      },
      {
        channel: 'Product Hunt',
        name: 'Description',
        copy: 'Spam replies pile up on paid posts.\n\nSelf-host it from the repository.',
      },
    ],
  });
  const withCopy = (copy, i = 0) => {
    const d = base();
    d.posts[i] = { ...d.posts[i], copy: `${d.posts[i].copy}\n\n${copy}` };
    return d;
  };

  test('the baseline fixture passes every guard', () => {
    const d = base();
    for (const g of [
      assertProblemFirst,
      assertNoFigures,
      assertAiVendors,
      assertDisclaimer,
      assertNoVoteAsks,
      assertLinks,
      assertDistinct,
      assertPlainText,
    ])
      assert.doesNotThrow(() => g(d), g.name);
    assert.doesNotThrow(() => assertPlatformClaims(d, PLATFORM_SUPPORT));
    assert.doesNotThrow(() => assertClaims(d, PLATFORM_SUPPORT));
  });
  test('a 98% claim', () =>
    assert.throws(() => assertNoFigures(withCopy('It catches 98% of scams.')), /figure/));
  test('an accuracy claim without a percent sign', () =>
    assert.throws(() => assertNoFigures(withCopy('Accuracy is 0.97 on our set.')), /figure/));
  test('"now on TikTok"', () =>
    assert.throws(
      () => assertPlatformClaims(withCopy('FeedBouncer is now on TikTok.'), PLATFORM_SUPPORT),
      /TikTok/,
    ));
  test('X and LinkedIn may name themselves, other channels may not', () => {
    const d = {
      posts: [
        {
          channel: 'X and LinkedIn',
          name: 'LinkedIn post',
          copy: 'Spam on ads. Posting this on LinkedIn.',
        },
      ],
    };
    assert.doesNotThrow(() => assertPlatformClaims(d, PLATFORM_SUPPORT));
    assert.throws(
      () => assertPlatformClaims(withCopy('Works on LinkedIn.'), PLATFORM_SUPPORT),
      /LinkedIn/,
    );
  });
  test('a missing disclaimer', () =>
    assert.throws(() => assertDisclaimer(withCopy('Works with Instagram.', 1)), /affiliated/));
  test('"please upvote"', () =>
    assert.throws(() => assertNoVoteAsks(withCopy('Please upvote!')), /vote/));
  test('a waitlist link', () =>
    assert.throws(
      () => assertLinks(withCopy('https://feedbouncer.github.io/feedbouncer/waitlist/')),
      /waitlist/,
    ));
  test('a duplicate paragraph across channels', () => {
    const shared = 'Rules run first, then the optional classifier looks at what is left over.';
    const d = withCopy(shared);
    d.posts[1].copy += `\n\n${shared}`;
    assert.throws(() => assertDistinct(d), /paragraph/);
  });
  test('near-copies across channels', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const d = withCopy(`${long} alpha`);
    d.posts[1].copy += `\n\n${long} beta`;
    assert.throws(() => assertDistinct(d), /jaccard/i);
  });
  test('an unconfigured AI vendor', () =>
    assert.throws(() => assertAiVendors(withCopy('Powered by Claude.')), /vendor/));
  test('AI presented as required', () =>
    assert.throws(
      () =>
        assertAiVendors({ posts: [{ channel: 'GitHub', name: 'x', copy: 'Spam. Uses OpenAI.' }] }),
      /optional/,
    ));
  test('a problem paragraph that opens with the product', () =>
    assert.throws(
      () =>
        assertProblemFirst({
          posts: [
            { channel: 'GitHub', name: 'Release notes', copy: 'FeedBouncer is a spam filter.' },
          ],
        }),
      /problem/,
    ));
  test('HTML or an image in copy', () =>
    assert.throws(() => assertPlainText(withCopy('![demo](x.gif)')), /plain/));
  test('jaccard5 is 1 for equal text and 0 for unrelated text', () => {
    assert.equal(jaccard5('a b c d e f', 'a b c d e f'), 1);
    assert.equal(jaccard5('a b c d e f', 'g h i j k l'), 0);
  });
});
