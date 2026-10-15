import { MAX_INPUT_CHARS } from '@feedbouncer/classifier';
import type {
  Downgrade,
  FailureCode,
  PolicyAction,
  PolicyDecision,
  PolicyMatch,
  PolicyVerdict,
  SkipReason,
} from './types.js';

const VERB: Record<PolicyAction, string> = {
  flag: 'flag for review',
  hide: 'hide',
  remove: 'delete',
};
const DOWNGRADE: Record<Downgrade, string> = {
  low_confidence: 'possible match',
  low_signal: 'too little text to act on',
  moderator_acted: 'a moderator already acted on this comment',
};
const TRUNCATED = `Only the first ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters of the comment were checked.`;
const label = (m: PolicyMatch) => `“${m.name}” (revision ${m.revision})`;
const effect = (m: PolicyMatch) =>
  m.downgrade
    ? `${DOWNGRADE[m.downgrade]}, flagged for review instead of ${VERB[m.action]}`
    : VERB[m.effectiveAction];

export function describeDecision(d: PolicyDecision, o: { truncated: boolean }): string {
  if (!d.winner) return 'No policy matched.';
  const parts = [`Matched policy ${label(d.winner)}: ${effect(d.winner)}.`];
  for (const m of d.matches)
    if (m !== d.winner) parts.push(`Also matched: ${label(m)} — ${effect(m)}.`);
  if (o.truncated) parts.push(TRUNCATED);
  return parts.join(' ').slice(0, 2000);
}

export function describePreviewResult(
  m: {
    verdict: PolicyVerdict;
    action: PolicyAction;
    effectiveAction: PolicyAction;
    downgrade: Downgrade | null;
  },
  o: { truncated: boolean },
): string {
  const head = m.verdict === 'clear_match' ? 'Clear match' : 'Possible match';
  const body = m.downgrade
    ? `would ${VERB.flag} instead of ${VERB[m.action]}`
    : `would ${VERB[m.effectiveAction]}`;
  return [`${head}: ${body}.`, ...(o.truncated ? [TRUNCATED] : [])].join(' ').slice(0, 500);
}

export function describeFallback(kind: 'hide' | 'delete', code: string): string {
  return `A policy asked to ${kind} this comment, but the platform did not allow it (${code}). Flagged for review instead.`;
}

export const SKIP_TEXT: Record<SkipReason, string> = {
  deleted: 'Not checked: the comment was deleted.',
  own_account: "Not checked: the comment is from the brand's own account.",
  rules_not_evaluated: 'Not checked: the rules had not evaluated this comment.',
  rule_decided: 'Not checked: a rule already decided this comment.',
  no_enabled_policies: 'Not checked: no policy was enabled.',
  quota_exhausted:
    'Not checked: the monthly policy-check limit was reached. The comment was left unchanged.',
  policy_changed:
    'Not checked: the policy was edited, disabled or deleted after this check was requested.',
};
export const FAILURE_TEXT: Record<FailureCode, string> = {
  timeout:
    'Policy check failed: the AI provider did not answer in time. The comment was left unchanged.',
  rate_limited:
    'Policy check failed: the AI provider was rate-limiting requests. The comment was left unchanged.',
  unavailable:
    'Policy check failed: the AI provider was unavailable. The comment was left unchanged.',
  auth: 'Policy check failed: the AI provider rejected the deployment credentials. The comment was left unchanged.',
  invalid_output:
    'Policy check failed: the AI provider returned an unusable answer. The comment was left unchanged.',
  bad_request:
    'Policy check failed: the AI provider rejected the request. The comment was left unchanged.',
  disabled: 'Policy checks are turned off in this deployment. The comment was left unchanged.',
  queue_timeout:
    'Policy check failed: it waited too long in the queue. The comment was left unchanged.',
};
