import { describe, expect, it, vi } from 'vitest';
import { prepareInput, UNKNOWN_USAGE } from '@feedbouncer/ai';
import { askPolicies, decideAnswer, runPolicyCheck } from './check.js';
import type { PolicyEvaluator } from './evaluator.js';
import type { ActivePolicy } from './types.js';

const pol = (n: number): ActivePolicy => ({
  policyId: `p${n}`,
  revisionId: `r${n}`,
  revision: 1,
  name: `Policy ${n}`,
  text: 'some policy text',
  action: 'hide',
});
const fake = (evaluate: PolicyEvaluator['evaluate']): PolicyEvaluator => ({
  enabled: true,
  id: 'fake',
  model: 'fake-1',
  evaluate,
});
const signal = new AbortController().signal;
const plain = { moderatorActed: async () => false };

describe('runPolicyCheck', () => {
  it('makes no call for empty input and matches nothing', async () => {
    const evaluate = vi.fn();
    const r = await runPolicyCheck(fake(evaluate), prepareInput(''), [pol(1)], signal, plain);
    expect(evaluate).not.toHaveBeenCalled();
    expect(r.decision.outcome).toBeNull();
    expect(r.provider).toBe('builtin');
    expect(r.model).toBe('empty-input');
    expect(r.usage).toBeNull();
  });
  it('keys the policies in order and decides on the verdicts', async () => {
    const evaluate = vi.fn<PolicyEvaluator['evaluate']>(async () => ({
      verdicts: { p1: 'no_match', p2: 'clear_match' },
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: null },
    }));
    const input = prepareInput('a comment that breaks the second policy');
    const r = await runPolicyCheck(fake(evaluate), input, [pol(1), pol(2)], signal, plain);
    expect(evaluate).toHaveBeenCalledWith(
      input,
      [
        { key: 'p1', text: 'some policy text' },
        { key: 'p2', text: 'some policy text' },
      ],
      signal,
    );
    expect(r.decision.winner?.revisionId).toBe('r2');
    expect(r).toMatchObject({ provider: 'fake', model: 'fake-1' });
  });
  it('lets an evaluator failure propagate', async () => {
    const boom = new Error('boom');
    const evaluator = fake(async () => {
      throw boom;
    });
    await expect(
      runPolicyCheck(evaluator, prepareInput('some words here'), [pol(1)], signal, plain),
    ).rejects.toBe(boom);
  });
  it('downgrades the winner when a moderator already acted', async () => {
    const evaluate = vi.fn<PolicyEvaluator['evaluate']>(async () => ({
      verdicts: { p1: 'clear_match' },
      usage: UNKNOWN_USAGE,
    }));
    const r = await runPolicyCheck(
      fake(evaluate),
      prepareInput('some words here'),
      [pol(1)],
      signal,
      { moderatorActed: async () => true },
    );
    expect(r.decision.winner?.downgrade).toBe('moderator_acted');
  });
  it('reads whether a moderator acted only after the evaluator answered', async () => {
    const order: string[] = [];
    const evaluator = fake(async () => {
      order.push('evaluate');
      return { verdicts: { p1: 'clear_match' }, usage: UNKNOWN_USAGE };
    });
    await runPolicyCheck(evaluator, prepareInput('some words here'), [pol(1)], signal, {
      moderatorActed: async () => {
        order.push('lookup');
        return false;
      },
    });
    expect(order).toEqual(['evaluate', 'lookup']);
  });
});

describe('askPolicies and decideAnswer', () => {
  it('asks without reading whether a moderator acted, and decides on the given flag', async () => {
    const evaluate = vi.fn<PolicyEvaluator['evaluate']>(async () => ({
      verdicts: { p1: 'clear_match' },
      usage: UNKNOWN_USAGE,
    }));
    const input = prepareInput('some words here');
    const answer = await askPolicies(fake(evaluate), input, [pol(1)], signal);
    expect(decideAnswer([pol(1)], answer, input, false).winner?.downgrade).toBeNull();
    expect(decideAnswer([pol(1)], answer, input, true).winner?.downgrade).toBe('moderator_acted');
  });
});
