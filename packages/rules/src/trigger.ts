import { storedCommentBody, type CommentAppliedHook } from '@feedbouncer/comments';
import type { JobProducer } from '@feedbouncer/jobs';
import { RULE_EVALUATE_JOB, bodySha256, type RuleEvaluatePayload } from './jobs/specs.js';

/**
 * Starts rule evaluation for a live comment whose text is new. Delivery is at
 * least once and the created/updated outcome is not reliable on redelivery, so
 * this is one enqueue deduplicated by (comment, body version): nothing else.
 * A failed enqueue throws, which keeps the comment's pending hook marker set.
 */
export class RuleTrigger implements CommentAppliedHook {
  readonly #producer: Pick<JobProducer, 'enqueue'>;
  constructor(producer: Pick<JobProducer, 'enqueue'>) {
    this.#producer = producer;
  }

  async onApplied(e: Parameters<CommentAppliedHook['onApplied']>[0]): Promise<void> {
    const payload: RuleEvaluatePayload = {
      commentId: e.commentId,
      // The job compares against the stored body; hash that same form.
      bodySha256: bodySha256(storedCommentBody(e.body)),
      trigger: 'ingest',
    };
    await this.#producer.enqueue({
      scope: e.scope,
      platform: e.platform,
      type: RULE_EVALUATE_JOB.type,
      payload,
    });
  }
}
