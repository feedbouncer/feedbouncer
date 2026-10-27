// Threads webhooks wake the post's poll instead of ingesting each reply: the next
// conversation pass reads the reply together with every other new one on that post.
import { systemClock, type Clock } from '@feedbouncer/connectors';
import type { WebhookSink } from '../webhook-router.js';
import type { PgThreadsPolling } from './polling.js';

export function threadsWakeSink(
  polling: Pick<PgThreadsPolling, 'recordWake'>,
  clock: Clock = systemClock,
): WebhookSink {
  return (scope, e) =>
    polling.recordWake(scope, {
      sourceExternalId: e.ref.sourceExternalId,
      replyExternalId: e.ref.externalId,
      receivedAt: new Date(clock.now()),
    });
}
