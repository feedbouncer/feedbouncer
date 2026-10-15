import { ACTION_SEVERITY } from '@feedbouncer/classifier';
import type {
  ActivePolicy,
  Downgrade,
  PolicyAction,
  PolicyDecision,
  PolicyMatch,
  PolicyVerdict,
} from './types.js';

const capToFlag = (a: PolicyAction): boolean => a === 'hide' || a === 'remove';

/** The one place a verdict becomes an action; live evaluation and preview both use it. */
export function effectiveAction(
  action: PolicyAction,
  verdict: PolicyVerdict,
  o: { lowSignal: boolean; moderatorActed: boolean },
): {
  confidence: 'high' | 'low';
  effectiveAction: PolicyAction;
  downgrade: Downgrade | null;
} | null {
  if (verdict === 'no_match') return null;
  const confidence = verdict === 'clear_match' ? 'high' : 'low';
  if (!capToFlag(action)) return { confidence, effectiveAction: action, downgrade: null };
  const downgrade: Downgrade | null =
    confidence === 'low'
      ? 'low_confidence'
      : o.lowSignal
        ? 'low_signal'
        : o.moderatorActed
          ? 'moderator_acted'
          : null;
  return { confidence, effectiveAction: downgrade ? 'flag' : action, downgrade };
}

/** Strictly more severe wins; on equal action a clear match outranks a downgraded possible one. */
function outranks(a: PolicyMatch, b: PolicyMatch): boolean {
  const diff = ACTION_SEVERITY[a.effectiveAction] - ACTION_SEVERITY[b.effectiveAction];
  return diff > 0 || (diff === 0 && a.confidence === 'high' && b.confidence === 'low');
}

/**
 * Callers must pass `policies` sorted by (policy created_at, id): ties between equally severe
 * matches of equal confidence go to the earliest policy in the given order.
 */
export function decidePolicies(
  policies: readonly ActivePolicy[],
  verdicts: ReadonlyMap<string, PolicyVerdict>,
  o: { lowSignal: boolean; moderatorActed: boolean },
): PolicyDecision {
  const matches: PolicyMatch[] = [];
  for (const p of policies) {
    const v = verdicts.get(p.revisionId);
    if (v === undefined) throw new Error(`missing verdict for revision ${p.revisionId}`);
    const e = effectiveAction(p.action, v, o);
    if (!e) continue;
    matches.push({
      policyId: p.policyId,
      revisionId: p.revisionId,
      revision: p.revision,
      name: p.name,
      action: p.action,
      ...e,
    });
  }
  let winner: PolicyMatch | null = null;
  for (const m of matches) {
    if (!winner || outranks(m, winner)) winner = m;
  }
  return { outcome: winner?.effectiveAction ?? null, winner, matches };
}
