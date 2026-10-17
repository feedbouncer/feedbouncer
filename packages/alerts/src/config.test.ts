import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { parseAlertChannels, readAlertLimits } from './config.js';

describe('parseAlertChannels', () => {
  it('treats unset and empty as unavailable', () => {
    const off = { slack: false, email: false };
    expect(parseAlertChannels(undefined)).toEqual(off);
    expect(parseAlertChannels('')).toEqual(off);
  });

  it('trims, lowercases and ignores empty items', () => {
    expect(parseAlertChannels(' Slack , email ,')).toEqual({ slack: true, email: true });
    expect(parseAlertChannels('slack')).toEqual({ slack: true, email: false });
  });

  it('rejects an unknown channel', () => {
    expect(() => parseAlertChannels('slack,sms')).toThrow(EnvError);
    expect(() => parseAlertChannels('sms')).toThrow(/ALERT_CHANNELS/);
  });
});

describe('readAlertLimits', () => {
  it('defaults to 30 per workspace-hour and 60 emails per minute', () => {
    expect(readAlertLimits({})).toEqual({ capPerHour: 30, emailPerMinute: 60 });
  });

  it('reads and range-checks the limits', () => {
    expect(
      readAlertLimits({
        ALERT_MAX_PER_WORKSPACE_PER_HOUR: '1000',
        ALERT_EMAIL_MAX_PER_MINUTE: '6000',
      }),
    ).toEqual({ capPerHour: 1000, emailPerMinute: 6000 });
    expect(() => readAlertLimits({ ALERT_MAX_PER_WORKSPACE_PER_HOUR: '0' })).toThrow(
      /ALERT_MAX_PER_WORKSPACE_PER_HOUR/,
    );
    expect(() => readAlertLimits({ ALERT_EMAIL_MAX_PER_MINUTE: '6001' })).toThrow(
      /ALERT_EMAIL_MAX_PER_MINUTE/,
    );
  });
});
