import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OnboardingConnectionDto, OnboardingStateDto } from '../../lib/onboarding';
import { withIntl } from '../../test/intl';
import { StepConnect } from './step-connect';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const conn = (over: Partial<OnboardingConnectionDto>): OnboardingConnectionDto => ({
  id: 'c1',
  platform: 'facebook',
  displayName: 'Shop Page',
  status: 'connected',
  statusReason: null,
  reviewMode: 'reviewing',
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
  steps: { connect: 'pending', defaults: 'pending', review_mode: 'pending', report: 'pending' },
  resumeStep: 'connect',
  reachable: { connect: true, defaults: false, review_mode: false, report: false },
  brand: { id: 'b1', name: 'Brand' },
  brands: [{ id: 'b1', name: 'Brand' }],
  configuredPlatforms: ['facebook', 'tiktok'],
  connections: [],
  reviewModeChoice: null,
  ...over,
});

const render = (s: OnboardingStateDto, error: string | null = null) =>
  renderToStaticMarkup(withIntl(<StepConnect orgId="o1" state={s} error={error} />));

const continueButton = (html: string) => {
  const at = html.indexOf('>Continue<');
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, at);
};

describe('StepConnect', () => {
  it('failed row with needs_reconnect shows expired text, an alert and Try again', () => {
    const html = render(
      state({
        connections: [conn({ status: 'failed', statusReason: 'oauth_refresh_rejected' })],
      }),
    );
    expect(html).toContain('Authorization expired or revoked');
    expect(html).toContain('<p role="alert">Access was lost or expired.');
    expect(html).toContain('>Try again</button>');
  });

  it('shows the other statuses', () => {
    const html = render(
      state({
        connections: [
          conn({ id: 'a', status: 'failed', statusReason: 'setup_not_queued' }),
          conn({ id: 'b', status: 'pending', statusReason: null }),
        ],
      }),
    );
    expect(html).toContain('Couldn&#x27;t connect');
    expect(html).toContain('Paused');
  });

  it('Continue is disabled with zero connected and enabled with one connected plus one failed', () => {
    const none = render(state({ connections: [conn({ status: 'failed', statusReason: 'x' })] }));
    expect(continueButton(none)).toContain('disabled=""');
    expect(none).toContain('Connect at least one account');
    const some = render(
      state({
        connections: [conn({ id: 'a' }), conn({ id: 'b', status: 'failed', statusReason: 'x' })],
      }),
    );
    expect(continueButton(some)).not.toContain('disabled=""');
    expect(some).toContain('Add more later in Connections');
  });

  it('no configured platforms shows the explanation and no connect buttons', () => {
    const html = render(state({ configuredPlatforms: [] }));
    expect(html).toContain('docs/self-hosting/README.md');
    expect(html).not.toContain('>Connect Facebook');
    expect(html).not.toContain('btn-primary');
  });

  it('one connect button per configured platform', () => {
    const html = render(state());
    expect(html).toContain('>Connect Facebook Page</button>');
    expect(html).toContain('>Connect TikTok account</button>');
  });

  it('shows a create-brand form without a brand', () => {
    const html = render(state({ brand: null, brands: [] }));
    expect(html).toContain('name="name"');
    expect(html).not.toContain('>Connect Facebook');
  });

  it('shows a brand select with several brands', () => {
    const html = render(
      state({
        brands: [
          { id: 'b1', name: 'Brand' },
          { id: 'b2', name: 'Other' },
        ],
      }),
    );
    expect(html).toContain('<select');
    expect(html).toContain('>Other</option>');
  });

  it('an error code shows its message, retry for the platform; unknown codes are generic', () => {
    const html = render(state(), 'denied');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Something went wrong.');
    expect(render(state(), 'zzz_unknown')).toContain('Something went wrong.');
  });
});
