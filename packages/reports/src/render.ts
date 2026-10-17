import { UUID_RE, type EmailContent } from '@feedbouncer/alerts';
import { escapeHtml, headerSafe } from '@feedbouncer/mailer';
import { TOP_ADS_MIN_COMMENTS } from './constants.js';
import { dashboardLink, settingsLink, unsubscribeApiLink, unsubscribePageLink } from './links.js';
import type { ReportView } from './view.js';

interface Section {
  heading: string;
  text: string[];
  html: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TOP_ADS_HEADING = 'Ads with the highest share of hidden comments';
const TOP_ADS_COLUMNS = ['Ad', 'Platform', 'Hidden', 'Comments', 'Hidden share'];
const TOP_ADS_EXPLAINER = `Hidden share = hidden comments ÷ all comments on the ad this week. Ads with fewer than ${TOP_ADS_MIN_COMMENTS} comments are not ranked.`;
const NONE_QUALIFY = `No ad had at least ${TOP_ADS_MIN_COMMENTS} comments with hidden ones this week, so there is no ranking.`;

const para = (s: string, style = '') => `<p style="margin:0 0 8px;${style}">${escapeHtml(s)}</p>`;
const muted = (s: string) => para(s, 'color:#555555;font-size:13px;');
const anchor = (url: string) =>
  `<a href="${escapeHtml(url)}" style="color:#1a56db;">${escapeHtml(url)}</a>`;
const cell = (tag: 'th' | 'td', s: string, align: 'left' | 'right') =>
  `<${tag} style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:${align};">${escapeHtml(s)}</${tag}>`;

function sections(v: ReportView): Section[] {
  const out: Section[] = [
    {
      heading: 'Comments processed',
      text: [v.processedLine, v.changeLine],
      html: para(v.processedLine, 'font-size:18px;font-weight:600;') + muted(v.changeLine),
    },
  ];
  if (v.categories) {
    const rows = v.categories.map((c) => `${c.label} — ${c.count} (${c.share})`);
    const total = `Total hidden: ${v.totalHidden}`;
    out.push({
      heading: 'Hidden by category',
      text: [...rows, total],
      html: rows.map((r) => para(r)).join('') + para(total, 'font-weight:600;'),
    });
  }
  if (v.topAds === 'none_qualify') {
    out.push({ heading: TOP_ADS_HEADING, text: [NONE_QUALIFY], html: para(NONE_QUALIFY) });
  } else if (v.topAds) {
    const ads = v.topAds.map((a) => ({ ...a, ad: a.archived ? `${a.ad} (archived)` : a.ad }));
    const head = TOP_ADS_COLUMNS.map((c, i) => cell('th', c, i < 2 ? 'left' : 'right')).join('');
    const body = ads
      .map(
        (a) =>
          `<tr>${cell('td', a.ad, 'left')}${cell('td', a.platform, 'left')}${cell('td', a.hidden, 'right')}${cell('td', a.total, 'right')}${cell('td', a.share, 'right')}</tr>`,
      )
      .join('');
    out.push({
      heading: TOP_ADS_HEADING,
      text: [
        ...ads.map(
          (a) => `- ${a.ad} — ${a.platform}: ${a.hidden} hidden of ${a.total} comments, ${a.share}`,
        ),
        '',
        TOP_ADS_EXPLAINER,
      ],
      html:
        `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 8px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
        muted(TOP_ADS_EXPLAINER),
    });
  }
  out.push({
    heading: 'Estimated time saved',
    text: [v.timeSaved, v.timeSavedNote],
    html: para(v.timeSaved, 'font-size:18px;font-weight:600;') + muted(v.timeSavedNote),
  });
  if (v.brands) {
    const rows = v.brands.map((b) => `${b.name} — ${b.processed} processed, ${b.hidden} hidden`);
    out.push({ heading: 'By brand', text: rows, html: rows.map((r) => para(r)).join('') });
  }
  return out;
}

export function renderWeeklyEmail(
  v: ReportView,
  r: {
    web: URL;
    orgId: string;
    weekStart: string;
    role: 'owner' | 'admin';
    token: string;
    deliveryId: string;
  },
): EmailContent {
  if (!UUID_RE.test(r.deliveryId)) throw new TypeError('invalid delivery id');
  const links = {
    dashboard: dashboardLink(r.web, r.orgId, r.weekStart),
    unsubscribe: unsubscribePageLink(r.web, r.token),
    settings: settingsLink(r.web),
  };
  const title = `Your FeedBouncer week for ${v.workspace}`;
  const why = `You're receiving this because you're an ${r.role} of ${v.workspace} on FeedBouncer.`;
  const parts = sections(v);

  const text = [
    title,
    v.range,
    ...(v.incomplete ? ['', v.incomplete] : []),
    ...parts.flatMap((s) => ['', s.heading, ...s.text]),
    '',
    '---',
    `${why} View this report: ${links.dashboard} · Unsubscribe: ${links.unsubscribe} · Email settings: ${links.settings}`,
    '',
  ].join('\n');

  const body = [
    `<h1 style="margin:0 0 4px;font-size:22px;">${escapeHtml(title)}</h1>`,
    muted(v.range),
    v.incomplete ? para(v.incomplete, 'margin-top:16px;padding:8px 12px;background:#fff7e0;') : '',
    ...parts.map(
      (s) => `<h2 style="margin:24px 0 8px;font-size:16px;">${escapeHtml(s.heading)}</h2>${s.html}`,
    ),
    `<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;color:#555555;font-size:12px;">${escapeHtml(why)} View this report: ${anchor(links.dashboard)} · Unsubscribe: ${anchor(links.unsubscribe)} · Email settings: ${anchor(links.settings)}</p>`,
  ].join('');

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f5f5f5;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;background:#ffffff;font-family:${FONT};color:#111111;line-height:1.5;">` +
    `<tr><td style="padding:24px;">${body}</td></tr></table></body></html>`;

  return {
    subject: headerSafe(`${title}: ${v.range}`),
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsubscribeApiLink(r.web, r.token)}>, <${links.unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': `<weekly-report.${r.web.hostname}>`,
    },
    messageId: `<weekly-${r.deliveryId.toLowerCase()}@${r.web.hostname}>`,
  };
}
