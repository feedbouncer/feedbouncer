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
