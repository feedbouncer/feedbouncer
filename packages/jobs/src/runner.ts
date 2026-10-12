// Runs one BullMQ delivery against the ledger. Redis only carries the ledger
// id; everything that decides whether the effect may run again (state, lease,
// attempt counters) comes from Postgres. A job that settles is acked, a job
// that must wait is moved to delayed and signalled with DelayedError, and a
// job that will never succeed is dead-lettered and failed with
// UnrecoverableError. Error messages from handlers are never read: only the
// classified kind and code, plus the error name, reach logs and the ledger.
import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import type { Platform } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import type { JobRegistry } from './definition.js';
import { classifyFailure, decide, type DeadLetterReason } from './failure.js';
import { UUID } from './keys.js';
import type { JobLedgerPort, LedgerRow } from './ledger.js';
import type { JobMetrics } from './metrics.js';
import { validateJobResult } from './payload.js';
import { DEFAULT_TIMEOUT_MS, leaseMs, type RetryPolicy } from './policy.js';

export interface BullJobLike {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export type RunOutcome = 'processed' | 'duplicate' | 'missing' | 'lost_lease';

export interface RunnerDeps {
  readonly platform: Platform;
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
  /** Test seam: runs after the completion commit, before returning to BullMQ. */
  readonly afterComplete?: (ledgerId: string) => Promise<void>;
}

const JobData = z.strictObject({ v: z.literal(1), ledgerId: z.string().regex(UUID) });

export function createJobProcessor(
  d: RunnerDeps,
): (job: BullJobLike, token?: string) => Promise<RunOutcome> {
  const random = d.random ?? Math.random;
  const now = d.now ?? Date.now;

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
    const owner = `${d.workerId.slice(0, 100)}:${d.platform}:${randomUUID()}`;
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

    const row: LedgerRow = claim.row;
    const base = { platform: d.platform, jobType: row.jobType, ledgerId };

    const lostLease = (): RunOutcome => {
      d.log.warn('job.lost_lease', { job: job.name, bullId: job.id ?? null, ledgerId });
      return 'lost_lease';
    };

    const deadLetter = async (
      reason: DeadLetterReason,
      errorKind: string,
      errorCode: string,
      countsAsFailure: boolean,
      resolution: string | null,
    ): Promise<RunOutcome> => {
      const ok = await d.ledger.deadLetter(ledgerId, owner, {
        reason,
        resolution,
        errorKind,
        errorCode,
        countsAsFailure,
        retentionMs: d.dlqRetentionMs,
      });
      if (!ok) return lostLease();
      d.metrics.record('dead_lettered', { ...base, reason, code: errorCode });
      throw new UnrecoverableError(`dead_lettered: ${reason}`);
    };

    if (row.platform !== d.platform || row.jobType !== job.name) {
      return deadLetter('invalid_job', 'invalid', 'queue_mismatch', false, null);
    }

    const policy = d.policyFor(row.jobType);
    if (row.failures + row.crashes >= policy.maxAttempts) {
      return deadLetter('stall_limit_exceeded', 'stalled', 'worker_crashed', false, null);
    }

    const payload = def.payload.safeParse(row.payload);
    if (!payload.success) {
      return deadLetter('invalid_job', 'invalid', 'invalid_payload', false, null);
    }

    const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
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
      const result = validateJobResult(await Promise.race([run, aborted]));
      const ok = await d.ledger.complete(ledgerId, owner, JSON.stringify(result));
      if (!ok) return lostLease();
    } catch (err) {
      const errorName = err instanceof Error ? err.name : 'NonError';
      const f = classifyFailure(err);
      const disp = decide(f, row, policy, random);

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
        if (!ok) return lostLease();
        d.metrics.record('retried', {
          ...base,
          code: f.code,
          attempt: row.failures + 1,
          delayMs: disp.delayMs,
          errorName,
        });
      } else {
        const ok = await d.ledger.recordDeferral(ledgerId, owner, f.code, disp.delayMs);
        if (!ok) return lostLease();
        d.metrics.record('deferred', { ...base, code: f.code, delayMs: disp.delayMs });
      }
      await job.moveToDelayed(now() + disp.delayMs, token);
      throw new DelayedError();
    }
    // Every catch path above returns or throws, so this is the success path.
    // It sits outside the try: the row is settled, so a failure here must not
    // be classified as a handler failure.
    d.metrics.record('completed', base);
    await d.afterComplete?.(ledgerId);
    return 'processed';
  };
}
