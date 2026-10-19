import { describe, expect, it } from 'vitest';
import type { ActionStep } from '@feedbouncer/actions';
import { MAX_RULES_PER_BRAND } from './store.js';
import { ruleDiff, validateRuleProposal, type RuleSnapshot } from './proposal.js';
import type { RuleRecord } from './types.js';

const kw = (...terms: string[]) => ({ type: 'keyword', terms, match: 'whole_word' });
const hide: ActionStep[] = [{ type: 'hide' }];
let n = 0;
const rec = (over: Partial<RuleRecord> = {}): RuleRecord => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  name: 'Spam',
  conditions: kw('crypto giveaway'),
  action: 'hide',
  actions: hide,
  mode: 'enforce',
  priority: n * 10,
  enabled: true,
  createdAt: new Date(0),
  ...over,
});
const valid = { name: 'New', conditions: kw('free money'), actions: hide };
const existing = rec();

describe('validateRuleProposal create', () => {
  it('accepts a valid rule with defaults applied', () => {
    expect(validateRuleProposal({ operation: 'create', rule: valid }, [])).toEqual({
      ok: true,
      before: null,
      after: { ...valid, mode: 'suggest', enabled: true },
      warnings: [],
    });
  });
  it('rejects invalid input', () => {
    expect(validateRuleProposal({ operation: 'create', rule: { name: '' } }, [])).toMatchObject({
      ok: false,
      reason: 'invalid_rule',
    });
  });
  it('rejects an action that does not fit the conditions', () => {
    const rule = {
      ...valid,
      conditions: {
        type: 'author',
        list: 'allow',
        platform: 'instagram',
        entries: [{ externalId: '1' }],
      },
    };
    expect(validateRuleProposal({ operation: 'create', rule }, [])).toMatchObject({
      reason: 'invalid_rule',
    });
  });
  it.each([
    { type: 'delete', confirmIrreversible: true },
    { type: 'ban', confirmHardToReverse: true },
  ])('rejects %j steps', (step) => {
    expect(
      validateRuleProposal({ operation: 'create', rule: { ...valid, actions: [step] } }, []),
    ).toMatchObject({ ok: false, reason: 'step_not_allowed_via_api' });
  });
  it('rejects overbroad rules', () => {
    const rule = { ...valid, conditions: { type: 'regex', patterns: ['.*'] } };
    expect(validateRuleProposal({ operation: 'create', rule }, [])).toMatchObject({
      reason: 'matches_everything',
    });
  });
  it('rejects duplicates and conflicts, ignoring key order', () => {
    const dup = {
      ...valid,
      conditions: { match: 'whole_word', terms: ['crypto giveaway'], type: 'keyword' },
    };
    expect(validateRuleProposal({ operation: 'create', rule: dup }, [existing])).toMatchObject({
      reason: 'duplicate_of_rule',
      ruleId: existing.id,
    });
    const conflict = { ...dup, actions: [{ type: 'flag_for_review' }] };
    expect(validateRuleProposal({ operation: 'create', rule: conflict }, [existing])).toMatchObject(
      {
        reason: 'conflicts_with_rule',
        ruleId: existing.id,
      },
    );
  });
  it('rejects when the brand is at the rule limit', () => {
    const all = Array.from({ length: MAX_RULES_PER_BRAND }, () => rec());
    expect(validateRuleProposal({ operation: 'create', rule: valid }, all)).toMatchObject({
      reason: 'rule_limit_reached',
    });
  });
  it('warns when an earlier rule shadows the candidate', () => {
    const broad = rec({ name: 'Broad', conditions: { ...kw('crypto'), match: 'contains' } });
    const rule = { ...valid, conditions: kw('crypto giveaway') };
    const r = validateRuleProposal({ operation: 'create', rule }, [broad]);
    expect(r.ok && r.warnings).toEqual([expect.stringContaining('Broad')]);
  });
  it('warns when the rule can never match', () => {
    const r = validateRuleProposal(
      { operation: 'create', rule: { ...valid, conditions: { type: 'keyword', terms: [] } } },
      [],
    );
    expect(r.ok && r.warnings).toEqual([expect.stringContaining('never match')]);
  });
});

describe('disabled results', () => {
  const overbroad = { type: 'regex', patterns: ['.*'] };
  it('allows creating a disabled overbroad rule', () => {
    const rule = { ...valid, conditions: overbroad, enabled: false };
    expect(validateRuleProposal({ operation: 'create', rule }, [])).toMatchObject({ ok: true });
  });
  it('allows disabling an overbroad rule', () => {
    const bad = rec({ conditions: overbroad });
    expect(
      validateRuleProposal({ operation: 'update', ruleId: bad.id, patch: { enabled: false } }, [
        bad,
      ]),
    ).toMatchObject({ ok: true });
  });
  it('allows disabling a duplicate rule', () => {
    const twin = rec();
    expect(
      validateRuleProposal({ operation: 'update', ruleId: twin.id, patch: { enabled: false } }, [
        existing,
        twin,
      ]),
    ).toMatchObject({ ok: true });
  });
});

describe('duplicate detection', () => {
  it('ignores the order of list entries', () => {
    const a = rec({ conditions: kw('alpha', 'beta') });
    const rule = { ...valid, conditions: kw('beta', 'alpha') };
    expect(validateRuleProposal({ operation: 'create', rule }, [a])).toMatchObject({
      reason: 'duplicate_of_rule',
    });
  });
  it('prefers a duplicate over a conflict', () => {
    const conflict = rec({ actions: [{ type: 'flag_for_review' }] });
    const dup = rec();
    const rule = { ...valid, conditions: existing.conditions };
    expect(validateRuleProposal({ operation: 'create', rule }, [conflict, dup])).toMatchObject({
      reason: 'duplicate_of_rule',
      ruleId: dup.id,
    });
  });
});

describe('validateRuleProposal update and archive', () => {
  it('rejects unknown rules', () => {
    expect(
      validateRuleProposal({ operation: 'update', ruleId: 'nope', patch: { enabled: false } }, [
        existing,
      ]),
    ).toMatchObject({ ok: false, reason: 'unknown_rule' });
    expect(
      validateRuleProposal({ operation: 'archive', ruleId: 'nope' }, [existing]),
    ).toMatchObject({
      reason: 'unknown_rule',
    });
  });
  it('rejects an invalid patch', () => {
    expect(
      validateRuleProposal({ operation: 'update', ruleId: existing.id, patch: {} }, [existing]),
    ).toMatchObject({ reason: 'invalid_rule' });
  });
  it('returns before and after for a patch', () => {
    const r = validateRuleProposal(
      { operation: 'update', ruleId: existing.id, patch: { enabled: false } },
      [existing],
    );
    expect(r).toMatchObject({
      ok: true,
      before: { name: 'Spam', enabled: true },
      after: { name: 'Spam', enabled: false, mode: 'enforce' },
    });
  });
  it('rejects a patch that changes nothing', () => {
    expect(
      validateRuleProposal(
        { operation: 'update', ruleId: existing.id, patch: { name: 'Spam', enabled: true } },
        [existing],
      ),
    ).toMatchObject({ reason: 'no_change' });
  });
  it('does not treat the updated rule as its own duplicate', () => {
    expect(
      validateRuleProposal(
        { operation: 'update', ruleId: existing.id, patch: { name: 'Renamed' } },
        [existing],
      ),
    ).toMatchObject({ ok: true });
  });
  it('rejects blocked steps on update', () => {
    expect(
      validateRuleProposal(
        {
          operation: 'update',
          ruleId: existing.id,
          patch: { actions: [{ type: 'delete', confirmIrreversible: true }] },
        },
        [existing],
      ),
    ).toMatchObject({ reason: 'step_not_allowed_via_api' });
  });
  it('archives with a null after', () => {
    const r = validateRuleProposal({ operation: 'archive', ruleId: existing.id }, [existing]);
    expect(r).toMatchObject({ ok: true, after: null, before: { name: 'Spam' } });
  });
});

describe('ruleDiff', () => {
  const before: RuleSnapshot = {
    name: 'a',
    conditions: kw('x') as never,
    actions: hide,
    mode: 'enforce',
    enabled: true,
  };
  it('lists changed fields only', () => {
    expect(ruleDiff(before, { ...before, enabled: false })).toEqual([
      { field: 'enabled', before: true, after: false },
    ]);
  });
  it('treats a missing side as all fields', () => {
    expect(ruleDiff(null, before).map((d) => d.field)).toEqual([
      'name',
      'conditions',
      'actions',
      'mode',
      'enabled',
    ]);
    expect(ruleDiff(before, null)).toHaveLength(5);
  });
});
