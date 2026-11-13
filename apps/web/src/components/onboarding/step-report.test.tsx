import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OnboardingReportDto } from '../../lib/onboarding';
import { withIntl } from '../../test/intl';
import { StepReport } from './step-report';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const account = (over: Partial<OnboardingReportDto['accounts'][number]> = {}) => ({
  connectionId: 'c1',
  platform: 'facebook',
  displayName: 'Shop Page',
  status: 'connected' as const,
  backfill: null,
  comments: 3,
  imported: 1,
  checked: 2,
  hidden: 1,
  awaitingReview: 1,
  topCategories: [{ category: 'spam', count: 2 }],
  ...over,
});

const report = (over: Partial<OnboardingReportDto> = {}): OnboardingReportDto => ({
  range: { from: '2026-11-06T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' },
  reviewModeChoice: 'review',
  defaults: [
    { category: 'scam_phishing', action: 'hide' },
    { category: 'spam', action: 'flag' },
  ],
  sync: 'ready',
  totals: { comments: 3, hidden: 1, replied: 0, unanswered: 3 },
  categories: [{ category: 'spam', count: 2 }],
  accounts: [account()],
  empty: false,
  ...over,
});

const render = (r: OnboardingReportDto) =>
  renderToStaticMarkup(withIntl(<StepReport orgId="o1" initial={r} />));

describe('StepReport', () => {
  it('empty state copy and enabled Finish', () => {
    const html = render(
      report({
        empty: true,
        totals: { comments: 0, hidden: 0, replied: 0, unanswered: 0 },
        accounts: [],
        categories: [],
      }),
    );
    expect(html).toContain('No comments yet');
    expect(html).toContain('within about a minute');
    expect(html).toContain('weekly report on Monday');
    expect(html).toContain('Imported history');
    const at = html.indexOf('>Finish<');
    expect(html.slice(html.lastIndexOf('<button', at), at)).not.toContain('disabled=""');
  });

  it('syncing renders aria-live="polite" with plural progress', () => {
    const one = render(
      report({
        sync: 'syncing',
        accounts: [account({ imported: 1 })],
        totals: { comments: 1, hidden: 0, replied: 0, unanswered: 1 },
      }),
    );
    expect(one).toContain('aria-live="polite"');
    expect(one).toContain('Imported 1 comment so far');
    const many = render(report({ sync: 'syncing', accounts: [account({ imported: 12 })] }));
    expect(many).toContain('Imported 12 comments so far');
  });

  it('two accounts render two cards', () => {
    const html = render(
      report({ accounts: [account(), account({ connectionId: 'c2', displayName: 'Other' })] }),
    );
    expect(html.match(/data-slot="card"/g)).toHaveLength(2);
    expect(html).toContain('Other');
    expect(html).toContain('Spam');
  });

  it('shows the chosen review mode and defaults summary', () => {
    const html = render(report());
    expect(html).toContain('Review mode: Review first');
    expect(html).toContain('Scam or phishing');
    expect(render(report({ reviewModeChoice: 'automatic' }))).toContain(
      'Review mode: Act automatically',
    );
  });

  it('display name is escaped', () => {
    const html = render(
      report({ accounts: [account({ displayName: '<img src=x onerror=alert(1)>' })] }),
    );
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('has no absolute links', () => {
    expect(render(report())).not.toMatch(/https?:\/\//);
  });
});
