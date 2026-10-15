import type { ActionOutcomeObserver } from '@feedbouncer/comments';
import type { Logger } from '@feedbouncer/service-runtime';
import { describeFallback } from './describe.js';
import type { PgClassificationStore } from './store.js';

const KEY = /^clf:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(:unhide)?$/;
const SAFE_CODE = /^[a-z][a-z_]{0,63}$/;

/** Flags a comment for review when a classifier-requested action could not be completed. */
export class ClassifierActionFallback implements ActionOutcomeObserver {
  constructor(private readonly d: { classifications: PgClassificationStore; log: Logger }) {}

  async onActionOutcome(e: Parameters<ActionOutcomeObserver['onActionOutcome']>[0]): Promise<void> {
    if (e.actorType !== 'classifier' || e.status === 'noop') return;
    const m = KEY.exec(e.requestKey);
    if (!m) return;
    const id = m[1]!;
    const scope = { organizationId: e.scope.organizationId, brandId: e.scope.brandId };
    if (e.status === 'applied') {
      await this.d.classifications.recordRecovered(scope, id);
      return;
    }
    const code = e.code && SAFE_CODE.test(e.code) ? e.code : e.status;
    const kind = m[2] ? 'unhide' : e.kind === 'delete' ? 'delete' : 'hide';
    const recorded = await this.d.classifications.recordFallback(
      scope,
      id,
      code,
      describeFallback(kind, code),
    );
    if (recorded)
      this.d.log.info('classifier.fallback', { classificationId: id, code, status: e.status });
  }
}
