import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError } from '@feedbouncer/jobs';
import { buildReport, readRun, renderMarkdown, stableJson } from '@feedbouncer/evaluation';
import type { OpsCommand } from './ops-context.js';

export const EVAL_REPORT_USAGE = 'usage: pnpm ops eval-report --run <dir>';

/** Reads a run directory and writes report.json and report.md into it. Never touches the database. */
export const evalReportCommand: OpsCommand = async (argv, ctx) => {
  let run: string | undefined;
  try {
    ({
      values: { run },
    } = parseArgs({ args: [...argv], options: { run: { type: 'string' } }, strict: true }));
  } catch {
    throw new UsageError('invalid arguments');
  }
  if (!run) throw new UsageError('--run is required');
  const dir = resolve(run);

  const report = buildReport(await readRun(dir));
  const markdownPath = join(dir, 'report.md');
  await writeFile(join(dir, 'report.json'), stableJson(report), { flag: 'w', mode: 0o600 });
  await writeFile(markdownPath, renderMarkdown(report), { flag: 'w', mode: 0o600 });
  ctx.out(markdownPath);
  return 0;
};
