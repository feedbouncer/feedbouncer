import type { ActionStepObserver } from '@feedbouncer/actions';
import type { Logger } from '@feedbouncer/service-runtime';
import type { PgEvaluationStore } from './evaluations.js';
import { describeFallback } from './reason.js';

/**
 * When a rule's hide or delete step cannot be carried out, the comment is flagged
 * instead: the fallback is written once per evaluation and the flag decision opens
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
    if (e.type !== 'hide' && e.type !== 'delete') return;
    if (e.status !== 'failed' && e.status !== 'not_supported') return;
    const info = await this.#evaluations.loadForFallback(e.scope, e.evaluationId);
    if (!info || info.ruleId !== e.ruleId) return;
    const code = e.reason ?? 'failed';
    const recorded = await this.#evaluations.recordFallback(
      e.scope,
      e.evaluationId,
      code,
      describeFallback(info.ruleName, e.type === 'delete' ? 'remove' : 'hide', code, info.platform),
    );
    if (recorded)
      this.#log.info('rule_action_fallback', {
        evaluationId: e.evaluationId,
        commentId: e.commentId,
        code,
      });
  }
}
