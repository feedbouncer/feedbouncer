import { describe, expect, it } from 'vitest';
import { compileRuleSet, evaluate } from './engine.js';
import type { ActionStep } from '@feedbouncer/actions';
import { ruleApplies, type CommentFacts, type RuleAction, type RuleRecord } from './types.js';

const STEPS: Record<RuleAction, ActionStep[]> = {
  approve: [],
  flag: [{ type: 'flag_for_review' }],
  hide: [{ type: 'hide' }],
  remove: [{ type: 'delete', confirmIrreversible: true }],
};

let n = 0;
const rec = (conditions: unknown, over: Partial<RuleRecord> = {}): RuleRecord => ({
  actions: STEPS[over.action ?? 'hide'],
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  name: `r${n}`,
  conditions,
  action: 'hide',
  mode: 'enforce',
  priority: n * 10,
  enabled: true,
  appliesTo: 'all',
  createdAt: new Date(0),
  ...over,
});
const facts = (body: string, over: Partial<CommentFacts> = {}): CommentFacts => ({
  body,
  platform: 'instagram',
  authorExternalId: '42',
  authorName: 'someone',
  origin: 'organic',
  ...over,
});
const ctx = { ownDomains: ['example.com'] };

describe('evaluate', () => {
  it('collectAlsoMatched lists later enforce matches without changing decided', () => {
    const a = rec({ type: 'keyword', terms: ['spam'] }, { priority: 10 });
    const b = rec({ type: 'keyword', terms: ['spam'] }, { priority: 20, action: 'remove' });
    const c = rec({ type: 'keyword', terms: ['spam'] }, { priority: 30, mode: 'suggest' });
    const d = rec({ type: 'keyword', terms: ['other'] }, { priority: 40 });
    const set = compileRuleSet([a, b, c, d], ctx, 'v');
    const plain = evaluate(set, facts('spam'));
    const v = evaluate(set, facts('spam'), { collectAlsoMatched: true });
    expect(v.decided).toEqual(plain.decided);
    expect(v.alsoMatched.map((h) => h.ruleId)).toEqual([b.id]);
    expect(v.suggestions).toEqual([]);
  });
  it('off by default: alsoMatched is empty and later rules are not evaluated', () => {
    const a = rec({ type: 'keyword', terms: ['spam'] }, { priority: 10 });
    const b = rec({ type: 'keyword', terms: ['spam'] }, { priority: 20 });
    const set = compileRuleSet([a, b], ctx, 'v');
    const calls: string[] = [];
    const spied = {
      ...set,
      rules: set.rules.map((r) => ({
        ...r,
        matcher: ((...args: Parameters<typeof r.matcher>) => {
          calls.push(r.id);
          return r.matcher(...args);
        }) as typeof r.matcher,
      })),
    };
    const v = evaluate(spied, facts('spam'));
    expect(v.alsoMatched).toEqual([]);
    expect(calls).toEqual([a.id]);
  });

  it('first enforcing match wins, in priority order', () => {
    const a = rec({ type: 'keyword', terms: ['spam'] }, { action: 'flag', priority: 20 });
    const b = rec({ type: 'keyword', terms: ['spam'] }, { action: 'remove', priority: 10 });
    const v = evaluate(compileRuleSet([a, b], ctx, 'v1'), facts('spam here'));
    expect(v.decided).toMatchObject({ ruleId: b.id, action: 'remove' });
  });
  it('the decision carries the rule steps', () => {
    const r = rec(
      { type: 'keyword', terms: ['spam'] },
      { actions: [{ type: 'flag_for_review' }, { type: 'hide' }] },
    );
    expect(evaluate(compileRuleSet([r], ctx, 'v'), facts('spam')).decided?.actions).toEqual(
      r.actions,
    );
  });
  it('a block list without a moderating step is invalid', () => {
    const r = rec(
      { type: 'author', list: 'block', platform: 'instagram', entries: [{ externalId: '42' }] },
      { actions: [{ type: 'auto_reply', template: 'Hi' }] },
    );
    expect(compileRuleSet([r], ctx, 'v').invalid).toEqual([
      { ruleId: r.id, reason: 'invalid_conditions' },
    ]);
  });
  it('an allow rule above a block rule exempts the comment', () => {
    const allow = rec({ type: 'keyword', terms: ['giveaway winner'] }, { action: 'approve' });
    const block = rec({ type: 'keyword', terms: ['giveaway'] }, { action: 'hide' });
    expect(
      evaluate(compileRuleSet([allow, block], ctx, 'v'), facts('Giveaway winner announced'))
        .decided,
    ).toMatchObject({ ruleId: allow.id, action: 'approve' });
  });
  it('dry-run matches are recorded as suggestions and evaluation continues', () => {
    const dry = rec({ type: 'keyword', terms: ['spam'] }, { mode: 'suggest', action: 'remove' });
    const live = rec({ type: 'keyword', terms: ['spam'] }, { action: 'flag' });
    const v = evaluate(compileRuleSet([dry, live], ctx, 'v'), facts('spam'));
    expect(v.suggestions.map((s) => s.ruleId)).toEqual([dry.id]);
    expect(v.decided?.ruleId).toBe(live.id);
  });
  it('trusted-author rules run first regardless of priority', () => {
    const block = rec({ type: 'keyword', terms: ['spam'] }, { priority: 0 });
    const trusted = rec(
      { type: 'author', list: 'trusted', platform: 'instagram', entries: [{ externalId: '42' }] },
      { action: 'approve', priority: 9999 },
    );
    expect(
      evaluate(compileRuleSet([block, trusted], ctx, 'v'), facts('spam')).decided?.ruleId,
    ).toBe(trusted.id);
  });
  it('disabled rules are ignored', () => {
    const r = rec({ type: 'keyword', terms: ['spam'] }, { enabled: false });
    expect(evaluate(compileRuleSet([r], ctx, 'v'), facts('spam')).decided).toBeNull();
  });
  it('invalid stored conditions are skipped and reported, others still run', () => {
    const bad = rec({ links: ['bit.ly'] });
    const good = rec({ type: 'keyword', terms: ['spam'] });
    const set = compileRuleSet([bad, good], ctx, 'v');
    expect(set.invalid).toEqual([{ ruleId: bad.id, reason: 'invalid_conditions' }]);
    expect(evaluate(set, facts('spam')).decided?.ruleId).toBe(good.id);
  });
  it('a rule that times out is skipped and logged in the trace; later rules still decide', () => {
    let t = 0;
    const slow = rec({ type: 'regex', patterns: ['a', 'b'] });
    const next = rec({ type: 'keyword', terms: ['zzz'] });
    const v = evaluate(compileRuleSet([slow, next], ctx, 'v'), facts('zzz'), {
      now: () => (t += 100),
      ruleBudgetMs: 50,
    });
    expect(v.trace[0]).toMatchObject({ ruleId: slow.id, result: 'skipped', skipReason: 'timeout' });
    expect(v.decided?.ruleId).toBe(next.id);
  });
  it('a matcher that throws is skipped with skipReason error and reported via onRuleError', () => {
    const r = rec({ type: 'keyword', terms: ['x'] });
    const set = compileRuleSet([r], ctx, 'v');
    set.rules[0]!.matcher = () => {
      throw new Error('boom');
    };
    const errs: string[] = [];
    const v = evaluate(set, facts('x'), { onRuleError: (id) => errs.push(id) });
    expect(v.trace[0]).toMatchObject({ result: 'skipped', skipReason: 'error' });
    expect(errs).toEqual([r.id]);
  });
  it('empty and emoji-only comments are evaluated normally', () => {
    const e = rec({ type: 'emoji', emoji: [], maxCount: 2 });
    const k = rec({ type: 'keyword', terms: [] });
    expect(evaluate(compileRuleSet([k, e], ctx, 'v'), facts('')).decided).toBeNull();
    expect(evaluate(compileRuleSet([k, e], ctx, 'v'), facts('🔥🔥🔥')).decided?.ruleId).toBe(e.id);
  });
  it('ties in priority break by createdAt then id (deterministic)', () => {
    const x = rec({ type: 'keyword', terms: ['a'] }, { priority: 5, createdAt: new Date(2) });
    const y = rec({ type: 'keyword', terms: ['a'] }, { priority: 5, createdAt: new Date(1) });
    expect(evaluate(compileRuleSet([x, y], ctx, 'v'), facts('a')).decided?.ruleId).toBe(y.id);
  });

  it('a rule scoped to ad does not match an organic comment and vice versa; all matches both', () => {
    const ad = rec({ type: 'keyword', terms: ['spam'] }, { appliesTo: 'ad' });
    const organic = rec({ type: 'keyword', terms: ['spam'] }, { appliesTo: 'organic' });
    const all = rec({ type: 'keyword', terms: ['spam'] }, { appliesTo: 'all' });
    const decided = (r: RuleRecord, origin: CommentFacts['origin']) =>
      evaluate(compileRuleSet([r], ctx, 'v'), facts('spam', { origin })).decided?.ruleId ?? null;
    expect(decided(ad, 'organic')).toBeNull();
    expect(decided(ad, 'ad')).toBe(ad.id);
    expect(decided(organic, 'ad')).toBeNull();
    expect(decided(organic, 'organic')).toBe(organic.id);
    expect(decided(all, 'ad')).toBe(all.id);
    expect(decided(all, 'organic')).toBe(all.id);
    const v = evaluate(compileRuleSet([ad, all], ctx, 'v'), facts('spam'));
    expect(v.decided?.ruleId).toBe(all.id);
    expect(v.trace.map((t) => t.ruleId)).toEqual([all.id]);
    expect(ruleApplies({ appliesTo: 'ad' }, { origin: 'ad' })).toBe(true);
    expect(ruleApplies({ appliesTo: 'organic' }, { origin: 'ad' })).toBe(false);
  });
  it('emoji and non-latin comments flow through rules', () => {
    const keywordRule = (term: string) => rec({ type: 'keyword', terms: [term] });
    const emojiRule = (emoji: string[]) => rec({ type: 'emoji', emoji, maxCount: null });
    const factsFor = (o: Pick<CommentFacts, 'body' | 'origin'> & Partial<CommentFacts>) =>
      facts(o.body, o);
    const run = (rules: RuleRecord[], f: CommentFacts) => {
      const v = evaluate(compileRuleSet(rules, ctx, 'v'), f);
      return { ...v, matched: v.decided !== null };
    };
    for (const body of ['🔥🔥🔥', '👨‍👩‍👧', 'مرحبا بكم', '你好世界', 'éé']) {
      const f = factsFor({ body, platform: 'tiktok', origin: 'organic' });
      expect(() => run([keywordRule('scam'), emojiRule(['🔥'])], f)).not.toThrow();
    }
    expect(
      run([keywordRule('scam')], factsFor({ body: '🔥🔥🔥', origin: 'organic' })).matched,
    ).toBe(false);
    expect(run([emojiRule(['🔥'])], factsFor({ body: '🔥🔥🔥', origin: 'organic' })).matched).toBe(
      true,
    );
  });
});
