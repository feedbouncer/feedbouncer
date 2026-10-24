import type { ActionStep } from '@feedbouncer/actions';
import {
  checkActionForConditions,
  ruleConditionsSchema,
  type RuleConditions,
} from './conditions.js';
import { compileAuthorRule } from './matchers/author.js';
import { compileCompetitorRule } from './matchers/competitor.js';
import { compileEmojiRule } from './matchers/emoji.js';
import { compileKeywordRule } from './matchers/keywords.js';
import { compileLinkRule } from './matchers/links.js';
import { compileRegexRule } from './matchers/regex.js';
import type { Matcher } from './matchers/types.js';
import {
  ruleApplies,
  type BrandContext,
  type CommentFacts,
  type RuleAction,
  type RuleAppliesTo,
  type RuleHit,
  type RuleKind,
  type RuleMode,
  type RuleRecord,
  type TraceEntry,
  type Verdict,
} from './types.js';
import { CommentView } from './view.js';

export const RULE_BUDGET_MS = 50;

export interface CompiledRule {
  id: string;
  name: string;
  kind: RuleKind;
  action: RuleAction;
  actions: ActionStep[];
  mode: RuleMode;
  appliesTo: RuleAppliesTo;
  pinned: boolean;
  matcher: Matcher;
}
export interface CompiledRuleSet {
  version: string;
  rules: CompiledRule[];
  invalid: { ruleId: string; reason: 'invalid_conditions' }[];
}

export interface OrderKey {
  id: string;
  priority: number;
  createdAt: Date;
  /** Trusted-author rules are evaluated before everything else. */
  pinned: boolean;
}

/** Evaluation order: pinned trusted rules first, then priority, createdAt, id. */
export function ruleOrder(a: OrderKey, b: OrderKey): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    a.priority - b.priority ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function matcherFor(c: RuleConditions, ctx: BrandContext): Matcher {
  switch (c.type) {
    case 'keyword':
      return compileKeywordRule(c);
    case 'regex':
      return compileRegexRule(c);
    case 'link_domain':
      return compileLinkRule(c, ctx);
    case 'emoji':
      return compileEmojiRule(c);
    case 'author':
      return compileAuthorRule(c);
    case 'competitor':
      return compileCompetitorRule(c);
  }
}

export function compileRuleSet(
  records: RuleRecord[],
  ctx: BrandContext,
  version: string,
): CompiledRuleSet {
  const entries = records
    .filter((r) => r.enabled)
    .map((r) => {
      const parsed = ruleConditionsSchema.safeParse(r.conditions);
      const pinned =
        parsed.success && parsed.data.type === 'author' && parsed.data.list === 'trusted';
      return {
        r,
        parsed,
        order: { id: r.id, priority: r.priority, createdAt: r.createdAt, pinned },
      };
    })
    .sort((a, b) => ruleOrder(a.order, b.order));
  const rules: CompiledRule[] = [];
  const invalid: CompiledRuleSet['invalid'] = [];
  for (const { r, parsed, order } of entries) {
    if (!parsed.success || checkActionForConditions(parsed.data, r.actions) !== null) {
      invalid.push({ ruleId: r.id, reason: 'invalid_conditions' });
      continue;
    }
    const c = parsed.data;
    let matcher: Matcher;
    try {
      matcher = matcherFor(c, ctx);
    } catch {
      invalid.push({ ruleId: r.id, reason: 'invalid_conditions' });
      continue;
    }
    rules.push({
      id: r.id,
      name: r.name,
      kind: c.type,
      action: r.action,
      actions: r.actions,
      mode: r.mode,
      appliesTo: r.appliesTo,
      pinned: order.pinned,
      matcher,
    });
  }
  return { version, rules, invalid };
}

export function evaluate(
  set: CompiledRuleSet,
  facts: CommentFacts,
  opts: {
    now?: () => number;
    ruleBudgetMs?: number;
    onRuleError?: (ruleId: string, err: unknown) => void;
    /** Keep going past the decision to list the later enforce rules that also match. */
    collectAlsoMatched?: boolean;
  } = {},
): Verdict {
  const now = opts.now ?? (() => performance.now());
  const limitMs = opts.ruleBudgetMs ?? RULE_BUDGET_MS;
  const trace: TraceEntry[] = [];
  const suggestions: RuleHit[] = [];
  const alsoMatched: RuleHit[] = [];
  let decided: RuleHit | null = null;
  const view = new CommentView(facts);
  for (const r of set.rules) {
    if ((decided && r.mode === 'suggest') || !ruleApplies(r, facts)) continue;
    let res: ReturnType<Matcher>;
    try {
      res = r.matcher(view, { now, startedAt: now(), limitMs });
    } catch (err) {
      safeReport(opts.onRuleError, r.id, err);
      trace.push({ ruleId: r.id, mode: r.mode, result: 'skipped', skipReason: 'error' });
      continue;
    }
    if (res === 'timeout') {
      trace.push({ ruleId: r.id, mode: r.mode, result: 'skipped', skipReason: 'timeout' });
      continue;
    }
    if (res === null) {
      trace.push({ ruleId: r.id, mode: r.mode, result: 'no_match' });
      continue;
    }
    trace.push({ ruleId: r.id, mode: r.mode, result: 'match', evidence: res });
    const hit: RuleHit = {
      ruleId: r.id,
      ruleName: r.name,
      kind: r.kind,
      action: r.action,
      actions: r.actions,
      evidence: res,
    };
    if (r.mode === 'suggest') {
      suggestions.push(hit);
      continue;
    }
    if (decided) {
      alsoMatched.push(hit);
      continue;
    }
    if (!opts.collectAlsoMatched) return { decided: hit, suggestions, alsoMatched, trace };
    decided = hit;
  }
  return { decided, suggestions, alsoMatched, trace };
}

function safeReport(
  cb: ((ruleId: string, err: unknown) => void) | undefined,
  ruleId: string,
  err: unknown,
): void {
  try {
    cb?.(ruleId, err);
  } catch {
    // A failing error callback must not break evaluation.
  }
}
