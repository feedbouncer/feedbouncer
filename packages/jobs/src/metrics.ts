import type { Platform } from '@feedbouncer/connectors';
import type { LogFields, Logger } from '@feedbouncer/service-runtime';

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

/** In-process counters plus structured log lines. Callers pass ids, codes and numbers, never payloads. */
export class JobMetrics {
  readonly #counts = new Map<Platform, Record<JobEvent, number>>();

  constructor(private readonly log: Logger) {}

  record(
    event: JobEvent,
    f: { platform: Platform; jobType: string; ledgerId?: string } & LogFields,
  ): void {
    const counts = this.#counts.get(f.platform) ?? zeroCounts();
    counts[event] += 1;
    this.#counts.set(f.platform, counts);
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined) fields[k] = v;
    this.log[LEVEL[event]](`job.${event}`, fields);
  }

  count(event: JobEvent, platform: Platform): number {
    return this.#counts.get(platform)?.[event] ?? 0;
  }

  snapshot(): Readonly<Record<string, Readonly<Record<JobEvent, number>>>> {
    return Object.fromEntries([...this.#counts].map(([p, c]) => [p, { ...c }]));
  }
}
