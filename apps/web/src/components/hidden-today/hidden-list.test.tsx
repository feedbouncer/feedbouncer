import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BrandDayDto, HiddenItemDto } from '../../lib/hidden-today';
import { HiddenList } from './hidden-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const brand = (over: Partial<BrandDayDto> = {}): BrandDayDto => ({
  organizationId: 'o',
  brandId: 'b',
  brandName: 'Shop',
  timezone: 'UTC',
  timezoneSet: false,
  dayStart: '2026-10-16T00:00:00.000Z',
  ...over,
});

const item = (): HiddenItemDto => ({
  hideActionId: '6f1c3a7e-1b2c-4d5e-8f90-123456789abc',
  organizationId: 'o',
  organizationName: 'Org',
  brandId: 'b',
  brandName: 'Shop',
  connectionId: 'c',
  connectionName: 'Page',
  connectionStatus: 'active',
  platform: 'facebook',
  commentId: 'cm',
  commentBody: 'hello',
  commentState: 'hidden',
  authorName: null,
  hiddenAt: '2026-10-16T10:00:00.000Z',
  source: { type: 'system' },
  reason: null,
  lastAttempt: null,
  state: 'hidden',
  canUnhide: true,
  history: [],
});

const render = (p: Partial<Parameters<typeof HiddenList>[0]> = {}) =>
  renderToStaticMarkup(
    <HiddenList items={[]} next={null} brands={[brand()]} canManage={{ o: true }} {...p} />,
  );

describe('HiddenList', () => {
  it('shows the empty state', () => {
    const html = render();
    expect(html).toContain('Nothing hidden today');
    expect(html).toContain(
      'When FeedBouncer or someone on your team hides a comment, it appears here so you can undo it with one click.',
    );
  });

  it('shows the per-brand header and the timezone notice only for unset brands', () => {
    const html = render({
      brands: [
        brand(),
        brand({ brandId: 'b2', brandName: 'Other', timezone: 'Europe/Berlin', timezoneSet: true }),
      ],
    });
    expect(html).toContain('Since midnight (UTC)');
    expect(html).toContain('Since midnight (Europe/Berlin)');
    expect(html).toContain('uses UTC midnight');
    expect(html.match(/uses UTC midnight/g)).toHaveLength(1);
  });

  it('the Use button needs canManage; members see Ask an admin', () => {
    expect(render()).toMatch(/>Use [^<]+<\/button>/);
    const member = render({ canManage: { o: false } });
    expect(member).not.toMatch(/>Use [^<]+<\/button>/);
    expect(member).toContain('Ask an admin to set it.');
  });

  it('renders rows and a Load more link when next is set', () => {
    const html = render({
      items: [item()],
      next: { before: '2026-10-16T10:00:00.000Z', beforeId: 'abc' },
    });
    expect(html).toContain('>Unhide</button>');
    expect(html).not.toContain('Nothing hidden today');
    expect(html).toContain(
      'href="/hidden-today?before=2026-10-16T10%3A00%3A00.000Z&amp;beforeId=abc"',
    );
    expect(html).toContain('Load more');
    expect(render({ items: [item()] })).not.toContain('Load more');
  });
});
