import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import type { OnboardingConnectionDto, OnboardingStateDto } from '../../lib/onboarding';
import { withIntl } from '../../test/intl';
import { StepReviewMode } from './step-review-mode';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const conn = (over: Partial<OnboardingConnectionDto>): OnboardingConnectionDto => ({
  id: 'c1',
  platform: 'facebook',
  displayName: 'Shop',
  status: 'connected',
  statusReason: null,
  needsReconnect: false,
  reviewMode: 'active',
  backfill: null,
  ...over,
});

const state = (over: Partial<OnboardingStateDto> = {}): OnboardingStateDto => ({
  started: true,
  autoStart: false,
  preconfigured: false,
  dismissed: false,
  complete: false,
  run: 1,
  steps: { connect: 'done', defaults: 'done', review_mode: 'pending', report: 'pending' },
  resumeStep: 'review_mode',
  reachable: { connect: true, defaults: true, review_mode: true, report: false },
  brand: { id: 'b1', name: 'Brand' },
  brands: [{ id: 'b1', name: 'Brand' }],
  configuredPlatforms: ['facebook'],
  connections: [conn({})],
  reviewModeChoice: null,
  ...over,
});

const render = (s: OnboardingStateDto) =>
  renderToStaticMarkup(withIntl(<StepReviewMode orgId="o1" state={s} />));

const radio = (html: string, value: string) => {
  const at = html.indexOf(`value="${value}"`);
  return html.slice(html.lastIndexOf('<input', at), html.indexOf('>', at));
};

describe('StepReviewMode', () => {
  it('review is checked by default; automatic shows acknowledgement', () => {
    const html = render(state());
    expect(radio(html, 'review')).toContain('checked=""');
    expect(radio(html, 'automatic')).not.toContain('checked=""');
    expect(html).not.toContain('type="checkbox"');
    const auto = render(state({ reviewModeChoice: 'automatic' }));
    expect(radio(auto, 'automatic')).toContain('checked=""');
    expect(auto).toContain('type="checkbox"');
    expect(auto).toContain('required=""');
  });

  it('keeps both facts in the copy', () => {
    const t = en.onboarding.reviewMode;
    expect(t.review.body).toMatch(/7 days/);
    expect(t.review.body).toMatch(/approves/);
    expect(t.automatic.body).toMatch(/undone/);
    expect(t.automatic.body).toMatch(/logged/);
  });

  it('review disabled with explanation when every connection has ended', () => {
    const html = render(state({ connections: [conn({ reviewMode: 'ended' })] }));
    expect(radio(html, 'review')).toContain('disabled=""');
    expect(html).toContain(en.onboarding.reviewMode.reviewUnavailable);
    expect(radio(html, 'automatic')).not.toContain('disabled=""');
    const ok = render(state({ connections: [conn({ reviewMode: 'off' })] }));
    expect(radio(ok, 'review')).not.toContain('disabled=""');
  });

  it('stored automatic choice with review unavailable still preselects automatic', () => {
    const html = render(state({ connections: [conn({ reviewMode: 'ended' })] }));
    expect(radio(html, 'automatic')).toContain('checked=""');
  });
});
