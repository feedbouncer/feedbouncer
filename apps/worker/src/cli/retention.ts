import { parseArgs } from 'node:util';
import { UsageError } from '@feedbouncer/jobs';
import {
  BUILTIN_LIMIT_DAYS,
  RETENTION_CATEGORIES,
  RetentionSettingMismatchError,
  confirmRetention,
  previewPurge,
  readRetentionStatus,
  runPurge,
  shorterBuiltinLimits,
  type RetentionCategory,
  type RetentionDays,
} from '@feedbouncer/privacy';
import type { Logger } from '@feedbouncer/service-runtime';
import type { OpsCommand, Pool } from './ops-context.js';

export const RETENTION_USAGE =
  'usage: pnpm ops retention status | preview | run | confirm --category <c> --days <n> --as <label>';

const LABEL = /^[A-Za-z0-9._@-]{1,64}$/;
const WHOLE = /^[1-9]\d{0,4}$/;

export interface RetentionCliDeps {
  pool: Pool;
  log: Logger;
}

export interface RetentionCliIo {
  out(line: string): void;
  err(line: string): void;
}

const isCategory = (v: string): v is RetentionCategory =>
  (RETENTION_CATEGORIES as readonly string[]).includes(v);
const showDays = (d: RetentionDays) => (d === 'forever' ? 'forever' : `${d} days`);
const yesNo = (b: boolean) => (b ? 'yes' : 'no');

const NO_SETTINGS = 'No retention settings published yet: start the worker once, then retry.';

/** The published status, or null when no worker has published settings yet. */
async function readPublished(pool: Pool) {
  const st = await readRetentionStatus(pool);
  const days = (st.settings as { days?: unknown } | null)?.days;
  return days === undefined || days === null ? null : st;
}

function noSettings(io: RetentionCliIo): number {
  io.err(NO_SETTINGS);
  return 1;
}

/**
 * `pnpm ops retention`. Settings come from what the worker last published
 * (retention_status), so the operator sees and confirms the periods actually in force.
 */
export async function runRetention(
  argv: readonly string[],
  deps: RetentionCliDeps,
  io: RetentionCliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  const { pool, log } = deps;
  switch (sub) {
    case 'status': {
      const st = await readPublished(pool);
      if (st === null) return noSettings(io);
      for (const c of RETENTION_CATEGORIES) io.out(`${c}: ${showDays(st.effective[c])}`);
      const limits = shorterBuiltinLimits(st.settings).map((l) => `${l} ${BUILTIN_LIMIT_DAYS[l]}d`);
      io.out(`warnings: ${st.warnings.join(', ') || 'none'}`);
      if (limits.length > 0) io.out(`built-in limits in force: ${limits.join(', ')}`);
      const r = st.lastRun;
      io.out(
        r
          ? `last run: ${r.status} at ${r.finishedAt?.toISOString() ?? '?'} held=${r.held.join(',') || 'none'} skipped_pending_review=${r.skippedPendingReview}`
          : 'last run: none',
      );
      return 0;
    }
    case 'preview': {
      const st = await readPublished(pool);
      if (st === null) return noSettings(io);
      const { settings } = st;
      const p = await previewPurge(pool, settings);
      for (const c of RETENTION_CATEGORIES) {
        const e = p[c];
        io.out(
          `${c}: days=${e.days} eligible=${e.eligible} skipped_pending_review=${e.skippedPendingReview} confirmed=${yesNo(e.confirmed)} would_hold=${yesNo(e.wouldHold)}`,
        );
      }
      return 0;
    }
    case 'confirm': {
      let values;
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            category: { type: 'string' },
            days: { type: 'string' },
            as: { type: 'string' },
          },
          strict: true,
        }));
      } catch {
        throw new UsageError('invalid arguments');
      }
      const { category, days, as } = values;
      if (category === undefined || !isCategory(category))
        throw new UsageError(`--category must be one of: ${RETENTION_CATEGORIES.join(', ')}`);
      if (days === undefined || !WHOLE.test(days))
        throw new UsageError('--days must be a whole number of days');
      if (as === undefined || !LABEL.test(as))
        throw new UsageError('--as must be 1-64 letters, digits or . _ @ -');
      const st = await readPublished(pool);
      if (st === null) return noSettings(io);
      const { settings } = st;
      try {
        const r = await confirmRetention(pool, settings, category, Number(days), as);
        io.out(`confirmed ${category} at ${days} days: eligible=${r.eligible}`);
        return 0;
      } catch (err) {
        if (!(err instanceof RetentionSettingMismatchError)) throw err;
        io.err(err.message);
        return 2;
      }
    }
    case 'run': {
      const st = await readPublished(pool);
      if (st === null) return noSettings(io);
      const { settings } = st;
      const r = await runPurge(pool, settings, { log });
      if (r.status === 'skipped_locked') {
        io.out('run skipped: another purge is running');
        return 0;
      }
      const counts = RETENTION_CATEGORIES.map((c) => `${c}=${r.counts.byCategory[c]}`).join(' ');
      io.out(
        `run ${r.runId}: ${r.status} ${counts} held=${r.held.join(',') || 'none'} skipped_pending_review=${r.counts.skippedPendingReview}`,
      );
      return 0;
    }
    default:
      throw new UsageError('unknown subcommand; one of: status, preview, confirm, run');
  }
}

export const retentionCommand: OpsCommand = (argv, ctx) =>
  runRetention(
    argv,
    { pool: ctx.pool(), log: ctx.log },
    { out: ctx.out, err: (line) => process.stderr.write(`${line}\n`) },
  );
