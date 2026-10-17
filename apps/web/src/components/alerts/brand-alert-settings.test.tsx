import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AlertChannelDto, BrandAlertsView } from '../../lib/alerts';
import { BrandAlertSettings } from './brand-alert-settings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const SLACK = '11111111-1111-4111-8111-111111111111';
const MAIL = '33333333-3333-4333-8333-333333333333';
const ch = (id: string, kind: 'slack' | 'email', label: string): AlertChannelDto => ({
  id,
  kind,
  label,
  status: 'active',
  health: 'active',
  hint: null,
  email: null,
  lastFailureCode: null,
  lastFailureAt: null,
  disconnectedCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const view = (over: Partial<BrandAlertsView> = {}): BrandAlertsView => ({
  availability: { slack: true, email: true },
  settings: {
    sensitivity: 'medium',
    minNegativeCount: 10,
    cooldownMinutes: 360,
    contentMode: 'excerpts',
  },
  routes: [{ alertType: 'negative_spike', channelId: SLACK, enabled: true }],
  learning: false,
  channels: [ch(SLACK, 'slack', 'Ops'), ch(MAIL, 'email', 'Mail')],
  recent: [],
  ...over,
});

const render = (v: BrandAlertsView, canManage = true) =>
  renderToStaticMarkup(
    <BrandAlertSettings
      orgId="22222222-2222-4222-8222-222222222222"
      brandId="44444444-4444-4444-8444-444444444444"
      view={v}
      canManage={canManage}
    />,
  );

describe('BrandAlertSettings', () => {
  it('matrix checkboxes reflect routes; counts_only radio; unavailable kinds disabled; learning hint', () => {
    const html = render(
      view({
        settings: {
          sensitivity: 'high',
          minNegativeCount: 5,
          cooldownMinutes: 60,
          contentMode: 'counts_only',
        },
        availability: { slack: true, email: false },
        learning: true,
      }),
    );
    expect(html).toContain('Negative comment spike');
    expect(html).toContain('Flagged comments');
    const boxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(4);
    expect(boxes.filter((b) => b.includes('checked=""'))).toHaveLength(1);
    expect(boxes.filter((b) => b.includes('disabled=""'))).toHaveLength(2);
    expect(html).toMatch(
      /<input[^>]*value="counts_only"[^>]*checked=""|<input[^>]*checked=""[^>]*value="counts_only"/,
    );
    expect(html).toContain('Counts and links only');
    expect(html).toContain('Include short comment excerpts');
    expect(html).toContain('Medium (default)');
    expect(html).toContain(
      'Higher sensitivity alerts on smaller rises above this brand&#x27;s usual level.',
    );
    expect(html).toContain('Minimum negative comments in an hour');
    expect(html).toContain('Cooldown after an alert');
    expect(html).toContain('6 h (default)');
    expect(html).toContain('Save alert settings');
    expect(html).toContain('Spike alerts start after 7 days of comment history for this brand.');
  });

  it('omits the learning hint when not learning and disables everything for read-only roles', () => {
    const html = render(view(), false);
    expect(html).not.toContain('Spike alerts start after');
    expect(html).not.toContain('Save alert settings');
  });

  it('points at the workspace page when there are no channels', () => {
    const html = render(view({ channels: [], routes: [] }));
    expect(html).toContain('No channels yet');
  });
});
