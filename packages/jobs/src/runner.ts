// Runs one BullMQ delivery against the ledger. Redis only carries the ledger
// id; everything that decides whether the effect may run again (state, lease,
// attempt counters) comes from Postgres. A job that settles is acked, a job
// that must wait is moved to delayed and signalled with DelayedError, and a
// job that will never succeed is dead-lettered and failed with
// UnrecoverableError. Error messages from handlers are never read: only the
// classified kind and code, plus the error name, reach logs and the ledger.
import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';
import type { Platform } from '@feedbouncer/connectors';
import {
  contextFromTraceparent,
  setSpanAttributes,
  SpanKind,
  withLogContext,
  withSpan,
  type Logger,
  type Span,
} from '@feedbouncer/service-runtime';
import type { JobRegistry } from './definition.js';
import {
  classifyFailure,
  decide,
  type DeadLetterReason,
  type Disposition,
  type FailureClass,
} from './failure.js';
import { UUID } from './keys.js';
import type { JobLedgerPort } from './ledger.js';
import type { JobMetrics } from './metrics.js';
import { validateJobResult } from './payload.js';
import { DEFAULT_TIMEOUT_MS, leaseMs, type RetryPolicy } from './policy.js';
import { NO_LANES, queueName, type LaneOf } from './queues.js';

export interface BullJobLike {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export type RunOutcome = 'processed' | 'duplicate' | 'missing' | 'lost_lease';

export interface RunnerDeps {
  readonly platform: Platform;
  /** Null for a platform worker; a lane worker only accepts jobs of its lane. */
  readonly lane?: string | null;
  readonly laneOf?: LaneOf;
  readonly ledger: JobLedgerPort;
  readonly jobs: JobRegistry;
  /** default <- platform <- job type */
  readonly policyFor: (jobType: string) => RetryPolicy;
  readonly dlqRetentionMs: number;
  readonly workerId: string;
  readonly log: Logger;
  readonly metrics: JobMetrics;
  readonly random?: () => number;
  readonly now?: () => number;
}

const JobData = z.strictObject({ v: z.literal(1), ledgerId: z.string().regex(UUID) });

export function createJobProcessor(
  d: RunnerDeps,
): (job: BullJobLike, token?: string) => Promise<RunOutcome> {
  const random = d.random ?? Math.random;
  const now = d.now ?? Date.now;
  const lane = d.lane ?? null;
  const laneOf = d.laneOf ?? NO_LANES;

  const dropInvalid = (job: BullJobLike, why: string): never => {
    d.log.error('job.invalid_data', { job: job.name, bullId: job.id ?? null, why });
    throw new UnrecoverableError('invalid_job');
  };

  return async (job, token) => {
    const data = JobData.safeParse(job.data);
    if (!data.success) return dropInvalid(job, 'data');
    const ledgerId = data.data.ledgerId;

    const def = d.jobs.get(job.name);
    if (!def) return dropInvalid(job, 'unknown_type');

    // The ledger guards writes by lease owner alone, so every delivery needs
    // an owner no other concurrent delivery shares. The column holds 200 chars.
    const owner = `${d.workerId.slice(0, 100)}:${d.lane ?? d.platform}:${randomUUID()}`;
    const claim = await d.ledger.claim(
      ledgerId,
      owner,
      leaseMs(def.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    if (claim.status === 'missing') {
      d.log.warn('job.missing', { job: job.name, bullId: job.id ?? null, ledgerId });
      return 'missing';
    }
    if (claim.status === 'settled') {
      d.metrics.record('duplicate_delivery', {
        platform: d.platform,
        jobType: job.name,
        ledgerId,
        state: claim.state,
      });
      return 'duplicate';
    }
    if (claim.status === 'busy') {
      await job.moveToDelayed(now() + claim.retryInMs, token);
      throw new DelayedError();
    }

    const { row, waitMs } = claim;
    if (waitMs !== null) d.metrics.observeWait(d.platform, waitMs);
    // Only our own producer's column is trusted; NULL or malformed starts a new root.
    const parent = contextFromTraceparent(row.traceContext);
    const logCtx = {
      tenant_id: row.scope.organizationId,
      brand_id: row.scope.brandId,
      connector_id: row.scope.connectionId,
      connector_type: d.platform,
      job_id: ledgerId,
    };
    const base = { platform: d.platform, jobType: row.jobType, ledgerId };

    const runClaimed = async (span: Span): Promise<RunOutcome> => {
      const errorSpan = (kind: string, code: string): void => {
        setSpanAttributes(span, {
          'feedbouncer.error.code': code,
          'feedbouncer.error.class': kind,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      };
      const outcome = (o: string): void =>
        setSpanAttributes(span, { 'feedbouncer.job.outcome': o });

      const lostLease = (): RunOutcome => {
        outcome('lost_lease');
        d.log.warn('job.lost_lease', { job: job.name, bullId: job.id ?? null, ledgerId });
        return 'lost_lease';
      };

      const deadLetter = async (
        reason: DeadLetterReason,
        errorKind: string,
        errorCode: string,
        countsAsFailure: boolean,
        resolution: string | null,
      ): Promise<boolean> => {
        const ok = await d.ledger.deadLetter(ledgerId, owner, {
          reason,
          resolution,
          errorKind,
          errorCode,
          countsAsFailure,
          retentionMs: d.dlqRetentionMs,
        });
        if (ok) d.metrics.record('dead_lettered', { ...base, reason, code: errorCode });
        return ok;
      };

      const rejectJob = async (
        reason: DeadLetterReason,
        errorKind: string,
        errorCode: string,
      ): Promise<RunOutcome> => {
        outcome('dead_lettered');
        errorSpan('non_retryable', errorCode);
        if (!(await deadLetter(reason, errorKind, errorCode, false, null))) return lostLease();
        throw new UnrecoverableError(`dead_lettered: ${reason}`);
      };

      // Writes the verdict on a failed run. False means the lease was lost.
      const recordFailure = async (
        f: FailureClass,
        disp: Disposition,
        errorName: string,
      ): Promise<boolean> => {
        if (disp.type === 'dead_letter') {
          return deadLetter(disp.reason, f.kind, f.code, disp.countsAsFailure, disp.resolution);
        }
        if (disp.type === 'retry') {
          const ok = await d.ledger.recordRetry(
            ledgerId,
            owner,
            { kind: f.kind, code: f.code },
            disp.delayMs,
          );
          if (ok) {
            d.metrics.record('retried', {
              ...base,
              code: f.code,
              attempt: row.failures + 1,
              delayMs: disp.delayMs,
              errorName,
            });
          }
          return ok;
        }
        const ok = await d.ledger.recordDeferral(ledgerId, owner, f.code, disp.delayMs);
        if (ok) d.metrics.record('deferred', { ...base, code: f.code, delayMs: disp.delayMs });
        return ok;
      };

      if (row.platform !== d.platform || row.jobType !== job.name || laneOf(row.jobType) !== lane) {
        return rejectJob('invalid_job', 'invalid', 'queue_mismatch');
      }

      const policy = d.policyFor(row.jobType);
      if (row.failures + row.crashes >= policy.maxAttempts) {
        return rejectJob('stall_limit_exceeded', 'stalled', 'worker_crashed');
      }

      const payload = def.payload.safeParse(row.payload);
      if (!payload.success) {
        return rejectJob('invalid_job', 'invalid', 'invalid_payload');
      }

      const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const signal = AbortSignal.timeout(timeoutMs);
      let handlerRunning = true;
      let handlerSettled: Promise<void> = Promise.resolve();
      try {
        // The handler is raced against the signal so one that ignores it still
        // frees the slot; that is what bounds worker.close().
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const run = (async () =>
          def.handle(
            {
              scope: row.scope,
              platform: d.platform,
              jobType: row.jobType,
              ledgerId,
              attempt: row.failures + 1,
              isReplay: row.replays > 0,
              signal,
              log: d.log,
            },
            payload.data,
          ))();
        const markSettled = () => {
          handlerRunning = false;
        };
        handlerSettled = run.then(markSettled, markSettled);
        const result = validateJobResult(await Promise.race([run, aborted]));
        const ok = await d.ledger.complete(ledgerId, owner, JSON.stringify(result));
        if (!ok) return lostLease();
      } catch (err) {
        const errorName = err instanceof Error ? err.name : 'NonError';
        const f = classifyFailure(err);
        const disp = decide(f, row, policy, random);
        outcome(
          disp.type === 'retry' ? 'retried' : disp.type === 'defer' ? 'deferred' : 'dead_lettered',
        );
        errorSpan(f.kind, f.code);

        if (handlerRunning) {
          // The handler ignored its abort signal and is still running. Its lease
          // is kept until it settles, so a retry cannot overlap it: the verdict
          // is written then, and meanwhile redeliveries find the row busy. If it
          // never settles the lease expires and the stall counters take over.
          void handlerSettled
            .then(() => recordFailure(f, disp, errorName))
            .catch((e: unknown) =>
              d.log.error('job.record_failed', {
                ...base,
                errorName: e instanceof Error ? e.name : 'NonError',
              }),
            );
          const parkMs = disp.type === 'dead_letter' ? policy.baseDelayMs : disp.delayMs;
          await job.moveToDelayed(now() + parkMs, token);
          throw new DelayedError();
        }
        if (!(await recordFailure(f, disp, errorName))) return lostLease();
        if (disp.type === 'dead_letter') {
          throw new UnrecoverableError(`dead_lettered: ${disp.reason}`);
        }
        await job.moveToDelayed(now() + disp.delayMs, token);
        throw new DelayedError();
      }
      // Every catch path above returns or throws, so this is the success path.
      // It sits outside the try: the row is settled, so a failure here must not
      // be classified as a handler failure.
      outcome('completed');
      d.metrics.record('completed', base);
      return 'processed';
    };

    return withLogContext(logCtx, () => {
      if (!parent) d.log.debug('job.trace_started', base);
      return withSpan(
        'job.run',
        {
          kind: SpanKind.CONSUMER,
          ...(parent ? { parent } : { root: true }),
          isControlFlow: (e) => e instanceof DelayedError || e instanceof UnrecoverableError,
          attributes: {
            'feedbouncer.platform': d.platform,
            'feedbouncer.job.type': row.jobType,
            'feedbouncer.job.id': ledgerId,
            'feedbouncer.job.attempt': row.failures + 1,
            'feedbouncer.job.crashes': row.crashes,
            'feedbouncer.job.deferrals': row.deferrals,
            'feedbouncer.job.replay': row.replays > 0,
            'messaging.system': 'bullmq',
            'messaging.destination.name': queueName(d.platform, lane),
          },
        },
        runClaimed,
      );
    });
  };
}
