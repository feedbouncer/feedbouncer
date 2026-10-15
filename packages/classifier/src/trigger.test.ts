import { describe, expect, it, vi } from 'vitest';
import { CLASSIFY_JOB } from './jobs/specs.js';
import { ClassifierTrigger } from './trigger.js';

const scope = { organizationId: 'o', brandId: 'b', connectionId: 'c' };
const sha = 'a'.repeat(64);

describe('ClassifierTrigger', () => {
  it('enqueues comment_classify for no_match and decided evaluations', async () => {
    const producer = { enqueue: vi.fn().mockResolvedValue({ status: 'enqueued' }) };
    const t = new ClassifierTrigger(producer, { now: () => 1_700_000_000_000 });
    await t.onEvaluated({
      scope,
      platform: 'facebook',
      commentId: '11111111-1111-4111-8111-111111111111',
      bodySha256: sha,
      evaluationId: 'e',
      status: 'decided',
    });
    expect(producer.enqueue).toHaveBeenCalledWith({
      scope,
      platform: 'facebook',
      type: 'comment_classify',
      payload: {
        commentId: '11111111-1111-4111-8111-111111111111',
        bodySha256: sha,
        trigger: 'ingest',
        requestedAt: 1_700_000_000_000,
      },
    });
  });
  it('externalRef ignores requestedAt so duplicate deliveries dedupe', () => {
    const p = {
      commentId: '11111111-1111-4111-8111-111111111111',
      bodySha256: sha,
      trigger: 'ingest' as const,
    };
    expect(CLASSIFY_JOB.externalRef({ ...p, requestedAt: 1 })).toBe(
      CLASSIFY_JOB.externalRef({ ...p, requestedAt: 2 }),
    );
    expect(CLASSIFY_JOB.externalRef({ ...p, requestedAt: 1 })).toBe(
      `clf:${p.commentId}:${sha.slice(0, 32)}:ingest`,
    );
  });
  it('payload rejects foreign trigger keys', () => {
    expect(
      CLASSIFY_JOB.payload.safeParse({
        commentId: '11111111-1111-4111-8111-111111111111',
        bodySha256: sha,
        trigger: 'rerun:x',
        requestedAt: 1,
      }).success,
    ).toBe(false);
  });
});
