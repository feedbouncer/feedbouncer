import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const LAUNCH_DOC = 'docs/launch/launch-posts.md';
export const CHANNELS = [
  'GitHub',
  'Product Hunt',
  'Hacker News (Show HN)',
  'r/FacebookAds',
  'X and LinkedIn',
];
export const DOC_STATUSES = ['draft', 'approved'];
export const ROW_STATUSES = ['draft', 'scheduled', 'published', 'corrected'];
export const LIVE_STATUSES = ['scheduled', 'published', 'corrected'];

const FIXED_H2 = [
  'Status and approval',
  'Owners and schedule',
  'Readiness checklist',
  'Claims ledger',
];
export const REQUIRED_H2 = [...FIXED_H2, ...CHANNELS, 'Prepared answers', 'Corrections'];

const SCHEDULE_HEADER = [
  'Order',
  'Channel',
  'Post',
  'Owner',
  'Planned (UTC)',
  'Status',
  'Published URL',
];
const CLAIMS_HEADER = ['Claim', 'Source'];
const CORRECTIONS_HEADER = [
  'Date (UTC)',
  'Channel',
  'What was wrong',
  'Correction',
  'Shown as',
  'URL',
];
const OWNER = /^(@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|unassigned)$/;
const PLANNED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z|unscheduled)$/;

export const PUBLISHED_URL = {
  GitHub: /^https:\/\/github\.com\/feedbouncer\/feedbouncer\/releases\/tag\/v\d+\.\d+\.\d+$/,
  'Product Hunt': /^https:\/\/www\.producthunt\.com\/(posts|products)\/[a-z0-9-]+\/?$/,
  'Hacker News (Show HN)': /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/,
  'r/FacebookAds':
    /^https:\/\/(www|old)\.reddit\.com\/r\/FacebookAds\/comments\/[a-z0-9]+\/[\w-]*\/?$/,
  'X and LinkedIn': {
    X: /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/,
    LinkedIn:
      /^https:\/\/www\.linkedin\.com\/(posts\/[\w-]+|feed\/update\/urn:li:(activity|share):\d+)\/?$/,
  },
};

const splitBlocks = (md, level) => {
  const prefix = `${'#'.repeat(level)} `;
  const blocks = [];
  let fenced = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith(prefix))
      blocks.push({ heading: line.slice(prefix.length).trim(), lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks.map((b) => ({ heading: b.heading, body: b.lines.join('\n').trim() }));
};

export function section(md, heading) {
  return splitBlocks(md, 2).find((b) => b.heading === heading)?.body ?? '';
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

function table(body, header, where) {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith('|'));
  if (at < 0 || cells(lines[at]).join('|') !== header.join('|')) {
    throw new Error(`${where}: table header must be | ${header.join(' | ')} |`);
  }
  const rows = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith('|')) break;
    const row = cells(line);
    if (row.length !== header.length)
      throw new Error(`${where}: row "${line.trim()}" needs ${header.length} cells`);
    rows.push(row);
  }
  return rows;
}

function parseStatus(body) {
  const status = body.match(/^\*\*Status:\*\* (\S+)$/m)?.[1];
  if (!DOC_STATUSES.includes(status))
    throw new Error(`Status and approval: unknown status "${status}"`);
  const approval = body.match(/^\*\*Approved by:\*\* (.+)$/m)?.[1];
  if (approval === 'not yet') return { status, approvedBy: null, approvedOn: null };
  const m = approval?.match(/^(@[A-Za-z0-9-]+) on (\d{4}-\d{2}-\d{2})$/);
  if (!m) throw new Error(`Status and approval: malformed "Approved by" line "${approval}"`);
  return { status, approvedBy: m[1], approvedOn: m[2] };
}

function parseSchedule(body) {
  return table(body, SCHEDULE_HEADER, 'Owners and schedule').map(
    ([order, channel, post, owner, plannedUtc, status, url]) => {
      const where = `Owners and schedule row ${order}`;
      if (!/^\d+$/.test(order)) throw new Error(`${where}: order must be an integer`);
      if (!CHANNELS.includes(channel)) throw new Error(`${where}: unknown channel "${channel}"`);
      if (!OWNER.test(owner)) throw new Error(`${where}: owner must be @handle or unassigned`);
      if (!PLANNED.test(plannedUtc))
        throw new Error(`${where}: planned must be YYYY-MM-DDTHH:MMZ or unscheduled`);
      if (!ROW_STATUSES.includes(status)) throw new Error(`${where}: unknown status "${status}"`);
      if (url !== '-') {
        try {
          new URL(url);
        } catch {
          throw new Error(`${where}: URL must be a URL or -`);
        }
      }
      return { order: Number(order), channel, post, owner, plannedUtc, status, url };
    },
  );
}

function parseChecklist(body) {
  return body.split('\n').flatMap((line) => {
    const m = line.match(/^- \[([ x])\] (.+)$/);
    return m ? [{ text: m[2].trim(), done: m[1] === 'x' }] : [];
  });
}

function parsePosts(h2Blocks) {
  return CHANNELS.flatMap((channel) => {
    const block = h2Blocks.find((b) => b.heading === channel);
    return splitBlocks(block.body, 3).flatMap(({ heading, body }) => {
      const fences = [...body.matchAll(/```text\n([\s\S]*?)```/g)];
      if (!fences.length) return [];
      return [{ channel, name: heading, copy: fences.map((m) => m[1].trim()).join('\n\n') }];
    });
  });
}

export function parseLaunchDoc(md) {
  const h2Blocks = splitBlocks(md, 2);
  const h2 = h2Blocks.map((b) => b.heading);
  for (const heading of REQUIRED_H2)
    if (!h2.includes(heading)) throw new Error(`document: missing section "## ${heading}"`);
  const sections = Object.fromEntries(h2Blocks.map((b) => [b.heading, b.body]));
  return {
    h2,
    ...parseStatus(sections['Status and approval']),
    schedule: parseSchedule(sections['Owners and schedule']),
    checklist: parseChecklist(sections['Readiness checklist']),
    claims: table(sections['Claims ledger'], CLAIMS_HEADER, 'Claims ledger').map(
      ([claim, source]) => ({ claim, source }),
    ),
    posts: parsePosts(h2Blocks),
    answers: splitBlocks(sections['Prepared answers'], 3).map(({ heading, body }) => ({
      question: heading,
      body,
    })),
    corrections: table(sections.Corrections, CORRECTIONS_HEADER, 'Corrections').map(
      ([dateUtc, channel, wrong, fix, shown, url]) => ({
        dateUtc,
        channel,
        wrong,
        fix,
        shown,
        url,
      }),
    ),
    sections,
  };
}

export function sourcesOf(body) {
  const line = body.split('\n').findLast((l) => l.startsWith('Source: '));
  if (!line) throw new Error('prepared answer: missing "Source:" line');
  return line
    .slice('Source: '.length)
    .split(',')
    .map((s) => s.trim());
}

export function urlPatternFor(row) {
  const pattern = PUBLISHED_URL[row.channel];
  if (pattern instanceof RegExp) return pattern;
  return Object.entries(pattern).find(([key]) => row.post.startsWith(key))?.[1];
}

export function assertGates(doc) {
  const live = doc.schedule.filter((r) => LIVE_STATUSES.includes(r.status));
  if (!live.length) return;
  if (doc.status !== 'approved')
    throw new Error('gate: a post is scheduled or published but the document is not approved');
  if (!doc.approvedBy?.startsWith('@')) throw new Error('gate: approval needs an @handle');
  const open = doc.checklist.filter((i) => !i.done).map((i) => i.text);
  if (open.length) throw new Error(`gate: unticked checklist items: ${open.join('; ')}`);
  for (const r of live) {
    if (r.owner === 'unassigned') throw new Error(`gate: "${r.post}" has no owner`);
    if (r.plannedUtc === 'unscheduled') throw new Error(`gate: "${r.post}" has no planned time`);
  }
}

// ---- Channel copy guards ----

export const LIMITS = {
  productHuntTagline: 60,
  hnTitle: 80,
  xPost: 280,
  linkedIn: 3000,
  githubDescription: 350,
};
export const ALLOWED_LINK_ORIGINS = [
  'https://github.com/feedbouncer/feedbouncer',
  'https://feedbouncer.github.io/feedbouncer/',
];
const REPO = ALLOWED_LINK_ORIGINS[0];
const DOCS = ALLOWED_LINK_ORIGINS[1];
const NOT_COPY = ['Title', 'URL', 'Name and tagline', 'Repository description'];
const PLATFORM_NAMES = /\b(Meta|Facebook|Instagram|TikTok|YouTube|Google)\b/i;
const DISCLAIMER = /not affiliated with or endorsed by/i;

/** Posts whose copy reads as prose (not a title, URL, name or one-line description). */
export const publishable = (doc) => doc.posts.filter((p) => !NOT_COPY.includes(p.name));

export const paragraphs = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

export const sentences = (text) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** X thread posts are separated by a line holding only `---`. */
export const xPosts = (text) =>
  text
    .split(/^---$/m)
    .map((t) => t.trim())
    .filter(Boolean);

const URL_RE = /https?:\/\/\S+/g;

/** Length as X counts it: every URL is 23 characters, everything else by code point. */
export const xLength = (text) =>
  (text.match(URL_RE) ?? []).length * 23 + [...text.replace(URL_RE, '')].length;

export const linksIn = (text) =>
  (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?)\]'"]+$/, ''));

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const shingles = (text) => {
  const words = normalize(text).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '));
  return set;
};

/** Jaccard similarity of the word 5-gram sets of two texts. */
export function jaccard5(a, b) {
  const sa = shingles(a);
  const sb = shingles(b);
  const union = new Set([...sa, ...sb]).size;
  if (!union) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / union;
}

let routes;
const docsRoutes = () =>
  (routes ??= new Set(JSON.parse(readFileSync(join(ROOT, 'apps/docs/routes.lock.json'), 'utf8'))));

export function resolveCopyLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, why: 'not https' };
  if (/(waitlist|signup|sign-up|register)\b/i.test(u.pathname))
    return { ok: false, why: 'waitlist or sign-up path' };
  if (u.search) return { ok: false, why: 'query strings are not allowed' };
  const href = `${u.origin}${u.pathname}`;
  if (href === REPO || href === `${REPO}/`) {
    return u.hash ? { ok: false, why: 'fragment on a non-anchor link' } : { ok: true };
  }
  if (href.startsWith(`${REPO}/`)) {
    const rest = href.slice(REPO.length);
    const file = /^\/(?:blob|tree)\/main\/(.+?)\/?$/.exec(rest)?.[1];
    if (file) {
      return existsSync(join(ROOT, decodeURIComponent(file)))
        ? { ok: true }
        : { ok: false, why: `no file ${file} in the repo` };
    }
    if (u.hash) return { ok: false, why: 'fragment on a non-anchor link' };
    if (/^\/(releases\/tag\/v\d+\.\d+\.\d+|issues|discussions)\/?$/.test(rest)) return { ok: true };
    return { ok: false, why: `unknown repo path ${rest}` };
  }
  if (href.startsWith(DOCS)) {
    const route = u.pathname.slice('/feedbouncer'.length);
    return docsRoutes().has(route)
      ? { ok: true }
      : { ok: false, why: `${route} is not in apps/docs/routes.lock.json` };
  }
  return { ok: false, why: 'origin not allowed' };
}

/** Supported and planned platform names from the concepts overview. */
export function parsePlatformSupport(md) {
  const list = (phrase) =>
    (new RegExp(`([^.>\\n]+?) are ${phrase}\\.`).exec(md)?.[1] ?? '')
      .split(/,|\band\b/)
      .map((s) => s.trim())
      .filter(Boolean);
  return { supported: list('supported'), planned: list('planned') };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The X and LinkedIn posts may name their own platform without claiming support. */
export const isChannelSelfReference = (p, name) =>
  p.channel === 'X and LinkedIn' && ['X', 'LinkedIn'].includes(name);

const fail = (p, msg) => {
  throw new Error(`${p.channel}/${p.name}: ${msg}`);
};

export function assertProblemFirst(doc) {
  for (const p of publishable(doc)) {
    const first = paragraphs(p.copy)[0] ?? '';
    if (/^FeedBouncer is\b/.test(first)) fail(p, 'opens with the product, not the problem');
    if (!/\b(spam|scams?|abuse|unwanted comments|bot comments)\b/i.test(first))
      fail(p, 'first paragraph does not describe the problem');
  }
}

const PLATFORM_QUALIFIER = /\b(planned|not (yet )?(available|supported)|not yet|roadmap)\b/i;

/** Clauses of a sentence: a qualifier only counts in the clause that names the platform. */
const clauses = (sentence) =>
  sentence
    .split(/[;,:\u2013\u2014]|\s-\s|\bbut\b/)
    .map((c) => c.trim())
    .filter(Boolean);

export function assertPlatformClaims(doc, support) {
  for (const p of doc.posts)
    for (const s of sentences(p.copy))
      for (const c of clauses(s))
        for (const name of support.planned)
          if (
            new RegExp(`\\b${esc(name)}\\b`).test(c) &&
            !isChannelSelfReference(p, name) &&
            !PLATFORM_QUALIFIER.test(c)
          )
            fail(p, `names ${name}, which is planned, without saying so: "${s}"`);
}

export function assertNoFigures(doc) {
  for (const p of doc.posts)
    if (/\d\s?%|\b(accuracy|precision|recall)\b[^.]*\d|#1\b|\bbest\b/i.test(p.copy))
      fail(p, 'contains an accuracy figure, a percentage, "#1" or "best"');
}

const OTHER_AI = /\b(Anthropic|Claude|Mistral|Cohere|Llama|Grok|Gemma|DeepSeek|Bedrock|Azure)\b/;

export function assertAiVendors(doc) {
  for (const p of doc.posts) {
    const other = OTHER_AI.exec(p.copy);
    if (other) fail(p, `names ${other[1]}, which is not a configured AI vendor`);
    if (/\b(OpenAI|Gemini)\b/.test(p.copy) && !/\boptional\b/i.test(p.copy))
      fail(p, 'names an AI vendor without saying the AI is optional');
  }
}

export function assertDisclaimer(doc) {
  for (const p of doc.posts)
    if (p.name !== 'Title' && PLATFORM_NAMES.test(p.copy) && !DISCLAIMER.test(p.copy))
      fail(p, 'names a platform but lacks "not affiliated with or endorsed by"');
}

export function assertNoVoteAsks(doc) {
  for (const p of doc.posts)
    if (
      /\b(up-?votes?|vote for|please vote|give us (a|your) vote|support us on|please share|boost|hunt us)\b/i.test(
        p.copy,
      )
    )
      fail(p, 'asks for votes or shares');
}

export function assertLinks(doc) {
  for (const p of doc.posts)
    for (const u of linksIn(p.copy)) {
      const r = resolveCopyLink(u);
      if (!r.ok) fail(p, `${u}: ${r.why}`);
    }
}

export function assertPlainText(doc) {
  for (const p of doc.posts)
    if (/<[a-z!/]|!\[/i.test(p.copy)) fail(p, 'copy must be plain text (no HTML or images)');
}

/** No normalized paragraph of 40+ characters in two channels; word 5-gram Jaccard < 0.25. */
export function assertDistinct(doc) {
  const channels = [...new Set(doc.posts.map((p) => p.channel))];
  const text = Object.fromEntries(
    channels.map((c) => [
      c,
      doc.posts
        .filter((p) => p.channel === c)
        .map((p) => p.copy)
        .join('\n\n'),
    ]),
  );
  const seen = new Map();
  for (const c of channels)
    for (const para of new Set(paragraphs(text[c]).map(normalize))) {
      if (para.length < 40) continue;
      if (seen.has(para) && seen.get(para) !== c)
        throw new Error(`distinct: paragraph shared by ${seen.get(para)} and ${c}: "${para}"`);
      seen.set(para, c);
    }
  for (const [i, a] of channels.entries())
    for (const b of channels.slice(i + 1)) {
      const j = jaccard5(text[a], text[b]);
      if (j >= 0.25) throw new Error(`distinct: jaccard5(${a}, ${b}) = ${j.toFixed(2)} >= 0.25`);
    }
}

/** The truthfulness guards that apply to any published text, including the release notes. */
export function assertClaims(doc, support) {
  assertPlatformClaims(doc, support);
  assertNoFigures(doc);
  assertAiVendors(doc);
  assertDisclaimer(doc);
  assertNoVoteAsks(doc);
  assertLinks(doc);
  assertPlainText(doc);
}
