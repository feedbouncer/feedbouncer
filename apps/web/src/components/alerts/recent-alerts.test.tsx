import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AlertEventDto } from '../../lib/alerts';
import { RecentAlerts } from './recent-alerts';

const events: AlertEventDto[] = [
  {
    id: 'e1',
    type: 'negative_spike',
    status: 'sent',
    createdAt: '2026-03-01T10:00:00.000Z',
    windowStart: null,
    windowEnd: null,
    counts: { negatives: 14, total: 60 },
    explanation: { trigger: 'volume', expectedPerHour: 3, sensitivity: 'medium', minCount: 10 },
    deliveries: [
      { channelId: 'c1', state: 'sent', lastErrorCode: null },
      { channelId: 'c2', state: 'failed', lastErrorCode: 'no_service' },
    ],
  },
  {
    id: 'e2',
    type: 'flagged_item',
    status: 'sent',
    createdAt: '2026-03-01T11:00:00.000Z',
    windowStart: null,
    windowEnd: null,
    counts: { items: 2 },
    explanation: null,
    deliveries: [],
  },
];

describe('RecentAlerts', () => {
  it('shows the Why line and per-channel delivery state', () => {
    const html = renderToStaticMarkup(
      <RecentAlerts events={events} channelLabels={{ c1: 'Ops <b>', c2: 'Mail' }} />,
    );
    expect(html).toContain('Recent alerts');
    expect(html).toContain('Negative comment spike');
    expect(html).toContain('Flagged comments');
    expect(html).toContain('Why: 14 negative vs. usual 3/hour at medium sensitivity');
    expect(html).toContain('Ops &lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Mail: failed');
    expect(html).toContain('Slack no longer accepts this webhook.');
    expect(html).toContain('2 flagged');
  });

  it('says so when there are none', () => {
    expect(renderToStaticMarkup(<RecentAlerts events={[]} channelLabels={{}} />)).toContain(
      'No alerts yet.',
    );
  });
});
