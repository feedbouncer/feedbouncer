// Turns a verified webhook delivery into ingest jobs. Each event goes to the
// single live connection for its account, whichever workspace owns it; events
// for accounts with no live connection are dropped and counted. A platform with
// a sink hands its events to the sink instead of the per-event ingest job.
import { createHash } from 'node:crypto';
import type {
  ConnectionDirectory,
  ConnectionRecord,
  InboundEvent,
  Platform,
  VerifiedDelivery,
} from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { INGEST_JOB, type IngestPayload } from './jobs/specs.js';

const EVENTS: Record<InboundEvent['type'], IngestPayload['event']> = {
  'comment.created': 'created',
  'comment.updated': 'updated',
  'comment.deleted': 'deleted',
};

/** Takes one routed event in place of the ingest job. Throwing makes the platform redeliver. */
export type WebhookSink = (scope: ConnectionScope, e: InboundEvent) => Promise<void>;

export function routeWebhookDelivery(d: {
  directory: ConnectionDirectory;
  producer: Pick<JobProducer, 'enqueue'>;
  log: Logger;
  sinks?: Partial<Record<Platform, WebhookSink>>;
}): (v: VerifiedDelivery) => Promise<void> {
  return async (v) => {
    const sink = d.sinks?.[v.platform];
    const live = new Map<string, ConnectionRecord | null>();
    let unrouted = 0;
    for (const [index, e] of v.events.entries()) {
      let rec = live.get(e.externalAccountId);
      if (rec === undefined) {
        rec = await d.directory.findLiveByAccount(v.platform, e.externalAccountId);
        live.set(e.externalAccountId, rec);
      }
      if (!rec) {
        unrouted++;
        continue;
      }
      if (sink) {
        await sink(rec.scope, e);
        continue;
      }
      const payload: IngestPayload = {
        sourceExternalId: e.ref.sourceExternalId,
        commentExternalId: e.ref.externalId,
        event: EVENTS[e.type],
        platformEventSec: Math.max(1, Math.floor(e.occurredAt.getTime() / 1000)),
        changeId: createHash('sha256')
          .update(`${v.deliveryKey}:${index}`)
          .digest('hex')
          .slice(0, 16),
      };
      // Throws on failure: the gate's ledger then leaves the delivery unprocessed and the platform retries.
      await d.producer.enqueue({
        scope: rec.scope,
        platform: v.platform,
        type: INGEST_JOB.type,
        payload,
      });
    }
    if (unrouted > 0)
      d.log.info('webhook.unrouted_events', { platform: v.platform, count: unrouted });
  };
}
