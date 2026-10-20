import { describe, expect, it, vi } from 'vitest';
import { prepareInput } from '@feedbouncer/ai';
import { runPolicyCheck } from './check.js';
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
const plain = { moderatorActed: false };

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
});
