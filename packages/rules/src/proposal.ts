import type { ActionStep } from '@feedbouncer/actions';
import {
  checkActionForConditions,
  ruleConditionsSchema,
  ruleInputSchema,
  rulePatchSchema,
  type RuleConditions,
} from './conditions.js';
import { checkOverbroad } from './overbroad.js';
import { analyzeRules } from './shadowing.js';
import { MAX_RULES_PER_BRAND } from './store.js';
import type { RuleMode, RuleRecord } from './types.js';

export type RuleProposalInput =
  | { operation: 'create'; rule: unknown }
  | { operation: 'update'; ruleId: string; patch: unknown }
  | { operation: 'archive'; ruleId: string };

export type ProposalRejection =
  | 'invalid_rule'
  | 'unknown_rule'
  | 'matches_everything'
  | 'duplicate_of_rule'
  | 'conflicts_with_rule'
  | 'step_not_allowed_via_api'
  | 'rule_limit_reached'
  | 'no_change';

export interface RuleSnapshot {
  name: string;
  conditions: RuleConditions;
  actions: ActionStep[];
  mode: RuleMode;
  enabled: boolean;
}

export type ProposalResult =
  | { ok: true; after: RuleSnapshot | null; before: RuleSnapshot | null; warnings: string[] }
  | { ok: false; reason: ProposalRejection; message: string; ruleId?: string };

const FIELDS = ['name', 'conditions', 'actions', 'mode', 'enabled'] as const;
const BLOCKED_STEPS = new Set(['delete', 'ban']);

const reject = (reason: ProposalRejection, message: string, ruleId?: string): ProposalResult => ({
  ok: false,
  reason,
  message,
  ...(ruleId === undefined ? {} : { ruleId }),
});

/** JSON with object keys sorted, so equal values compare equal regardless of key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

const snapshotOf = (r: RuleRecord): RuleSnapshot => {
  const parsed = ruleConditionsSchema.safeParse(r.conditions);
  return {
    name: r.name,
    conditions: parsed.success ? parsed.data : (r.conditions as RuleConditions),
    actions: r.actions,
    mode: r.mode,
    enabled: r.enabled,
  };
};

export function ruleDiff(
  before: RuleSnapshot | null,
  after: RuleSnapshot | null,
): { field: keyof RuleSnapshot; before: unknown; after: unknown }[] {
  return FIELDS.flatMap((field) => {
    const b: unknown = before?.[field];
    const a: unknown = after?.[field];
    return canonical(b) === canonical(a) ? [] : [{ field, before: b, after: a }];
  });
}

function warningsFor(
  current: readonly RuleRecord[],
  candidate: RuleSnapshot,
  replacing: RuleRecord | undefined,
): string[] {
  const id = replacing?.id ?? 'candidate';
  const stand: RuleRecord = {
    id,
    name: candidate.name,
    conditions: candidate.conditions,
    action: replacing?.action ?? 'flag',
    actions: candidate.actions,
    mode: candidate.mode,
    enabled: candidate.enabled,
    priority: replacing?.priority ?? Math.max(0, ...current.map((r) => r.priority)) + 1,
    createdAt: replacing?.createdAt ?? new Date(),
  };
  const rules = replacing ? current.map((r) => (r.id === id ? stand : r)) : [...current, stand];
  const w = analyzeRules(rules).get(id);
  const warnings: string[] = [];
  const shadow = w?.shadowedBy && current.find((r) => r.id === w.shadowedBy);
  if (shadow) warnings.push(`Shadowed by rule "${shadow.name}"; it may never decide a comment.`);
  if (w?.neverMatches) warnings.push('This rule can never match a comment.');
  return warnings;
}

export function validateRuleProposal(
  input: RuleProposalInput,
  current: readonly RuleRecord[],
): ProposalResult {
  let target: RuleRecord | undefined;
  if (input.operation !== 'create') {
    target = current.find((r) => r.id === input.ruleId);
    if (!target) return reject('unknown_rule', 'No such rule.');
    if (input.operation === 'archive')
      return { ok: true, before: snapshotOf(target), after: null, warnings: [] };
  } else if (current.length >= MAX_RULES_PER_BRAND) {
    return reject('rule_limit_reached', `A brand can have at most ${MAX_RULES_PER_BRAND} rules.`);
  }

  const before = target ? snapshotOf(target) : null;
  let after: RuleSnapshot;
  if (input.operation === 'create') {
    const parsed = ruleInputSchema.safeParse(input.rule);
    if (!parsed.success)
      return reject('invalid_rule', parsed.error.issues[0]?.message ?? 'Invalid rule.');
    after = parsed.data;
  } else {
    const patch = rulePatchSchema.safeParse(input.patch);
    if (!patch.success)
      return reject('invalid_rule', patch.error.issues[0]?.message ?? 'Invalid patch.');
    const { name, conditions, actions, mode, enabled } = patch.data;
    after = {
      name: name ?? before!.name,
      conditions: conditions ?? before!.conditions,
      actions: actions ?? before!.actions,
      mode: mode ?? before!.mode,
      enabled: enabled ?? before!.enabled,
    };
  }

  const actionError = checkActionForConditions(after.conditions, after.actions);
  if (actionError) return reject('invalid_rule', actionError);
  if (after.actions.some((s) => BLOCKED_STEPS.has(s.type)))
    return reject(
      'step_not_allowed_via_api',
      'Delete and ban steps cannot be set through the API.',
    );
  if (before && ruleDiff(before, after).length === 0)
    return reject('no_change', 'The update does not change the rule.');
  if (checkOverbroad(after.conditions))
    return reject('matches_everything', 'These conditions would match every comment.');

  const conditions = canonical(after.conditions);
  const steps = canonical(after.actions);
  for (const r of current) {
    if (r.id === target?.id || canonical(snapshotOf(r).conditions) !== conditions) continue;
    return canonical(r.actions) === steps
      ? reject('duplicate_of_rule', `Same conditions and actions as "${r.name}".`, r.id)
      : reject(
          'conflicts_with_rule',
          `Same conditions as "${r.name}" with different actions.`,
          r.id,
        );
  }

  return { ok: true, before, after, warnings: warningsFor(current, after, target) };
}
