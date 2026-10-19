import { ApiRequestError, apiFetch } from './api-client';
import { messageFor } from './messages';

export type RuleChangeStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'stale';

export interface RuleChangeDiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

/** A proposed rule change as the API returns it. Names and the rationale are untrusted text. */
export interface RuleChangeView {
  id: string;
  operation: 'create' | 'update' | 'archive';
  ruleId: string | null;
  status: RuleChangeStatus;
  before: unknown;
  after: unknown;
  diff: RuleChangeDiffRow[];
  warnings: string[];
  rationale: string | null;
  expiresAt: string;
  baseRuleRevision: number;
  currentRuleRevision: number;
  isStale: boolean;
  proposedBy: { apiKeyName: string };
  decidedBy: { userId: string; name: string | null } | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export const STALE_TEXT = 'Rules changed since this was proposed — ask for a new proposal';

const base = (orgId: string, brandId: string) =>
  `/api/v1/orgs/${orgId}/brands/${brandId}/rule-changes` as const;

const decide =
  (decision: 'approve' | 'reject') => (orgId: string, brandId: string, id: string, note?: string) =>
    apiFetch<RuleChangeView>(`${base(orgId, brandId)}/${id}/${decision}`, {
      method: 'POST',
      body: note === undefined ? {} : { note },
    });

export const approveRuleChange = decide('approve');
export const rejectRuleChange = decide('reject');

const BLOCKED_TEXT =
  'This change cannot be approved because the normal rule checks refuse it. Reject it, or let it expire.';

const ERROR_TEXT: Record<string, string> = {
  proposal_stale: STALE_TEXT,
  proposal_expired: 'This proposal expired. Ask for a new one.',
  proposal_not_pending: 'This proposal was already decided. Reload the page.',
  invalid_actions: BLOCKED_TEXT,
  rule_limit_reached: BLOCKED_TEXT,
};

export const ruleChangeErrorText = (err: unknown): string =>
  err instanceof ApiRequestError
    ? (ERROR_TEXT[err.code] ?? messageFor(err.code))
    : 'Something went wrong.';

/** Approves or rejects a proposal; resolves to an error message, or null on success. */
export async function decideRuleChange(
  decision: 'approve' | 'reject',
  orgId: string,
  brandId: string,
  id: string,
): Promise<string | null> {
  try {
    await (decision === 'approve' ? approveRuleChange : rejectRuleChange)(orgId, brandId, id);
    return null;
  } catch (err) {
    return ruleChangeErrorText(err);
  }
}

/** A diff value as short plain text. */
export const valueText = (v: unknown): string =>
  v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
