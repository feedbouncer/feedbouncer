import { LIFECYCLE_JOB, enqueueOnly } from '@feedbouncer/comments';
import { isPlatform, type ConnectorRegistry } from '@feedbouncer/connectors';
import { createPool } from '@feedbouncer/db';
import { InputError } from '@feedbouncer/evaluation';
import {
  JobMetrics,
  JobProducer,
  JobRegistry,
  PgJobLedger,
  QueueSet,
  UsageError,
  createProducerConnection,
  loadJobsConfig,
} from '@feedbouncer/jobs';
import {
  EnvError,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  errorFields,
  readUrl,
  resolveFileEnv,
} from '@feedbouncer/service-runtime';
import { BETA_STATUS_USAGE, betaStatusCommand } from './beta-status.js';
import { ERASE_ORG_USAGE, EraseError, eraseOrgCommand } from './erase-org.js';
import { EVAL_EXPORT_USAGE, evalExportCommand } from './eval-export.js';
import { EVAL_REPORT_USAGE, evalReportCommand } from './eval-report.js';
import type { OpsCommand, OpsContext } from './ops-context.js';

const COMMANDS: Readonly<Record<string, { run: OpsCommand; usage: string }>> = {
  'beta-status': { run: betaStatusCommand, usage: BETA_STATUS_USAGE },
  'erase-org': { run: eraseOrgCommand, usage: ERASE_ORG_USAGE },
  'eval-export': { run: evalExportCommand, usage: EVAL_EXPORT_USAGE },
  'eval-report': { run: evalReportCommand, usage: EVAL_REPORT_USAGE },
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command)
    throw new UsageError(`unknown command; one of: ${Object.keys(COMMANDS).join(', ')}`);

  const env = resolveFileEnv(process.env, ['DATABASE_URL', 'REDIS_URL']);
  const closers: Array<() => Promise<unknown>> = [];
  const lazy = <T>(build: () => T) => {
    let value: T | undefined;
    return () => (value ??= build());
  };
  const pool = lazy(() => {
    const p = createPool(readUrl(env, 'DATABASE_URL', PG_PROTOCOLS), {
      applicationName: 'feedbouncer-ops-cli',
      max: 2,
      onIdleError: () => {},
    });
    closers.push(() => p.end());
    return p;
  });
  const producer = lazy(() => {
    const config = loadJobsConfig(env);
    const redis = createProducerConnection(readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS).href);
    redis.on('error', () => {});
    const jobs = new JobRegistry();
    jobs.register(enqueueOnly(LIFECYCLE_JOB));
    const queues = new QueueSet({
      connection: redis,
      prefix: config.prefix,
      laneOf: jobs.laneOf(),
    });
    closers.push(
      () => queues.close(),
      () => redis.quit(),
    );
    return new JobProducer({
      ledger: new PgJobLedger(pool()),
      jobs,
      // No connector runs in this process; enqueueing only needs the platform to be known.
      connectors: {
        get: (platform: string) => (isPlatform(platform) ? platform : undefined),
      } as unknown as Pick<ConnectorRegistry, 'get'>,
      queues,
      metrics: new JobMetrics(silent),
      dedupWindowMs: config.dedupWindowMs,
    });
  });
  const ctx: OpsContext = {
    log: silent,
    env,
    cwd: env.INIT_CWD ?? process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    pool,
    producer,
  };
  try {
    return await command.run(rest, ctx);
  } catch (err) {
    if (err instanceof UsageError) throw new UsageError(`${err.message}\n${command.usage}`);
    throw err;
  } finally {
    await Promise.allSettled(closers.map((close) => close()));
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || err instanceof InputError) {
    process.stderr.write(`ops: ${err.message}\n`);
    process.exitCode = 2;
  } else if (err instanceof EraseError) {
    process.stderr.write(`ops: ${err.code}\n`);
    process.exitCode = 1;
  } else {
    const message = err instanceof EnvError ? err.message : errorFields(err).errorMessage;
    process.stderr.write(`ops: ${String(message ?? 'failed')}\n`);
    process.exitCode = 1;
  }
}
