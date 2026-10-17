import { afterEach, describe, expect, it, vi } from 'vitest';
import { headerSafe } from '@feedbouncer/mailer';
import { dashboardLink, settingsLink, unsubscribeApiLink, unsubscribePageLink } from './links.js';
import { renderWeeklyEmail } from './render.js';
import type { AdStat, WeeklyStats } from './stats.js';
import { buildView } from './view.js';

const web = new URL('https://app.example.test');
const ORG = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);
const WEEK = '2026-10-05';
const r = {
  web,
  orgId: ORG,
  weekStart: WEEK,
  role: 'admin' as const,
  token: TOKEN,
  deliveryId: DELIVERY,
};

const HEADINGS = [
  'Comments processed',
  'Hidden by category',
  'Ads with the highest share of hidden comments',
  'Estimated time saved',
  'By brand',
];

const ad = (o: Partial<AdStat>): AdStat => ({
  adId: 'ad',
  externalId: '120000000111111',
  name: 'Ad',
  platforms: ['facebook'],
  brandId: 'b1',
  archived: false,
  hidden: 5,
  total: 20,
  ...o,
});

const stats = (o: Partial<WeeklyStats> = {}): WeeklyStats => ({
  version: 1,
  organizationId: ORG,
  weekStart: WEEK,
  timezone: 'America/New_York',
  start: '2026-10-05T04:00:00.000Z',
  end: '2026-10-12T04:00:00.000Z',
  computedAt: '2026-10-12T12:00:00.000Z',
  processed: 12345,
  processedPrev: 10000,
  hidden: 400,
  buckets: [
    { bucket: 'spam', count: 300 },
    { bucket: 'rule', count: 100 },
  ],
  ads: [ad({ adId: 'a1', name: 'Summer', hidden: 40, total: 100 })],
  brands: [
    { brandId: 'b1', name: 'Acme', archived: false, processed: 12000, hidden: 390 },
    { brandId: 'b2', name: 'Old Co', archived: true, processed: 345, hidden: 10 },
  ],
  brandCount: 2,
  incompleteAccounts: [],
  incompleteAccountCount: 0,
  ...o,
});

const render = (s: WeeklyStats = stats()) => renderWeeklyEmail(buildView(s, 'Acme Workspace'), r);

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
const htmlText = (html: string) =>
  decode(html.replace(/<head>[\s\S]*<\/head>/, '').replace(/<[^>]+>/g, ' '));
const numbers = (s: string) => s.match(/\d[\d,.]*/g) ?? [];
const order = (s: string, parts: string[]) => parts.map((p) => s.indexOf(p));
const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

afterEach(() => {
  vi.doUnmock('./constants.js');
  vi.resetModules();
});

describe('renderWeeklyEmail', () => {
  it('full report renders all five sections in order in both html and text with identical numbers', () => {
    const e = render();
    for (const body of [e.text, htmlText(e.html)]) {
      expect(ascending(order(body, HEADINGS))).toBe(true);
      for (const s of [
        '12,345 comments processed',
        '+2,345 (+23.5%) vs. the week before',
        'Spam — 300 (75.0%)',
        'Your rules — 100 (25.0%)',
        'Total hidden: 400',
        'Summer · #111111',
        '3 h 20 min',
        'Estimate based on about 30 seconds of manual review per hidden comment.',
        'Acme — 12,000 processed, 390 hidden',
        'Old Co (archived) — 345 processed, 10 hidden',
        'Hidden share = hidden comments ÷ all comments on the ad this week. Ads with fewer than 10 comments are not ranked.',
        "You're receiving this because you're an admin of Acme Workspace on FeedBouncer.",
      ]) {
        expect(body).toContain(s);
      }
    }
    expect(e.text).toContain('12,345 comments processed\n+2,345 (+23.5%) vs. the week before');
    expect(e.text).toContain(
      '3 h 20 min\nEstimate based on about 30 seconds of manual review per hidden comment.',
    );
    for (const col of ['Ad', 'Platform', 'Hidden', 'Comments', 'Hidden share']) {
      expect(e.html).toContain(`<th`);
      expect(e.html).toMatch(new RegExp(`<th[^>]*>${col}</th>`));
    }
    expect(numbers(htmlText(e.html))).toEqual(numbers(e.text));
    expect(e.html).toMatch(/^<!doctype html><html lang="en">/);
    expect(e.html).toContain('<meta charset="utf-8">');
    expect(e.html).toContain('<meta name="color-scheme" content="light">');
    expect(e.html).toMatch(/<table role="presentation"[^>]*max-width:600px/);
  });

  it("nothing hidden: categories and top-ads omitted, time saved '0 min', processed shown", () => {
    const e = render(stats({ hidden: 0, buckets: [], ads: [] }));
    for (const body of [e.text, htmlText(e.html)]) {
      expect(body).toContain('12,345 comments processed');
      expect(body).not.toContain('Hidden by category');
      expect(body).not.toContain('Ads with the highest share of hidden comments');
      expect(body).not.toContain('No ad had');
      expect(body).toContain('Estimated time saved');
      expect(body).toContain('0 min');
    }
  });

  it('none qualify: note text instead of table', () => {
    const e = render(stats({ ads: [] }));
    const note =
      'No ad had at least 10 comments with hidden ones this week, so there is no ranking.';
    expect(e.text).toContain(note);
    expect(htmlText(e.html)).toContain(note);
    expect(e.html).not.toContain('<th');
    expect(e.text).not.toContain('Hidden share =');
  });

  it('single brand: no By brand section', () => {
    const e = render(stats({ brands: [stats().brands[0]!], brandCount: 1 }));
    expect(e.text).not.toContain('By brand');
    expect(e.html).not.toContain('By brand');
  });

  it('capped snapshot: By brand ends with +k more brands; the incomplete note counts accounts not listed', () => {
    const e = render(
      stats({
        brandCount: 5,
        incompleteAccounts: Array.from({ length: 5 }, (_, i) => ({
          connectionId: `c${i}`,
          name: `Page ${i}`,
          platform: 'facebook',
        })),
        incompleteAccountCount: 12,
      }),
    );
    for (const out of [e.text, htmlText(e.html)]) {
      expect(out).toContain('Old Co (archived) — 345 processed, 10 hidden');
      expect(out).toContain('+3 more brands');
      expect(out).toContain(
        'these numbers may be incomplete: Page 0, Page 1, Page 2, Page 3, Page 4, +7 more.',
      );
    }
  });

  it('hostile, duplicate and archived ad names render safely and distinguishably', () => {
    const e = render(
      stats({
        ads: [
          ad({
            adId: 'h',
            name: '<img src=x onerror=alert(1)>\u202Egnp.exe',
            hidden: 9,
            total: 10,
          }),
          ad({
            adId: 's1',
            name: 'Spring sale',
            externalId: '120000000123456',
            hidden: 8,
            total: 10,
          }),
          ad({
            adId: 's2',
            name: 'Spring sale',
            externalId: '120000000654321',
            hidden: 7,
            total: 10,
          }),
          ad({ adId: 'del', name: 'Gone', archived: true, hidden: 6, total: 10 }),
        ],
      }),
    );
    expect(e.html).toContain('&lt;img');
    expect(e.html).not.toContain('<img');
    for (const out of [e.html, e.text, e.subject]) expect(out).not.toContain('\u202E');
    for (const out of [e.text, htmlText(e.html)]) {
      expect(out).toContain('Spring sale · #123456');
      expect(out).toContain('Spring sale · #654321');
      expect(out).toContain('Gone · #111111 (archived)');
    }
  });

  it('html contains no <img, <script, <link, http(s) url other than the four expected links', () => {
    const e = render(
      stats({
        incompleteAccounts: Array.from({ length: 7 }, (_, i) => ({
          connectionId: `c${i}`,
          name: `Page ${i}`,
          platform: 'facebook',
        })),
        incompleteAccountCount: 7,
      }),
    );
    for (const tag of ['<img', '<script', '<link', '<style', '@import', 'url(']) {
      expect(e.html.toLowerCase()).not.toContain(tag);
    }
    const expected = new Set([
      dashboardLink(web, ORG, WEEK),
      unsubscribePageLink(web, TOKEN),
      unsubscribeApiLink(web, TOKEN),
      settingsLink(web),
    ]);
    const urls = [...e.html.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(expected).toContain(u);
    expect(e.text).toContain(
      'Some accounts were disconnected during this week, so these numbers may be incomplete: Page 0, Page 1, Page 2, Page 3, Page 4, +2 more.',
    );
    expect(dashboardLink(web, ORG, WEEK)).toBe(
      `https://app.example.test/orgs/${ORG}/reports?week=${WEEK}`,
    );
    expect(unsubscribePageLink(web, TOKEN)).toBe(
      `https://app.example.test/reports/unsubscribe?token=${TOKEN}`,
    );
    expect(unsubscribeApiLink(web, TOKEN)).toBe(
      `https://app.example.test/api/v1/report-subscriptions/unsubscribe?token=${TOKEN}`,
    );
    expect(settingsLink(web)).toBe('https://app.example.test/account#email-reports');
    expect(() => dashboardLink(web, 'x/../y', WEEK)).toThrow();
    expect(() => dashboardLink(web, ORG, '2026-10-05&x=1')).toThrow();
    expect(() => unsubscribePageLink(web, `${TOKEN}x`)).toThrow();
  });

  it('time-saved note states 30 seconds from the constant', async () => {
    vi.resetModules();
    vi.doMock('./constants.js', async (orig) => ({
      ...(await orig<typeof import('./constants.js')>()),
      SECONDS_SAVED_PER_HIDDEN_COMMENT: 45,
    }));
    const view = await import('./view.js');
    const v = view.buildView(stats(), 'Acme Workspace');
    expect(v.timeSavedNote).toBe(
      'Estimate based on about 45 seconds of manual review per hidden comment.',
    );
    expect(v.timeSaved).toBe('5 h');
  });

  it('headers: List-Unsubscribe has both URLs, List-Unsubscribe-Post one-click, messageId weekly-<id>@host', () => {
    const e = render();
    expect(e.headers).toEqual({
      'List-Unsubscribe': `<${unsubscribeApiLink(web, TOKEN)}>, <${unsubscribePageLink(web, TOKEN)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': '<weekly-report.app.example.test>',
    });
    expect(e.messageId).toBe(`<weekly-${DELIVERY}@app.example.test>`);
    expect(() =>
      renderWeeklyEmail(buildView(stats(), 'W'), { ...r, deliveryId: 'x@evil' }),
    ).toThrow();
  });

  it('subject passes headerSafe and contains workspace and range', () => {
    const e = renderWeeklyEmail(buildView(stats(), 'Acme\r\nBcc: x@evil.test\u202E'), r);
    expect(headerSafe(e.subject)).toBe(e.subject);
    expect(e.subject).toBe(
      'Your FeedBouncer week for Acme Bcc: x@evil.test: Oct 5 – Oct 11, 2026 (America/New_York)',
    );
  });
});
