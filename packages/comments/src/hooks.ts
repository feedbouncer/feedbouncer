// Narrow extension points other packages plug into, so this package never
// imports them (the rule engine lives in its own package).
import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { ActionActor, ActionKind } from './action-kinds.js';

/** Called after a live comment snapshot was stored and its text is new (created or edited). Throwing retries the job. Delivery is at least once: keep it idempotent. */
export interface CommentAppliedHook {
  onApplied(e: {
    scope: ConnectionScope;
    platform: Platform;
    commentId: string;
    body: string;
    outcome: 'created' | 'updated';
  }): Promise<void>;
}

export type ActionOutcomeStatus = 'applied' | 'noop' | 'not_eligible' | 'failed' | 'deferred';

/** Called by moderation_execute after a final status is recorded, or when the job is about to be deferred/retried. Must not throw. */
export interface ActionOutcomeObserver {
  onActionOutcome(e: {
    scope: ConnectionScope;
    platform: Platform;
    actionId: string;
    commentId: string;
    kind: ActionKind;
    actorType: ActionActor['type'];
    ruleId: string | null;
    requestKey: string;
    status: ActionOutcomeStatus;
    code: string | null;
  }): Promise<void>;
}

/** Fans one outcome out to several observers. Each observer is idempotent; the first error is rethrown so the job retries. */
export class CompositeActionOutcomeObserver implements ActionOutcomeObserver {
  constructor(private readonly observers: readonly ActionOutcomeObserver[]) {}
  async onActionOutcome(e: Parameters<ActionOutcomeObserver['onActionOutcome']>[0]): Promise<void> {
    const results = await Promise.allSettled(this.observers.map((o) => o.onActionOutcome(e)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
