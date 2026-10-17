import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertsUnavailable } from './alerts-unavailable';

describe('AlertsUnavailable', () => {
  it('unavailable state renders explanation and no forms', () => {
    const html = renderToStaticMarkup(<AlertsUnavailable />);
    expect(html).toContain('Alerts aren&#x27;t set up on this server.');
    expect(html).toContain(
      'An administrator can enable Slack or email alerts by setting ALERT_CHANNELS. See the <a href="https://github.com/feedbouncer/feedbouncer/blob/main/docs/operations/alerts.md">self-hosting guide</a>.',
    );
    expect(html).toContain('docs/operations/alerts.md');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });
});
