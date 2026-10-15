import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RuleTrigger } from './trigger.js';
import { RULE_EVALUATE_JOB, RuleEvaluatePayload } from './jobs/specs.js';

const scope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  brandId: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
};
const commentId = '00000000-0000-4000-8000-000000000004';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('RuleTrigger', () => {
  it('enqueues one rule_evaluate job for the connection with the body sha and trigger ingest', async () => {
    const enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }) as const);
    await new RuleTrigger({ enqueue }).onApplied({
      scope,
      platform: 'instagram',
      commentId,
      body: 'Buy now at example.com',
      outcome: 'created',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      scope,
      platform: 'instagram',
      type: 'rule_evaluate',
      payload: { commentId, bodySha256: sha('Buy now at example.com'), trigger: 'ingest' },
    });
    const payload = RuleEvaluatePayload.parse(
      (enqueue.mock.calls[0] as unknown as [{ payload: unknown }])[0].payload,
    );
    expect(RULE_EVALUATE_JOB.externalRef(payload)).toBe(
      `${commentId}:${sha('Buy now at example.com').slice(0, 32)}`,
    );
  });

  it('does not depend on the created/updated outcome (redelivery is idempotent)', async () => {
    const enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }) as const);
    const t = new RuleTrigger({ enqueue });
    await t.onApplied({ scope, platform: 'facebook', commentId, body: 'x', outcome: 'created' });
    await t.onApplied({ scope, platform: 'facebook', commentId, body: 'x', outcome: 'updated' });
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
  });

  it('hashes the stored form of the body (NUL replaced as the comment store does)', async () => {
    const enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }) as const);
    await new RuleTrigger({ enqueue }).onApplied({
      scope,
      platform: 'facebook',
      commentId,
      body: 'a\u0000b',
      outcome: 'created',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ bodySha256: sha('a�b') }),
      }),
    );
  });

  it('propagates an enqueue failure so the hook is redelivered', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(
      new RuleTrigger({ enqueue }).onApplied({
        scope,
        platform: 'facebook',
        commentId,
        body: 'x',
        outcome: 'created',
      }),
    ).rejects.toThrow('redis down');
  });
});

describe('RuleEvaluatePayload', () => {
  const base = { commentId, bodySha256: sha('x') };
  it('derives one job reference per comment and body version', () => {
    const p = RuleEvaluatePayload.parse({ ...base, trigger: 'ingest' });
    expect(RULE_EVALUATE_JOB.externalRef(p)).toBe(`${commentId}:${base.bodySha256.slice(0, 32)}`);
  });
  it('rejects the removed history trigger', () => {
    expect(RuleEvaluatePayload.safeParse({ ...base, trigger: 'history' }).success).toBe(false);
  });
  it('rejects a malformed sha and unknown keys', () => {
    expect(
      RuleEvaluatePayload.safeParse({ commentId, bodySha256: 'ABC', trigger: 'ingest' }).success,
    ).toBe(false);
    expect(RuleEvaluatePayload.safeParse({ ...base, trigger: 'ingest', x: 1 }).success).toBe(false);
  });
});
