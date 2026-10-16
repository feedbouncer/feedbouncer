import type { z } from 'zod';
import { isPlatform, type Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { DeadLetterReason, JobResult } from './failure.js';
import { SNAKE_CASE } from './keys.js';
import { LANE, type LaneOf } from './queues.js';
import { DEFAULT_RETRY_POLICY, resolvePolicy, type RetryPolicy } from './policy.js';

export type { JobResult } from './failure.js';

export interface JobContext {
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly jobType: string;
  readonly ledgerId: string;
  /** 1-based: retryable failures so far + 1. */
  readonly attempt: number;
  readonly isReplay: boolean;
  /** Aborts at timeoutMs. Pass it to every outbound call. */
  readonly signal: AbortSignal;
  readonly log: Logger;
}

export interface JobDefinition<P> {
  /** ^[a-z][a-z0-9_]{0,62}$; also the BullMQ job name. */
  readonly type: string;
  readonly platforms: readonly Platform[] | 'all';
  /** JSON types only (no z.date()); use z.strictObject. Re-checked on every run. */
  readonly payload: z.ZodType<P>;
  /** Platform identity of the effect, e.g. `${commentId}:hide`. Feeds the idempotency key. */
  readonly externalRef: (p: P) => string;
  readonly policy?: Partial<RetryPolicy>;
  /** 1_000..600_000, default 60_000. */
  readonly timeoutMs?: number;
  /** Optional isolated queue lane, LANE pattern. Must be the same in every process that enqueues this type. */
  readonly lane?: string;
  /** Must be safe to repeat (see docs/jobs/defining-a-job.md). */
  readonly handle: (ctx: JobContext, payload: P) => Promise<JobResult>;
  /**
   * Called once after the job is dead-lettered, so it can settle state the
   * handler left open. Not called for invalid_job. Errors are logged, never thrown.
   */
  readonly onDeadLetter?: (
    e: {
      readonly scope: ConnectionScope;
      readonly platform: Platform;
      readonly reason: DeadLetterReason;
      readonly errorCode: string;
    },
    payload: P,
  ) => Promise<void>;
}

export class JobRegistry {
  readonly #byType = new Map<string, JobDefinition<unknown>>();

  register<P>(def: JobDefinition<P>): void {
    const fail = (f: string): never => {
      throw new TypeError(`Invalid job definition: ${f}`);
    };
    if (!SNAKE_CASE.test(def.type)) fail('type');
    if (
      def.platforms !== 'all' &&
      (def.platforms.length === 0 || !def.platforms.every(isPlatform))
    ) {
      fail('platforms');
    }
    const t = def.timeoutMs;
    if (t !== undefined && (!Number.isInteger(t) || t < 1_000 || t > 600_000)) fail('timeoutMs');
    if (def.lane !== undefined && !LANE.test(def.lane)) fail('lane');
    try {
      resolvePolicy(DEFAULT_RETRY_POLICY, def.policy);
    } catch {
      fail('policy');
    }
    if (this.#byType.has(def.type)) throw new Error(`Job type ${def.type} is already registered`);
    this.#byType.set(def.type, def as JobDefinition<unknown>);
  }

  get(type: string): JobDefinition<unknown> | undefined {
    return this.#byType.get(type);
  }

  supports(type: string, platform: Platform): boolean {
    const d = this.#byType.get(type);
    return !!d && (d.platforms === 'all' || d.platforms.includes(platform));
  }

  all(): JobDefinition<unknown>[] {
    return [...this.#byType.values()];
  }

  laneOf(): LaneOf {
    return (t) => this.#byType.get(t)?.lane ?? null;
  }

  lanes(): string[] {
    return [...new Set(this.all().flatMap((d) => (d.lane === undefined ? [] : [d.lane])))].sort();
  }
}
