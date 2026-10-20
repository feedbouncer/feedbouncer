import type { ReasonCode } from '@feedbouncer/moderation-contract';
import type { RuleAction } from '@feedbouncer/rules';

export type CheckVerdict = 'allow' | 'review' | 'block';
export type DecidedBy = 'rule' | 'classifier' | 'policy' | 'none' | 'degraded';
export { REASON_CODES, type ReasonCode } from '@feedbouncer/moderation-contract';

export interface CheckResult {
  verdict: CheckVerdict;
  reasonCode: ReasonCode;
  reason: string;
  decidedBy: DecidedBy;
  degraded: boolean;
  evidence: {
    ruleId: string | null;
    ruleName: string | null;
    category: string | null;
    score: number | null;
    threshold: number | null;
    policyId: string | null;
    policyRevision: number | null;
    language: string | null;
  };
  models: {
    classifier: { provider: string; model: string } | null;
    policy: { provider: string; model: string } | null;
  };
}

const VERDICT: Readonly<Record<RuleAction, CheckVerdict>> = {
  approve: 'allow',
  flag: 'review',
  hide: 'block',
  remove: 'block',
};
export const toVerdict = (a: RuleAction): CheckVerdict => VERDICT[a];
