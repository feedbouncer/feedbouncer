import type { ActionStepObserver, StepType as ActionStepType } from '@feedbouncer/actions';
import type { ActionOutcomeObserver } from '@feedbouncer/comments';
import type { Platform } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import type { PgEvaluationStore } from './evaluations.js';
import { describeFallback } from './reason.js';

const REQUEST_KEY_PREFIX = 'rule-eval:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UnsupportedReviewReason =
  | `action_not_supported:${Platform}:${ActionStepType}`
  | `missing_permission:${string}`;

/**
 * Why a rule step that cannot run here goes to review; null for any other outcome. A
 * permission the platform refused without naming the scope is plain `missing_permission`.
 */
export function unsupportedReviewReason(
  platform: Platform,
  e: Pick<
    Parameters<ActionStepObserver['onStepSettled']>[0],
    'type' | 'status' | 'reason' | 'missingScopes'
  >,
): UnsupportedReviewReason | 'missing_permission' | null {
  if (e.status === 'not_supported') return `action_not_supported:${platform}:${e.type}`;
  if (e.status !== 'failed' || e.reason !== 'missing_permission') return null;
  return e.missingScopes?.length ? `missing_permission:${e.missingScopes.join(',')}` : e.reason;
}

/**
 * Flags a comment for review when a rule's queued platform action fails or is
 * deferred, and records the recovery if the action is applied after all. Both
 * writes are exactly-once in the store, so redelivered outcomes are harmless.
 * Logs carry ids and codes only.
 */
export class RuleActionFallback implements ActionOutcomeObserver {
  readonly #evaluations: PgEvaluationStore;
  readonly #log: Logger;

  constructor(d: { evaluations: PgEvaluationStore; log: Logger }) {
    this.#evaluations = d.evaluations;
    this.#log = d.log;
  }

  async onActionOutcome(e: Parameters<ActionOutcomeObserver['onActionOutcome']>[0]): Promise<void> {
    if (e.actorType !== 'rule' || !e.requestKey.startsWith(REQUEST_KEY_PREFIX)) return;
    if (e.status === 'noop') return;
    const evaluationId = e.requestKey.slice(REQUEST_KEY_PREFIX.length);
    if (!UUID.test(evaluationId)) {
      this.#log.warn('rule_fallback_bad_request_key', { actionId: e.actionId });
      return;
    }
    const brand = { organizationId: e.scope.organizationId, brandId: e.scope.brandId };
    const info = await this.#evaluations.loadForFallback(brand, evaluationId);
    if (!info || (info.outcome !== 'hide' && info.outcome !== 'remove')) return;
    if (e.status === 'applied') {
      const verb = info.outcome === 'remove' ? 'deleted' : 'hid';
      await this.#evaluations.recordRecovered(
        brand,
        evaluationId,
        `Rule "${info.ruleName}" ${verb} this comment after a retry.`,
      );
      return;
    }
    const code = e.code ?? 'failed';
    const reason =
      code === 'unsupported'
        ? `action_not_supported:${e.platform}:${e.kind === 'delete' ? 'delete' : 'hide'}`
        : code;
    const recorded = await this.#evaluations.recordFallback(
      brand,
      evaluationId,
      code,
      describeFallback(info.ruleName, info.outcome, reason, e.platform),
    );
    if (recorded)
      this.#log.info('rule_action_fallback', { evaluationId, commentId: e.commentId, code });
  }
}
