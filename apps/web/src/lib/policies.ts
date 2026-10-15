import { ApiRequestError } from './api-client';
import { messageFor } from './messages';
import { ACTION_LABEL, OUTCOME_DONE, OUTCOME_VERB, type DecisionView } from './rules';

export const POLICY_ACTIONS = ['flag', 'hide', 'remove'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const MAX_POLICY_CHARS = 500;
export const MAX_NAME_CHARS = 80;

export const POLICY_ACTION_LABEL: Record<PolicyAction, string> = {
  flag: ACTION_LABEL.flag,
  hide: ACTION_LABEL.hide,
  remove: ACTION_LABEL.remove,
};

export type PolicyWarning = 'few_words' | 'vague_terms';
export type Downgrade = 'low_confidence' | 'low_signal' | 'moderator_acted';

export interface PolicyDto {
  id: string;
  name: string;
  enabled: boolean;
  text: string;
  action: PolicyAction;
  revision: number;
  revisionId: string;
  warnings: PolicyWarning[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDetailDto extends PolicyDto {
  revisions: {
    id: string;
    revision: number;
    text: string;
    action: PolicyAction;
    createdAt: string;
    createdBy: { id: string; name: string | null } | null;
  }[];
}

export interface PolicyListDto {
  policies: PolicyDto[];
  limits: { maxPolicies: number; maxEnabled: number };
  usage: { used: number; limit: number; resetsAt: string };
  evaluatorConfigured: boolean;
}

export interface PolicyMatchView {
  policyId: string;
  name: string;
  archived: boolean;
  revision: number;
  confidence: 'high' | 'low';
  action: PolicyAction;
  effectiveAction: PolicyAction;
  downgrade: Downgrade | null;
}

/** The `policy` block of a decision made by a policy. */
export interface PolicyEvidence {
  evaluationId: string;
  policyId: string;
  name: string;
  archived: boolean;
  revision: number;
  text: string;
  matches: PolicyMatchView[];
}

export interface EvaluationView {
  id: string;
  status: 'evaluated' | 'failed' | 'skipped';
  skipReason: string | null;
  failureCode: string | null;
  outcome: PolicyAction | null;
  createdAt: string;
  checkedCount: number;
  triggerKey: string;
  matches: (PolicyMatchView & { text: string })[];
}

export interface PreviewView {
  id: string;
  status: 'running' | 'done';
  text: string;
  action: PolicyAction;
  days: number;
  since: string;
  total: number;
  capped: boolean;
  examined: number;
  matched: number;
  errors: number;
  notChecked: number;
  stoppedReason: 'quota_exhausted' | 'evaluator_disabled' | null;
  createdAt: string;
  completedAt: string | null;
  results: {
    commentId: string;
    verdict: string;
    proposedAction: PolicyAction | null;
    reason: string | null;
    errorCode: string | null;
    excerpt: string;
    platform: string;
  }[];
}

const WARNING_TEXT: Record<PolicyWarning, string> = {
  few_words:
    'This policy is very short. Say what the comment does, for example “asks people to DM another account”.',
  vague_terms:
    'Words like “bad” or “inappropriate” are hard to apply consistently. Describe the behaviour you want to catch.',
};

export const warningText = (w: PolicyWarning): string => WARNING_TEXT[w];

const DOWNGRADE_TEXT: Record<Downgrade, string> = {
  low_confidence: 'possible match',
  low_signal: 'too little text to act on',
  moderator_acted: 'a moderator already acted on this comment',
};

const SKIP_TEXT: Record<string, string> = {
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

const FAILURE_TEXT: Record<string, string> = {
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

const own = (table: Record<string, string>, key: string | null): string | undefined =>
  key !== null && Object.hasOwn(table, key) ? table[key] : undefined;

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function usageText(u: PolicyListDto['usage']): string {
  const used = `Monthly policy checks used: ${u.used.toLocaleString('en-US')} of ${u.limit.toLocaleString('en-US')}.`;
  if (u.used < u.limit) return used;
  const resets = new Date(u.resetsAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return `${used} Policies are paused until ${resets}; comments are left unchanged.`;
}

export function previewSummary(v: PreviewView): string {
  if (v.status === 'running') return `Checking comments… ${v.examined} of ${v.total}.`;
  const window = `the last ${plural(v.days, 'day')}`;
  const parts = [
    v.capped
      ? `Would act on ${v.matched} of the ${v.total} most recent comments from ${window}. Older comments were not checked.`
      : `Would act on ${v.matched} of ${plural(v.examined, 'comment')} from ${window}.`,
  ];
  if (v.stoppedReason === 'quota_exhausted')
    parts.push(
      `The monthly policy-check limit was reached; ${v.notChecked} ${v.notChecked === 1 ? 'comment was' : 'comments were'} not checked.`,
    );
  if (v.stoppedReason === 'evaluator_disabled')
    parts.push('Policy checks are turned off in this deployment.');
  if (v.errors > 0) parts.push(`${plural(v.errors, 'comment')} could not be checked.`);
  return parts.join(' ');
}

const revisionLabel = (m: { revision: number; archived: boolean }): string =>
  `revision ${m.revision}${m.archived ? ', deleted policy' : ''}`;

/** One matched policy, with what it did to the comment. */
export function matchText(m: PolicyMatchView): string {
  const effect = m.downgrade
    ? `${DOWNGRADE_TEXT[m.downgrade]}, flagged for review instead of ${OUTCOME_VERB[m.action]}`
    : OUTCOME_VERB[m.effectiveAction];
  return `“${m.name}” (${revisionLabel(m)}) — ${effect}`;
}

export function policyDecisionText(d: DecisionView): string {
  if (!d.policy) return d.reason;
  return `${OUTCOME_DONE[d.outcome]} by policy “${d.policy.name}” (${revisionLabel(d.policy)})`;
}

export function evaluationText(e: EvaluationView): string {
  if (e.status === 'skipped') return own(SKIP_TEXT, e.skipReason) ?? 'Not checked.';
  if (e.status === 'failed')
    return (
      own(FAILURE_TEXT, e.failureCode) ?? 'Policy check failed. The comment was left unchanged.'
    );
  const checked = `Checked against ${e.checkedCount === 1 ? '1 policy' : `${e.checkedCount} policies`}`;
  return e.matches.length === 0
    ? `${checked}: no policy matched.`
    : `${checked}. Matched ${e.matches.map(matchText).join('; ')}.`;
}

const SPECIFIC_MESSAGE_CODES = new Set(['policy_limit_reached', 'policy_quota_exhausted']);

/** What a refused policy request tells the moderator; the API words limits and quota itself. */
export function policyErrorText(err: unknown): string {
  if (!(err instanceof ApiRequestError)) return 'Something went wrong.';
  if (err.issues[0]) return err.issues[0].message;
  return SPECIFIC_MESSAGE_CODES.has(err.code) ? err.message : messageFor(err.code);
}
