import type { ActionStepObserver } from '@feedbouncer/actions';
import type { Platform } from '@feedbouncer/connectors';
import { createLogger } from '@feedbouncer/service-runtime';
import { describe, expect, it } from 'vitest';
import type { PgEvaluationStore } from './evaluations.js';
import { unsupportedReviewReason } from './fallback.js';
import { RuleStepFallback } from './step-fallback.js';

type Settled = Parameters<ActionStepObserver['onStepSettled']>[0];

const quiet = createLogger('rules-fallback-test', 'error', () => {});

function world(platform: Platform) {
  const recorded: { code: string; reason: string }[] = [];
  const evaluations = {
    loadForFallback: async () => ({
      ruleId: 'r1',
      ruleName: 'No spam',
      outcome: 'remove' as const,
      commentId: 'c1',
      platform,
    }),
    recordFallback: async (_s: unknown, _id: string, code: string, reason: string) => {
      recorded.push({ code, reason });
      return true;
    },
  } as unknown as PgEvaluationStore;
  return { recorded, fallback: new RuleStepFallback({ evaluations, log: quiet }) };
}

const settled = (o: Partial<Settled>): Settled => ({
  scope: { organizationId: 'o', brandId: 'b', connectionId: 'c' },
  runId: 'run',
  stepId: 'step',
  ruleId: 'r1',
  evaluationId: 'e1',
  commentId: 'c1',
  type: 'hide',
  status: 'failed',
  reason: null,
  ...o,
});

describe('unsupportedReviewReason', () => {
  it('names the platform and step, or the missing scopes', () => {
    expect(
      unsupportedReviewReason('tiktok', settled({ type: 'delete', status: 'not_supported' })),
    ).toBe('action_not_supported:tiktok:delete');
    expect(
      unsupportedReviewReason(
        'tiktok',
        settled({ reason: 'missing_permission', missingScopes: ['comment.list.manage'] }),
      ),
    ).toBe('missing_permission:comment.list.manage');
    expect(unsupportedReviewReason('tiktok', settled({ reason: 'missing_permission' }))).toBe(
      'missing_permission',
    );
    expect(unsupportedReviewReason('tiktok', settled({ reason: 'rate_limited' }))).toBeNull();
    expect(unsupportedReviewReason('tiktok', settled({ status: 'succeeded' }))).toBeNull();
  });
});

describe('RuleStepFallback', () => {
  it('a delete step on a platform without delete flags the comment for review with action_not_supported:tiktok:delete and performs no other action', async () => {
    const w = world('tiktok');
    await w.fallback.onStepSettled(
      settled({ type: 'delete', status: 'not_supported', reason: 'unsupported' }),
    );
    expect(w.recorded).toHaveLength(1);
    expect(w.recorded[0]!.code).toBe('unsupported');
    expect(w.recorded[0]!.reason).toContain('(action_not_supported:tiktok:delete)');
    expect(w.recorded[0]!.reason).toContain('wanted to delete');
    expect(w.recorded[0]!.reason).not.toContain('hide');
  });

  it('a hide step without comment.list.manage flags for review with missing_permission:comment.list.manage', async () => {
    const w = world('tiktok');
    await w.fallback.onStepSettled(
      settled({ reason: 'missing_permission', missingScopes: ['comment.list.manage'] }),
    );
    expect(w.recorded).toHaveLength(1);
    expect(w.recorded[0]!.code).toBe('missing_permission');
    expect(w.recorded[0]!.reason).toContain('(missing_permission:comment.list.manage)');
  });

  it('an unsupported or unpermitted reply or ban step also flags for review, on every platform', async () => {
    const w = world('instagram');
    await w.fallback.onStepSettled(settled({ type: 'ban', status: 'not_supported' }));
    await w.fallback.onStepSettled(
      settled({
        type: 'private_reply',
        reason: 'missing_permission',
        missingScopes: ['instagram_manage_messages'],
      }),
    );
    expect(w.recorded.map((r) => r.code)).toEqual(['unsupported', 'missing_permission']);
    expect(w.recorded[0]!.reason).toContain('(action_not_supported:instagram:ban)');
    expect(w.recorded[1]!.reason).toContain('(missing_permission:instagram_manage_messages)');
  });
});
