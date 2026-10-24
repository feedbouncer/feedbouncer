import type { ActionStepObserver } from '@feedbouncer/actions';
import type { Logger } from '@feedbouncer/service-runtime';
import type { PgEvaluationStore } from './evaluations.js';
import { unsupportedReviewReason } from './fallback.js';
import { describeFallback } from './reason.js';

/**
 * When a rule's hide or delete step cannot be carried out, or any of its steps is not
 * supported or not permitted on the connection, the comment is flagged instead: never with a
 * substitute action. The fallback is written once per evaluation and the flag decision opens
 * the review item. Logs carry ids and codes only.
 */
export class RuleStepFallback implements ActionStepObserver {
  readonly #evaluations: PgEvaluationStore;
  readonly #log: Logger;

  constructor(d: { evaluations: PgEvaluationStore; log: Logger }) {
    this.#evaluations = d.evaluations;
    this.#log = d.log;
  }

  async onStepSettled(e: Parameters<ActionStepObserver['onStepSettled']>[0]): Promise<void> {
    if (e.ruleId === null || e.evaluationId === null || e.type === 'flag_for_review') return;
    const unrunnable =
      e.status === 'not_supported' || (e.status === 'failed' && e.reason === 'missing_permission');
    const destructive = e.type === 'hide' || e.type === 'delete';
    if (!unrunnable && !(destructive && e.status === 'failed')) return;
    const info = await this.#evaluations.loadForFallback(e.scope, e.evaluationId);
    if (!info || info.ruleId !== e.ruleId) return;
    const code = e.status === 'not_supported' ? 'unsupported' : (e.reason ?? 'failed');
    const reason = unsupportedReviewReason(info.platform, e) ?? code;
    const recorded = await this.#evaluations.recordFallback(
      e.scope,
      e.evaluationId,
      code,
      describeFallback(
        info.ruleName,
        e.type === 'delete' ? 'remove' : e.type,
        reason,
        info.platform,
      ),
    );
    if (recorded)
      this.#log.info('rule_action_fallback', {
        evaluationId: e.evaluationId,
        commentId: e.commentId,
        code,
      });
  }
}
