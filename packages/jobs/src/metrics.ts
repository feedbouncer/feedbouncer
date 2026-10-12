import type { Platform } from '@feedbouncer/connectors';
import { withLogContext, type LogFields, type Logger } from '@feedbouncer/service-runtime';

export const JOB_EVENTS = [
  'enqueued',
  'deduplicated',
  'completed',
  'retried',
  'deferred',
  'dead_lettered',
  'replayed',
  'duplicate_delivery',
  'requeued',
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

const LEVEL: Record<JobEvent, 'info' | 'warn' | 'error'> = {
  enqueued: 'info',
  deduplicated: 'info',
  completed: 'info',
  replayed: 'info',
  requeued: 'info',
  duplicate_delivery: 'info',
  retried: 'warn',
  deferred: 'warn',
  dead_lettered: 'error',
};

const zeroCounts = (): Record<JobEvent, number> =>
  Object.fromEntries(JOB_EVENTS.map((e) => [e, 0])) as Record<JobEvent, number>;

/** Receives every job event and queue wait; implementations must be cheap. Throws are swallowed. */
export interface JobEventSink {
  onEvent(event: JobEvent, platform: Platform, jobType: string): void;
  onWait(platform: Platform, waitMs: number): void;
}

/** In-process counters plus structured log lines. Callers pass ids, codes and numbers, never payloads. */
export class JobMetrics {
  readonly #counts = new Map<Platform, Record<JobEvent, number>>();

  constructor(
    private readonly log: Logger,
    private readonly sink?: JobEventSink,
  ) {}

  record(
    event: JobEvent,
    f: { platform: Platform; jobType: string; ledgerId?: string } & LogFields,
  ): void {
    const counts = this.#counts.get(f.platform) ?? zeroCounts();
    counts[event] += 1;
    this.#counts.set(f.platform, counts);
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined) fields[k] = v;
    withLogContext(
      { connector_type: f.platform, ...(f.ledgerId ? { job_id: f.ledgerId } : {}) },
      () => this.log[LEVEL[event]](`job.${event}`, fields),
    );
    this.#guard(() => this.sink?.onEvent(event, f.platform, f.jobType));
  }

  observeWait(platform: Platform, waitMs: number): void {
    this.#guard(() => this.sink?.onWait(platform, waitMs));
  }

  #warned = false;
  #guard(fn: () => void): void {
    try {
      fn();
    } catch {
      // Telemetry never fails a job; say so once.
      if (this.#warned) return;
      this.#warned = true;
      this.log.warn('telemetry.job_sink_failed', {});
    }
  }

  count(event: JobEvent, platform: Platform): number {
    return this.#counts.get(platform)?.[event] ?? 0;
  }

  snapshot(): Readonly<Record<string, Readonly<Record<JobEvent, number>>>> {
    return Object.fromEntries([...this.#counts].map(([p, c]) => [p, { ...c }]));
  }
}
