import type { JobProducer } from '@feedbouncer/jobs';
import type { RuleEvaluatedEvent, RuleEvaluatedHook } from '@feedbouncer/rules';
import { POLICY_EVALUATE_JOB } from './jobs/specs.js';
import type { PgPolicyStore } from './store.js';

/** Policies run only where the rules decided nothing, and only if the brand has an enabled policy. */
export class PolicyTrigger implements RuleEvaluatedHook {
  constructor(
    private readonly producer: Pick<JobProducer, 'enqueue'>,
    private readonly policies: Pick<PgPolicyStore, 'hasEnabled'>,
    private readonly clock: { now(): number } = Date,
  ) {}

  async onEvaluated(e: RuleEvaluatedEvent): Promise<void> {
    if (e.status !== 'no_match') return;
    const brand = { organizationId: e.scope.organizationId, brandId: e.scope.brandId };
    if (!(await this.policies.hasEnabled(brand))) return;
    await this.producer.enqueue({
      scope: e.scope,
      platform: e.platform,
      type: POLICY_EVALUATE_JOB.type,
      payload: {
        commentId: e.commentId,
        bodySha256: e.bodySha256,
        trigger: 'ingest',
        requestedAt: this.clock.now(),
      },
    });
  }
}
