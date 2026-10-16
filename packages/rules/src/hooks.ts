import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';

export interface RuleEvaluatedHook {
  onEvaluated(e: {
    scope: ConnectionScope;
    platform: Platform;
    commentId: string;
    bodySha256: string;
    evaluationId: string;
    status: 'no_match' | 'decided';
  }): Promise<void>;
}

export type RuleEvaluatedEvent = Parameters<RuleEvaluatedHook['onEvaluated']>[0];

/** Fans one rule evaluation out to every post-rule stage (classifier, policies). All run; any failure retries the rule job, and every stage's enqueue is idempotent. */
export class CompositeRuleEvaluatedHook implements RuleEvaluatedHook {
  constructor(private readonly hooks: readonly RuleEvaluatedHook[]) {}
  async onEvaluated(e: RuleEvaluatedEvent): Promise<void> {
    const r = await Promise.allSettled(this.hooks.map((h) => h.onEvaluated(e)));
    const errors = r.flatMap((x) => (x.status === 'rejected' ? [x.reason as unknown] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'rule evaluated hooks failed');
  }
}
