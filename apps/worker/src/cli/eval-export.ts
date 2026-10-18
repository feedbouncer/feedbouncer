import { randomInt } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exportRun } from '@feedbouncer/evaluation';
import { UsageError, loadJobsConfig } from '@feedbouncer/jobs';
import type { OpsCommand } from './ops-context.js';

export const EVAL_EXPORT_USAGE =
  'usage: pnpm ops eval-export --org <uuid> [--org <uuid>]... [--brand <uuid>]... --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--label-sample <n>] [--seed <int>] [--out <dir>]';

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INT_RE = /^\d{1,15}$/;
const MAX_SEED = 2 ** 32 - 1;

function uuids(values: readonly string[] | undefined, flag: string): string[] {
  const list = values ?? [];
  for (const v of list) if (!UUID_RE.test(v)) throw new UsageError(`${flag} must be a UUID`);
  return [...new Set(list.map((v) => v.toLowerCase()))];
}

function utcDate(value: string | undefined, flag: string): Date {
  if (!value || !DATE_RE.test(value)) throw new UsageError(`${flag} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new UsageError(`${flag} must be a real date`);
  return d;
}

function intIn(value: string, flag: string, min: number, max: number): number {
  const n = INT_RE.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  return n;
}

/** Default run directory: tmp/eval/<UTC yyyymmddThhmmssZ> (tmp/ is git-ignored). */
export function defaultOutDir(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(/[-:]/g, '');
  return join('tmp', 'eval', `${stamp}Z`);
}

/** Creates the default parent (tmp/eval) if needed; an explicit --out parent is never created. */
export async function ensureDefaultParent(out: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
}

export const evalExportCommand: OpsCommand = async (argv, ctx) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        org: { type: 'string', multiple: true },
        brand: { type: 'string', multiple: true },
        from: { type: 'string' },
        to: { type: 'string' },
        'label-sample': { type: 'string' },
        seed: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }));
  } catch {
    throw new UsageError('invalid arguments');
  }

  const organizationIds = uuids(values.org, '--org');
  if (organizationIds.length === 0) throw new UsageError('at least one --org is required');
  const brandIds = uuids(values.brand, '--brand');

  const now = new Date();
  const from = utcDate(values.from, '--from');
  const to = utcDate(values.to, '--to');
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (from.getTime() >= to.getTime()) throw new UsageError('--from must be before --to');
  if (to.getTime() > todayUtc + DAY_MS) throw new UsageError('--to must not be after tomorrow');

  const labelSample =
    values['label-sample'] === undefined
      ? null
      : intIn(values['label-sample'], '--label-sample', 1, 100_000);
  const seed =
    values.seed === undefined
      ? randomInt(0, MAX_SEED + 1)
      : intIn(values.seed, '--seed', 0, MAX_SEED);

  const out = resolve(ctx.cwd, values.out ?? defaultOutDir(now));
  if (values.out === undefined) await ensureDefaultParent(out);
  const parent = await stat(dirname(out)).catch(() => null);
  if (!parent?.isDirectory()) throw new UsageError('output parent directory does not exist');

  const manifest = await exportRun(ctx.pool(), {
    organizationIds,
    brandIds,
    from,
    to,
    labelSample,
    seed,
    out,
    now,
    jobRetentionDays: Math.ceil(loadJobsConfig(ctx.env).dedupWindowMs / DAY_MS),
  });
  ctx.out(out);
  ctx.out(`${manifest.itemCount} items, ${manifest.labelSheetCount} in the label sheet`);
  ctx.out(
    'label-sheet.csv contains comment text: keep it private and delete the run directory when done',
  );
  return 0;
};
