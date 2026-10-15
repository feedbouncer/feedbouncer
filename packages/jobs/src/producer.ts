import { isPlatform, type ConnectorRegistry, type Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import {
  injectTraceparent,
  setSpanAttributes,
  SpanKind,
  withSpan,
} from '@feedbouncer/service-runtime';
import type { JobRegistry } from './definition.js';
import { JobEnqueueError } from './errors.js';
import { deriveIdempotencyKey, bullJobId, UUID } from './keys.js';
import type { LedgerState, PgJobLedger, ReplayFilter, Requeued } from './ledger.js';
import type { JobMetrics } from './metrics.js';
import { assertSafePayload } from './payload.js';
import type { QueueSet } from './queues.js';

export interface EnqueueRequest {
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly type: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}

export type EnqueueResult =
  | { readonly status: 'enqueued'; readonly ledgerId: string; readonly jobId: string }
  | {
      readonly status: 'deduplicated';
      readonly ledgerId: string;
      readonly jobId: string;
      readonly state: LedgerState;
    };

export interface ProducerDeps {
  ledger: PgJobLedger;
  jobs: JobRegistry;
  connectors: ConnectorRegistry;
  queues: QueueSet;
  metrics: JobMetrics;
  dedupWindowMs: number;
}

export class JobProducer {
  constructor(private readonly d: ProducerDeps) {}

  async enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const { ledger, jobs, connectors, queues, metrics } = this.d;
    const { scope, platform, type } = req;
    if (!isPlatform(platform) || connectors.get(platform) === undefined) {
      throw new JobEnqueueError('unknown_platform');
    }
    const def = jobs.get(type);
    if (!def || !jobs.supports(type, platform)) throw new JobEnqueueError('unknown_job_type');
    const ids = [scope?.organizationId, scope?.brandId, scope?.connectionId];
    if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) {
      throw new JobEnqueueError('invalid_scope');
    }
    // Zod issues echo submitted values, so a failure is reported by code only.
    const parsed = def.payload.safeParse(req.payload);
    if (!parsed.success) throw new JobEnqueueError('invalid_payload');
    const payloadJson = assertSafePayload(parsed.data);

    const key = deriveIdempotencyKey({
      scope,
      platform,
      type,
      ...(req.idempotencyKey !== undefined
        ? { callerKey: req.idempotencyKey }
        : { externalRef: def.externalRef(parsed.data) }),
    } as Parameters<typeof deriveIdempotencyKey>[0]);

    return withSpan(
      'job.enqueue',
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'feedbouncer.platform': platform,
          'feedbouncer.job.type': type,
          'feedbouncer.connector.id': scope.connectionId,
          'messaging.system': 'bullmq',
          'messaging.destination.name': this.d.queues.nameFor(platform, type),
        },
      },
      async (span) => {
        // Inside the span, so the stored parent is this job.enqueue span.
        const res = await ledger.insert({
          scope,
          platform,
          jobType: type,
          idempotencyKey: key,
          payloadJson,
          ttlMs: this.d.dedupWindowMs,
          traceContext: injectTraceparent(),
        });
        if (res.status === 'no_connection') throw new JobEnqueueError('connection_not_found');

        const jobId = bullJobId(key);
        if (res.status === 'inserted') {
          setSpanAttributes(span, {
            'feedbouncer.job.id': res.id,
            'feedbouncer.job.deduplicated': false,
          });
          await queues.add(platform, type, res.id, key);
          metrics.record('enqueued', { platform, jobType: type, ledgerId: res.id });
          return { status: 'enqueued', ledgerId: res.id, jobId } as const;
        }
        setSpanAttributes(span, {
          'feedbouncer.job.id': res.id,
          'feedbouncer.job.deduplicated': true,
        });
        span.addEvent('job.deduplicated', { 'feedbouncer.job.state': res.state });
        // Repair: a no-op when the job is still in Redis, restores it when it was lost.
        if (res.state === 'queued') await queues.add(platform, type, res.id, key);
        metrics.record('deduplicated', { platform, jobType: type, ledgerId: res.id });
        return { status: 'deduplicated', ledgerId: res.id, jobId, state: res.state } as const;
      },
    );
  }

  async replay(filter: ReplayFilter): Promise<Requeued[]> {
    const rows = await this.d.ledger.replay(filter, this.d.dedupWindowMs);
    for (const r of rows) {
      await this.d.queues.add(r.platform, r.jobType, r.id, r.idempotencyKey);
      this.d.metrics.record('replayed', {
        platform: r.platform,
        jobType: r.jobType,
        ledgerId: r.id,
      });
    }
    return rows;
  }

  async reconcile(staleAfterMs: number, limit: number): Promise<number> {
    const rows = await this.d.ledger.staleQueued(staleAfterMs, limit);
    for (const r of rows) {
      await this.d.queues.add(r.platform, r.jobType, r.id, r.idempotencyKey);
      this.d.metrics.record('requeued', {
        platform: r.platform,
        jobType: r.jobType,
        ledgerId: r.id,
      });
    }
    return rows.length;
  }
}
