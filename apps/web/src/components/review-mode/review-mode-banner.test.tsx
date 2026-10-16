import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewModeStatusDto } from '../../lib/review-mode';
import { ReviewModeBanner } from './review-mode-banner';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const status = (over: Partial<ReviewModeStatusDto> = {}): ReviewModeStatusDto => ({
  connectionId: 'c1',
  platform: 'facebook',
  displayName: 'Shop Page',
  state: 'active',
  startedAt: '2026-10-20T10:00:00.000Z',
  endsAt: '2026-10-27T10:00:00.000Z',
  endedAt: null,
  graceEndsAt: '2026-10-30T10:00:00.000Z',
  pendingCount: 3,
  ...over,
});

const render = (s: ReviewModeStatusDto, canManage = true) =>
  renderToStaticMarkup(<ReviewModeBanner status={s} orgId="o" brandId="b" canManage={canManage} />);

describe('ReviewModeBanner', () => {
  it('shows the active copy with the end time in a time element', () => {
    const html = render(status());
    expect(html).toContain('Review mode is on for Shop Page until ');
    expect(html).toContain('<time dateTime="2026-10-27T10:00:00.000Z">2026-10-27 10:00 UTC</time>');
    expect(html).toContain(
      '. FeedBouncer suggests actions but won&#x27;t hide, delete, ban or reply on its own. 3 suggestions are waiting for review.',
    );
    expect(html).toContain('>End review mode</button>');
  });

  it('offers End review mode only to managers of an active window', () => {
    expect(render(status(), false)).not.toContain('End review mode');
    expect(render(status({ state: 'ended' }))).not.toContain('End review mode');
  });

  it('shows the ended copy with endedAt ?? endsAt and the grace end', () => {
    const html = render(status({ state: 'ended' }));
    expect(html).toContain('Review mode ended on <time dateTime="2026-10-27T10:00:00.000Z">');
    expect(html).toContain('will expire on <time dateTime="2026-10-30T10:00:00.000Z">');
  });

  it('renders nothing for off, opted out, or nothing left after the end', () => {
    expect(render(status({ state: 'off' }))).toBe('');
    expect(render(status({ state: 'opted_out' }))).toBe('');
    expect(render(status({ state: 'ended', pendingCount: 0 }))).toBe('');
  });

  it('renders the account name as text', () => {
    const html = render(status({ displayName: '<img src=x onerror=alert(1)>' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
