import { describe, expect, it } from 'vitest';
import { decidePolicies, effectiveAction } from './decide.js';
import type { ActivePolicy, PolicyVerdict } from './types.js';

const pol = (n: number, action: ActivePolicy['action']): ActivePolicy => ({
  policyId: `p${n}`,
  revisionId: `r${n}`,
  revision: 1,
  name: `Policy ${n}`,
  text: 'some policy text',
  action,
});
const v = (o: Record<string, PolicyVerdict>) => new Map(Object.entries(o));
const plain = { lowSignal: false, moderatorActed: false };

describe('effectiveAction', () => {
  it('clear match keeps the configured action', () => {
    expect(effectiveAction('remove', 'clear_match', plain)).toEqual({
      confidence: 'high',
      effectiveAction: 'remove',
      downgrade: null,
    });
  });
  it('possible match (low confidence) flags for review whatever the action', () => {
    expect(effectiveAction('hide', 'possible_match', plain)).toEqual({
      confidence: 'low',
      effectiveAction: 'flag',
      downgrade: 'low_confidence',
    });
    expect(effectiveAction('remove', 'possible_match', plain)?.effectiveAction).toBe('flag');
    expect(effectiveAction('flag', 'possible_match', plain)).toEqual({
      confidence: 'low',
      effectiveAction: 'flag',
      downgrade: null,
    });
  });
  it('low-signal input never hides or deletes', () => {
    expect(effectiveAction('hide', 'clear_match', { ...plain, lowSignal: true })).toEqual({
      confidence: 'high',
      effectiveAction: 'flag',
      downgrade: 'low_signal',
    });
  });
  it('a moderator action caps re-applied hides to flag', () => {
    expect(
      effectiveAction('remove', 'clear_match', { ...plain, moderatorActed: true })?.downgrade,
    ).toBe('moderator_acted');
  });
  it('no match yields null', () => {
    expect(effectiveAction('hide', 'no_match', plain)).toBeNull();
  });
});

describe('decidePolicies', () => {
  it('no matches → no outcome', () => {
    expect(decidePolicies([pol(1, 'hide')], v({ r1: 'no_match' }), plain)).toEqual({
      outcome: null,
      winner: null,
      matches: [],
    });
  });
  it('most severe action wins and every match is listed', () => {
    const d = decidePolicies(
      [pol(1, 'flag'), pol(2, 'hide'), pol(3, 'remove')],
      v({ r1: 'clear_match', r2: 'clear_match', r3: 'no_match' }),
      plain,
    );
    expect(d.outcome).toBe('hide');
    expect(d.winner?.policyId).toBe('p2');
    expect(d.matches.map((m) => m.policyId)).toEqual(['p1', 'p2']);
  });
  it('ties go to the earliest policy in the given order (deterministic)', () => {
    const a = decidePolicies(
      [pol(1, 'hide'), pol(2, 'hide')],
      v({ r1: 'clear_match', r2: 'clear_match' }),
      plain,
    );
    const b = decidePolicies(
      [pol(1, 'hide'), pol(2, 'hide')],
      v({ r2: 'clear_match', r1: 'clear_match' }),
      plain,
    );
    expect(a.winner?.policyId).toBe('p1');
    expect(b).toEqual(a);
  });
  it('a high-confidence flag and a low-confidence delete resolve to flag, winner = first flag', () => {
    const d = decidePolicies(
      [pol(1, 'remove'), pol(2, 'flag')],
      v({ r1: 'possible_match', r2: 'clear_match' }),
      plain,
    );
    expect(d.outcome).toBe('flag');
    expect(d.winner?.policyId).toBe('p1');
    expect(d.matches.find((m) => m.policyId === 'p1')?.downgrade).toBe('low_confidence');
  });
  it('throws when a verdict is missing for an active policy', () => {
    expect(() => decidePolicies([pol(1, 'hide')], v({}), plain)).toThrow(/missing verdict/);
  });
});
