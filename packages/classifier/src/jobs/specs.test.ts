import { describe, expect, it } from 'vitest';
import { decide as decideFailure, JobDeferral, classifyFailure } from '@feedbouncer/jobs';
import {
  BRAND_BUSY_RETRY_MS,
  CLASSIFIER_JOB_SPECS,
  CLASSIFY_JOB,
  MAX_CONFIGURABLE_WAIT_MS,
} from './specs.js';

describe('classify deferral budget', () => {
  it('can defer longer than the longest configurable wait, so queue_timeout fires before dead-lettering', () => {
    const p = CLASSIFY_JOB.policy;
    const f = classifyFailure(new JobDeferral('classifier_brand_busy', BRAND_BUSY_RETRY_MS));
    let waited = 0;
    let deferrals = 0;
    for (;;) {
      const d = decideFailure(
        f,
        { failures: 0, replays: 0, deferrals, deferredMs: waited },
        p as never,
        () => 0,
      );
      if (d.type !== 'defer') break;
      waited += d.delayMs;
      deferrals++;
    }
    expect(waited).toBeGreaterThan(MAX_CONFIGURABLE_WAIT_MS);
  });

  it('stays within the budget even with maximal jitter until the wait has elapsed', () => {
    const p = CLASSIFY_JOB.policy;
    const worstCase = p.maxDeferrals * Math.ceil(BRAND_BUSY_RETRY_MS * 1.1);
    expect(worstCase).toBeLessThanOrEqual(p.maxDeferredMs);
    expect(p.maxDeferrals * BRAND_BUSY_RETRY_MS).toBeGreaterThan(MAX_CONFIGURABLE_WAIT_MS);
  });
});
