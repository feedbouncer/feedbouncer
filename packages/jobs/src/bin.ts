import { ConnectorRegistry } from '@feedbouncer/connectors';
import { createPool } from '@feedbouncer/db';
import {
  EnvError,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  errorFields,
  readUrl,
  resolveFileEnv,
} from '@feedbouncer/service-runtime';
import { DLQ_USAGE, UsageError, parseDlqArgs, runDlq } from './cli/dlq.js';
import { loadJobsConfig } from './config.js';
import { createProducerConnection } from './connections.js';
import { JobRegistry } from './definition.js';
import { PgJobLedger } from './ledger.js';
import { JobMetrics } from './metrics.js';
import { JobProducer } from './producer.js';
import { QueueSet, knownLaneOf } from './queues.js';

async function main(argv: readonly string[]): Promise<number> {
  const [area, ...rest] = argv;
  if (area !== 'dlq') throw new UsageError('unknown command');
  const cmd = parseDlqArgs(rest);

  const env = resolveFileEnv(process.env, ['DATABASE_URL', 'REDIS_URL']);
  const config = loadJobsConfig(env);
  const pool = createPool(readUrl(env, 'DATABASE_URL', PG_PROTOCOLS), {
    applicationName: 'feedbouncer-jobs-cli',
    max: 2,
    onIdleError: () => {},
  });
  const redis = createProducerConnection(readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS).href);
  redis.on('error', () => {});
  const queues = new QueueSet({ connection: redis, prefix: config.prefix, laneOf: knownLaneOf });
  const ledger = new PgJobLedger(pool);
  // Replay only moves ledger rows back to the queue; it consults neither registry.
  const producer = new JobProducer({
    ledger,
    jobs: new JobRegistry(),
    connectors: new ConnectorRegistry(),
    queues,
    metrics: new JobMetrics({ debug() {}, info() {}, warn() {}, error() {} }),
    dedupWindowMs: config.dedupWindowMs,
  });
  try {
    return await runDlq(cmd, {
      ledger,
      producer,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await queues.close();
    await Promise.allSettled([pool.end(), redis.quit()]);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`jobs dlq: ${err.message}\n${DLQ_USAGE}\n`);
    process.exitCode = 2;
  } else {
    const message = err instanceof EnvError ? err.message : errorFields(err).errorMessage;
    process.stderr.write(`jobs dlq: ${String(message ?? 'failed')}\n`);
    process.exitCode = 1;
  }
}
