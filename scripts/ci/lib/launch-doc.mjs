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
    return splitBlocks(block.body, 3).map(({ heading, body }) => ({
      channel,
      name: heading,
      copy: [...body.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1].trim()).join('\n\n'),
    }));
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
