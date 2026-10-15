import { describe, expect, it, vi } from 'vitest';
import type { RuleEvaluatedEvent } from '@feedbouncer/rules';
import { POLICY_EVALUATE_JOB, POLICY_JOB_SPECS } from './jobs/specs.js';
import { PolicyTrigger } from './trigger.js';

const scope = { organizationId: 'o', brandId: 'b', connectionId: 'c' };
const sha = 'a'.repeat(64);
const commentId = '11111111-1111-4111-8111-111111111111';
const ev: RuleEvaluatedEvent = {
  scope,
  platform: 'facebook',
  commentId,
  bodySha256: sha,
  evaluationId: 'e',
  status: 'no_match',
};

describe('PolicyTrigger', () => {
  it('enqueues policy_evaluate only for no_match and only when a policy is enabled', async () => {
    const enqueue = vi.fn().mockResolvedValue({ status: 'enqueued' });
    const hasEnabled = vi.fn().mockResolvedValue(true);
    const t = new PolicyTrigger({ enqueue }, { hasEnabled }, { now: () => 1_000 });
    await t.onEvaluated({ ...ev, status: 'decided' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(hasEnabled).not.toHaveBeenCalled();
    await t.onEvaluated({ ...ev, status: 'no_match' });
    expect(hasEnabled).toHaveBeenCalledWith({ organizationId: 'o', brandId: 'b' });
    expect(enqueue).toHaveBeenCalledWith({
      scope,
      platform: 'facebook',
      type: 'policy_evaluate',
      payload: { commentId, bodySha256: sha, trigger: 'ingest', requestedAt: 1_000 },
    });
    hasEnabled.mockResolvedValue(false);
    enqueue.mockClear();
    await t.onEvaluated({ ...ev, status: 'no_match' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates enqueue failures so the rule job retries', async () => {
    const t = new PolicyTrigger(
      { enqueue: vi.fn().mockRejectedValue(new Error('redis down')) },
      { hasEnabled: vi.fn().mockResolvedValue(true) },
    );
    await expect(t.onEvaluated(ev)).rejects.toThrow('redis down');
  });
});

describe('policy job specs', () => {
  const p = { commentId, bodySha256: sha, trigger: 'ingest' as const };

  it('externalRef ignores requestedAt so duplicate deliveries dedupe', () => {
    expect(POLICY_EVALUATE_JOB.externalRef({ ...p, requestedAt: 1 })).toBe(
      POLICY_EVALUATE_JOB.externalRef({ ...p, requestedAt: 2 }),
    );
    expect(POLICY_EVALUATE_JOB.externalRef({ ...p, requestedAt: 1 })).toBe(
      `pol:${commentId}:${sha.slice(0, 32)}:ingest`,
    );
  });

  it('payload accepts ingest and run:<uuid> triggers only', () => {
    const ok = (trigger: string) =>
      POLICY_EVALUATE_JOB.payload.safeParse({ ...p, trigger, requestedAt: 1 }).success;
    expect(ok('ingest')).toBe(true);
    expect(ok(`run:${commentId}`)).toBe(true);
    expect(ok('run:x')).toBe(false);
    expect(ok(`rerun:${commentId}`)).toBe(false);
    expect(ok(`run:${commentId}x`)).toBe(false);
    expect(
      POLICY_EVALUATE_JOB.payload.safeParse({ ...p, requestedAt: 1, extra: true }).success,
    ).toBe(false);
  });

  it('declares the three policy jobs, live and preview on the policy lane', () => {
    expect(POLICY_JOB_SPECS.map((s) => s.type)).toEqual([
      'policy_evaluate',
      'policy_preview',
      'policy_run',
    ]);
    expect(POLICY_JOB_SPECS.map((s) => ('lane' in s ? s.lane : null))).toEqual([
      'policy',
      'policy',
      null,
    ]);
  });
});
