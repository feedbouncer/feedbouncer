import { describe, expect, it } from 'vitest';
import { errorCodeText, healthText, type AlertChannelDto } from './alerts';

describe('errorCodeText', () => {
  it('maps known codes and falls back to the code', () => {
    for (const c of ['no_service', 'invalid_token', 'no_active_hooks']) {
      expect(errorCodeText(c)).toBe('Slack no longer accepts this webhook.');
    }
    expect(errorCodeText('channel_is_archived')).toBe('The Slack channel was archived.');
    expect(errorCodeText('action_prohibited')).toBe('A Slack admin blocked this webhook.');
    expect(errorCodeText('rate_limited')).toBe('Slack is rate limiting messages.');
    expect(errorCodeText('outcome_unknown')).toBe("Delivery couldn't be confirmed.");
    expect(errorCodeText('not_confirmed')).toBe("This address hasn't been confirmed yet.");
    expect(errorCodeText('smtp_550')).toBe('Delivery failed (smtp_550).');
    expect(errorCodeText('constructor')).toBe('Delivery failed (constructor).');
  });
});

const base: AlertChannelDto = {
  id: 'c1',
  kind: 'slack',
  label: 'x',
  status: 'active',
  health: 'active',
  hint: null,
  email: null,
  lastFailureCode: null,
  lastFailureAt: null,
  disconnectedCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('healthText', () => {
  it('describes each health state', () => {
    expect(healthText(base)).toBe('Active');
    expect(healthText({ ...base, health: 'pending_confirmation' })).toBe(
      'Waiting for confirmation',
    );
    expect(healthText({ ...base, health: 'unsubscribed' })).toBe('Unsubscribed');
    expect(
      healthText({ ...base, health: 'delivery_problem', lastFailureCode: 'rate_limited' }),
    ).toBe('Delivery problem: Slack is rate limiting messages.');
    expect(healthText({ ...base, health: 'disconnected', disconnectedCode: 'no_service' })).toBe(
      'Disconnected: Slack no longer accepts this webhook.',
    );
  });
});
