import { buildView, type WeeklyStats } from '@feedbouncer/reports/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WeeklyReport } from './WeeklyReport';

const ad = (o: Partial<WeeklyStats['ads'][number]>): WeeklyStats['ads'][number] => ({
  adId: 'a1',
  externalId: '120000000000123456',
  name: 'Spring sale',
  platforms: ['facebook'],
  brandId: 'b1',
  archived: false,
  hidden: 4,
  total: 12,
  ...o,
});

const stats = (o: Partial<WeeklyStats> = {}): WeeklyStats => ({
  version: 1,
  organizationId: 'o1',
  weekStart: '2026-10-05',
  timezone: 'Europe/Berlin',
  start: '2026-10-04T22:00:00.000Z',
  end: '2026-10-11T22:00:00.000Z',
  computedAt: '2026-10-12T06:00:00.000Z',
  processed: 12345,
  processedPrev: 11345,
  hidden: 400,
  buckets: [
    { bucket: 'spam', count: 300 },
    { bucket: 'rule', count: 100 },
  ],
  ads: [ad({}), ad({ adId: 'a2', externalId: '999999000002', archived: true, hidden: 2 })],
  brands: [
    { brandId: 'b1', name: 'Shop', archived: false, processed: 12000, hidden: 390 },
    { brandId: 'b2', name: 'Outlet', archived: true, processed: 345, hidden: 10 },
  ],
  incompleteAccounts: [],
  ...o,
});

const render = (s: WeeklyStats, source: 'snapshot' | 'live' = 'snapshot') =>
  renderToStaticMarkup(<WeeklyReport view={buildView(s, 'Acme')} source={source} />);

const headings = (html: string) => [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('WeeklyReport', () => {
  it('renders the five sections from a ReportView fixture', () => {
    const html = render(stats());
    expect(headings(html)).toEqual([
      'Comments processed',
      'Hidden by category',
      'Ads with the highest share of hidden comments',
      'Estimated time saved',
      'By brand',
    ]);
    for (const s of [
      'Oct 5 – Oct 11, 2026 (Europe/Berlin)',
      '12,345 comments processed',
      '+1,000 (+8.8%) vs. the week before',
      'Spam — 300 (75.0%)',
      'Your rules — 100 (25.0%)',
      'Total hidden: 400',
      'Spring sale · #123456',
      'Spring sale · #000002 (archived)',
      '33.3%',
      'Hidden share = hidden comments ÷ all comments on the ad this week. Ads with fewer than 10 comments are not ranked.',
      '3 h 20 min',
      'Estimate based on about 30 seconds of manual review per hidden comment.',
      'Shop — 12,000 processed, 390 hidden',
      'Outlet (archived) — 345 processed, 10 hidden',
    ])
      expect(html).toContain(s);
    for (const c of ['Ad', 'Platform', 'Hidden', 'Comments', 'Hidden share'])
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${c}</th>`));
    expect(html).toContain('the numbers from the weekly email');
    expect(render(stats(), 'live')).toContain('Calculated from current data');
  });

  it('nothing hidden hides categories and ads', () => {
    const html = render(stats({ hidden: 0, buckets: [], ads: [], brands: [] }));
    expect(headings(html)).toEqual(['Comments processed', 'Estimated time saved']);
    expect(html).toContain('0 min');
    expect(html).not.toContain('Total hidden');
    expect(html).not.toContain('<table');
  });

  it('shows why no ad is ranked and the incomplete-data note', () => {
    const html = render(
      stats({
        ads: [],
        incompleteAccounts: [{ connectionId: 'c1', name: 'Main Page', platform: 'facebook' }],
      }),
    );
    expect(html).toContain(
      'No ad had at least 10 comments with hidden ones this week, so there is no ranking.',
    );
    expect(html).toContain(
      'Some accounts were disconnected during this week, so these numbers may be incomplete: Main Page.',
    );
  });

  it('ad names are text, not HTML', () => {
    const html = render(stats({ ads: [ad({ name: '<img src=x onerror=alert(1)>‮gnp' })] }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; gnp');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('‮');
  });
});
