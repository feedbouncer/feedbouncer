import { describe, expect, it } from 'vitest';
import { ConnectorError } from './errors.js';
import { isQuotaRefusal } from './quota.js';

describe('isQuotaRefusal', () => {
  it('matches the meter refusals only', () => {
    expect(isQuotaRefusal(new ConnectorError('rate_limited', 'quota_budget_exhausted'))).toBe(true);
    expect(isQuotaRefusal(new ConnectorError('rate_limited', 'quota_paused'))).toBe(true);
    expect(isQuotaRefusal(new ConnectorError('rate_limited', 'platform_throttled'))).toBe(false);
    expect(isQuotaRefusal(new ConnectorError('rate_limited', 'quota_exceeded'))).toBe(false);
    expect(isQuotaRefusal(new ConnectorError('permanent', 'quota_paused'))).toBe(false);
    expect(isQuotaRefusal(new Error('quota_paused'))).toBe(false);
  });
});
