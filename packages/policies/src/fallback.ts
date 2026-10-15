import { safeOutcomeCode, type ActionOutcomeObserver } from '@feedbouncer/comments';
import type { Logger } from '@feedbouncer/service-runtime';
import { describeFallback } from './describe.js';
import type { PgPolicyEvaluationStore } from './evaluations.js';

const KEY = /^pol:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Flags a comment for review when a policy-requested action could not be completed. */
export class PolicyActionFallback implements ActionOutcomeObserver {
  constructor(private readonly o: { evaluations: PgPolicyEvaluationStore; log: Logger }) {}

  async onActionOutcome(e: Parameters<ActionOutcomeObserver['onActionOutcome']>[0]): Promise<void> {
    if (e.actorType !== 'policy' || e.status === 'noop') return;
    const id = KEY.exec(e.requestKey)?.[1];
    if (!id) return;
    const brand = { organizationId: e.scope.organizationId, brandId: e.scope.brandId };
    if (e.status === 'applied') {
      await this.o.evaluations.recordRecovered(brand, id);
      return;
    }
    const code = safeOutcomeCode(e.code, e.status);
    const kind = e.kind === 'delete' ? 'delete' : 'hide';
    if (await this.o.evaluations.recordFallback(brand, id, code, describeFallback(kind, code)))
      this.o.log.info('policy.fallback', { evaluationId: id, code, status: e.status });
  }
}
