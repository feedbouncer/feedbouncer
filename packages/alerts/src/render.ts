import type { Platform } from '@feedbouncer/connectors';
import { escapeHtml, headerSafe, type OutboundEmail } from '@feedbouncer/mailer';
import { slackEscape } from './excerpt.js';
import { settingsLink, unsubscribeApiUrl, unsubscribeLink } from './links.js';
import type { AlertView } from './view.js';

export interface SlackPayload {
  text: string;
  blocks: unknown[];
  unfurl_links: false;
  unfurl_media: false;
}
export type EmailContent = Omit<OutboundEmail, 'to'>;

const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
  meta_ads: 'Meta ads',
};

const TEST_MESSAGE = 'FeedBouncer test alert: this channel is connected.';

/** One line of user-supplied text: no control characters that could break a line or a header. */
const line = (s: string) => headerSafe(s, 500);

// Intl rejects dateStyle/timeStyle combined with timeZoneName, so the zone is appended separately.
function formatTime(d: Date, timeZone: string): string {
  const main = new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  return zone ? `${main} ${zone}` : main;
}

interface Content {
  title: string;
  lines: string[];
  excerpts: string[];
  action: { label: string; url: string };
}

function content(v: AlertView): Content {
  const c = v.counts;
  if (v.type === 'cap_reached' || !v.brand || !v.window) {
    const until = formatTime(new Date(c.resumesAt ?? 0), 'UTC');
    return {
      title: 'Alert limit reached for this workspace',
      lines: [
        `More than ${c.cap} alerts were triggered in the last hour. Further alerts are paused until ${until}. Open FeedBouncer to review.`,
      ],
      excerpts: [],
      action: { label: 'Open FeedBouncer', url: v.link },
    };
  }
  const brand = line(v.brand.name);
  const from = formatTime(v.window.from, v.brand.timezone);
  const to = formatTime(v.window.to, v.brand.timezone);
  const lines: string[] = [];
  if (v.accounts.length > 0) {
    const names = v.accounts.map((a) => `${line(a.name)} (${PLATFORM_LABELS[a.platform]})`);
    if (v.moreAccounts > 0) names.push(`+${v.moreAccounts} more`);
    lines.push(`Accounts: ${names.join(', ')}`);
  }
  if (v.type === 'flagged_digest') {
    const n = v.liveItemCount ?? c.count ?? 0;
    lines.push(`Flagged between ${from} and ${to}.`);
    return {
      title: `${n} flagged ${n === 1 ? 'comment' : 'comments'} on ${brand}`,
      lines,
      excerpts: v.excerpts,
      action: { label: 'Open review queue', url: v.link },
    };
  }
  const negatives = c.negatives ?? 0;
  const total = c.total ?? 0;
  const share = total > 0 ? Math.round((negatives / total) * 100) : 0;
  const rate = c.expectedPerHour ?? 0;
  const expected = rate < 10 ? rate.toFixed(1) : String(Math.round(rate));
  let counts = `${negatives} negative of ${total} comments between ${from} and ${to} (${share}%). Usual level: ${expected} per hour.`;
  if (v.type === 'spike_escalation' && c.triggerCount !== undefined) {
    counts += ` Up from ${c.triggerCount} when the alert started.`;
  }
  lines.push(counts);
  lines.push(
    'The link lists only comments still visible; hidden or removed ones are counted but not shown.',
  );
  return {
    title:
      v.type === 'spike_escalation'
        ? `Still escalating: negative comments on ${brand}`
        : `Negative comment spike on ${brand}`,
    lines,
    excerpts: v.excerpts,
    action: { label: 'View comments', url: v.link },
  };
}

const mrkdwn = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

function slackPayload(text: string, blocks: unknown[]): SlackPayload {
  return { text, blocks, unfurl_links: false, unfurl_media: false };
}

export function renderSlack(v: AlertView): SlackPayload {
  const c = content(v);
  const title = slackEscape(c.title);
  return slackPayload(title, [
    mrkdwn(`*${title}*`),
    ...c.lines.map((l) => mrkdwn(slackEscape(l))),
    ...(c.excerpts.length > 0
      ? [mrkdwn(c.excerpts.map((x) => `> ${slackEscape(x)}`).join('\n'))]
      : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: c.action.label }, url: c.action.url },
      ],
    },
  ]);
}

export function renderSlackTest(): SlackPayload {
  return slackPayload(TEST_MESSAGE, [mrkdwn(TEST_MESSAGE)]);
}

const anchor = (label: string, url: string) =>
  `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
const para = (s: string) => `<p>${escapeHtml(s)}</p>`;
const html = (title: string, body: string[]) =>
  `<!doctype html><html><body><h1>${escapeHtml(title)}</h1>${body.join('')}</body></html>`;

interface Footer {
  email: string;
  workspaceName: string;
  unsubscribeToken: string;
  web: URL;
  manageUrl: string;
}

function withFooter(subject: string, text: string[], body: string[], f: Footer): EmailContent {
  const unsub = unsubscribeLink(f.web, f.unsubscribeToken);
  const why = `You're receiving this because ${line(f.email)} was added to FeedBouncer alerts for ${line(f.workspaceName)}.`;
  return {
    subject: headerSafe(subject),
    text: [...text, '', `${why} Unsubscribe: ${unsub} · Manage alerts: ${f.manageUrl}`, ''].join(
      '\n',
    ),
    html: html(subject, [
      ...body,
      `<hr><p>${escapeHtml(why)} Unsubscribe: ${anchor(unsub, unsub)} · Manage alerts: ${anchor(f.manageUrl, f.manageUrl)}</p>`,
    ]),
    headers: {
      'List-Unsubscribe': `<${unsubscribeApiUrl(f.web, f.unsubscribeToken)}>, <${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export function renderEmail(
  v: AlertView,
  r: { email: string; unsubscribeToken: string; web: URL },
): EmailContent {
  const c = content(v);
  const quotes = c.excerpts.map((x) => `<blockquote>${escapeHtml(x)}</blockquote>`);
  return withFooter(
    c.title,
    [
      c.title,
      '',
      ...c.lines,
      ...(c.excerpts.length > 0 ? ['', ...c.excerpts.map((x) => `> ${x}`)] : []),
      '',
      `${c.action.label}: ${c.action.url}`,
    ],
    [...c.lines.map(para), ...quotes, `<p>${anchor(c.action.label, c.action.url)}</p>`],
    {
      ...r,
      workspaceName: v.workspaceName,
      manageUrl: settingsLink(r.web, v.organizationId, v.brand?.id),
    },
  );
}

export function renderEmailTest(r: {
  email: string;
  workspaceName: string;
  unsubscribeToken: string;
  web: URL;
  orgId: string;
}): EmailContent {
  return withFooter('FeedBouncer test alert', [TEST_MESSAGE], [para(TEST_MESSAGE)], {
    ...r,
    manageUrl: settingsLink(r.web, r.orgId),
  });
}

function simple(
  subject: string,
  intro: string,
  cta: { label: string; url: string },
  text: string = `${intro}\n`,
): EmailContent {
  return {
    subject: headerSafe(subject),
    text,
    html: html(subject, [para(intro), `<p>${anchor(cta.label, cta.url)}</p>`]),
  };
}

export function renderConfirmEmail(i: {
  email: string;
  workspaceName: string;
  link: string;
}): EmailContent {
  const ws = line(i.workspaceName);
  const head = `A workspace admin added ${line(i.email)} to FeedBouncer alerts for ${ws}.`;
  const tail = `The link expires in 7 days. If you didn't expect this, ignore this email.`;
  // The link sits on its own line: a trailing full stop could be auto-linked into the token.
  return simple(
    `Confirm FeedBouncer alerts for ${ws}`,
    `${head} Confirm to start receiving them. ${tail}`,
    { label: 'Confirm alerts', url: i.link },
    `${head} Confirm to start receiving them:\n\n${i.link}\n\n${tail}\n`,
  );
}

export function renderDisconnectEmail(i: {
  workspaceName: string;
  label: string;
  code: string;
  link: string;
}): EmailContent {
  return simple(
    `Slack alerts disconnected for ${line(i.workspaceName)}`,
    `Slack rejected alerts for "${line(i.label)}" (${line(i.code)}). Alerts to this channel are stopped. Reconnect it: ${i.link}`,
    { label: 'Reconnect Slack', url: i.link },
  );
}
