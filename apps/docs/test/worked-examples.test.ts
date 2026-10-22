import { describe, expect, it } from 'vitest';
import { deriveOutcome } from '@feedbouncer/actions';
import { compileRuleSet, evaluate, ruleInputSchema } from '@feedbouncer/rules';
import { exampleFiles, loadExamples, ruleInput, toFacts, toRecords } from './lib/examples';

const examples = loadExamples();

describe('worked examples', () => {
  it('has at least five worked examples covering the required cases', () => {
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const c of ['spam_links', 'repeated_comments', 'abusive_language'])
      expect(examples.some((e) => e.case === c)).toBe(true);
  });

  it('gives every example a unique id and a file named after it', () => {
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
    expect(examples.map((e) => `${e.id}.json`)).toEqual(exampleFiles());
  });

  it.each(examples)('$id: every rule passes ruleInputSchema', (ex) => {
    for (const r of ex.rules) expect(ruleInputSchema.safeParse(ruleInput(r)).success).toBe(true);
  });

  it.each(examples)('$id: the engine produces the documented decision', (ex) => {
    const set = compileRuleSet(toRecords(ex), { ownDomains: ex.brand.ownDomains }, 'docs');
    expect(set.invalid).toEqual([]);
    const v = evaluate(set, toFacts(ex.comment), { collectAlsoMatched: true });
    expect(v.decided?.ruleName ?? null).toBe(ex.expected.decidedRule);
    expect(v.decided ? deriveOutcome(v.decided.actions) : 'none').toBe(ex.expected.outcome);
    expect(v.decided?.actions.map((s) => s.type) ?? []).toEqual(ex.expected.steps);
    expect(v.suggestions.map((s) => s.ruleName)).toEqual(ex.expected.suggestions);
    expect(v.alsoMatched.map((s) => s.ruleName)).toEqual(ex.expected.alsoMatched);
  });
});
