import type { JobProducer } from '@feedbouncer/jobs';
import type { RuleEvaluatedHook } from '@feedbouncer/rules';
import { CLASSIFY_JOB } from './jobs/specs.js';

export class ClassifierTrigger implements RuleEvaluatedHook {
  constructor(
    private readonly producer: Pick<JobProducer, 'enqueue'>,
    private readonly clock: { now(): number } = Date,
  ) {}

  async onEvaluated(e: Parameters<RuleEvaluatedHook['onEvaluated']>[0]): Promise<void> {
    await this.producer.enqueue({
      scope: e.scope,
      platform: e.platform,
      type: CLASSIFY_JOB.type,
      payload: {
        commentId: e.commentId,
        bodySha256: e.bodySha256,
        trigger: 'ingest',
        requestedAt: this.clock.now(),
      },
    });
  }
}
