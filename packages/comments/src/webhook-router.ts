// Turns a verified webhook delivery into ingest jobs. Each event goes to the
// single live connection for its account, whichever workspace owns it; events
// for accounts with no live connection are dropped and counted.
import type {
  ConnectionDirectory,
  ConnectionRecord,
  InboundEvent,
  VerifiedDelivery,
} from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { Logger } from '@feedbouncer/service-runtime';
import { INGEST_JOB, type IngestPayload } from './jobs/specs.js';

const EVENTS: Record<InboundEvent['type'], IngestPayload['event']> = {
  'comment.created': 'created',
  'comment.updated': 'updated',
  'comment.deleted': 'deleted',
};

export function routeWebhookDelivery(d: {
  directory: ConnectionDirectory;
  producer: Pick<JobProducer, 'enqueue'>;
  log: Logger;
}): (v: VerifiedDelivery) => Promise<void> {
  return async (v) => {
    const live = new Map<string, ConnectionRecord | null>();
    let unrouted = 0;
    for (const e of v.events) {
      let rec = live.get(e.externalAccountId);
      if (rec === undefined) {
        rec = await d.directory.findLiveByAccount(v.platform, e.externalAccountId);
        live.set(e.externalAccountId, rec);
      }
      if (!rec) {
        unrouted++;
        continue;
      }
      const payload: IngestPayload = {
        sourceExternalId: e.ref.sourceExternalId,
        commentExternalId: e.ref.externalId,
        event: EVENTS[e.type],
        platformEventSec: Math.max(1, Math.floor(e.occurredAt.getTime() / 1000)),
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
