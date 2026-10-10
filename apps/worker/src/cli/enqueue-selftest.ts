import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Queue } from 'bullmq';
import { REDIS_PROTOCOLS, readUrl, redact } from '@feedbouncer/service-runtime';
import { SELFTEST_JOB, SYSTEM_QUEUE } from '../processor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EnqueueArgs {
  readonly runId: string;
  readonly count: number;
  readonly delayMs: number;
}

function intArg(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (raw === undefined && fallback !== undefined) return fallback;
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`--${name} must be an integer ${min}..${max}`);
  }
  return n;
}

export function parseEnqueueArgs(argv: string[]): EnqueueArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'run-id': { type: 'string' },
      count: { type: 'string' },
      'delay-ms': { type: 'string' },
    },
  });
  const runId = values['run-id'];
  if (!runId || !UUID.test(runId)) throw new Error('--run-id must be a lowercase UUID');
  return {
    runId,
    count: intArg('count', values.count, 1, 10_000),
    delayMs: intArg('delay-ms', values['delay-ms'], 0, 1_000, 0),
  };
}

export function selftestJobs(args: EnqueueArgs) {
  return Array.from({ length: args.count }, (_, i) => ({
    name: SELFTEST_JOB,
    data: { delayMs: args.delayMs },
    opts: {
      // Deterministic, so enqueueing the same run twice is a no-op. BullMQ rejects ':' in ids.
      jobId: `selftest_${args.runId}_${i}`,
      removeOnComplete: { age: 3_600, count: 10_000 },
      removeOnFail: { age: 86_400 },
    },
  }));
}

async function main(): Promise<void> {
  const args = parseEnqueueArgs(process.argv.slice(2));
  const redisUrl = readUrl(process.env, 'REDIS_URL', REDIS_PROTOCOLS);
  const queue = new Queue(SYSTEM_QUEUE, { connection: { url: redisUrl.href } });
  queue.on('error', () => {});
  try {
    await queue.addBulk(selftestJobs(args));
    process.stdout.write(`${JSON.stringify({ runId: args.runId, count: args.count })}\n`);
  } finally {
    await queue.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `enqueue-selftest: ${err instanceof Error ? redact(err.message) : 'failed'}\n`,
    );
    process.exitCode = 1;
  });
}
