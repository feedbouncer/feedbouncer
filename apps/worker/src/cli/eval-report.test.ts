import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputError } from '@feedbouncer/evaluation';
import { UsageError } from '@feedbouncer/jobs';
import { evalExportCommand } from './eval-export.js';
import { evalReportCommand } from './eval-report.js';
import type { OpsContext } from './ops-context.js';

const ID1 = 'i_0000000000000001';
const ID2 = 'i_0000000000000002';
const ORG = '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f10';

function ctx(lines: string[] = []): OpsContext {
  return {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    env: {},
    out: (l) => lines.push(l),
    pool: () => {
      throw new Error('database must not be used');
    },
    producer: () => {
      throw new Error('producer must not be used');
    },
  };
}

const item = (id: string) => ({
  item: id,
  cohort: 'automatic',
  channel: 'webhook',
  platform: 'facebook',
  language: 'en',
  judgedVersionAvailable: true,
  ruleDecided: false,
  outcome: 'hidden',
  removalKind: 'hide',
  removalNoop: false,
  restored: false,
  selfReversed: false,
  decider: 'classifier',
  caughtByDecision: true,
  review: null,
  timing: null,
  modelCalls: [],
});

async function makeRun(labels?: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-report-'));
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      runSchemaVersion: 1,
      exportedAt: '2026-10-18T00:00:00.000Z',
      window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
      brandsScoped: false,
      itemCount: 2,
      labelSheetCount: 2,
      sample: null,
      excludedAuthorDeleted: 0,
      timingUnavailableBeforeRetention: 0,
      bytesPerComment: null,
      promptVersions: [],
      jobRetentionDays: 30,
    }),
  );
  await writeFile(
    join(dir, 'items.jsonl'),
    `${JSON.stringify(item(ID1))}\n${JSON.stringify(item(ID2))}\n`,
  );
  if (labels) {
    await mkdir(join(dir, 'labels'));
    for (const [name, body] of Object.entries(labels))
      await writeFile(join(dir, 'labels', name), body);
  }
  return dir;
}

describe('eval-report', () => {
  it('runs without a database and writes report.json and report.md', async () => {
    const dir = await makeRun({
      'a.csv': `item,labeller,verdict\n${ID1},a,should_hide\n${ID2},a,should_stay\n`,
      'b.csv': `item,labeller,verdict\n${ID1},b,should_hide\n${ID2},b,should_stay\n`,
    });
    const lines: string[] = [];
    expect(await evalReportCommand(['--run', dir], ctx(lines))).toBe(0);
    expect(lines).toEqual([join(dir, 'report.md')]);
    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('No pricing file was supplied');
    const json = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
      cost: { status: string };
    };
    expect(json.cost.status).toBe('no_pricing');
  });

  it('rejects a label for an unknown item, naming the file and row', async () => {
    const dir = await makeRun({
      'a.csv': `item,labeller,verdict\n${ID1},a,should_hide\ni_00000000000000ff,a,should_stay\n`,
    });
    const err = await evalReportCommand(['--run', dir], ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).message).toContain('labels');
  });

  it('requires --run', async () => {
    await expect(evalReportCommand([], ctx())).rejects.toBeInstanceOf(UsageError);
    await expect(evalReportCommand(['--bogus'], ctx())).rejects.toBeInstanceOf(UsageError);
  });
});

describe('eval-export argument validation', () => {
  const ok = ['--org', ORG, '--from', '2026-10-01', '--to', '2026-10-08'];
  it.each([
    ['non-uuid org', ['--org', 'nope', '--from', '2026-10-01', '--to', '2026-10-08']],
    ['no org', ['--from', '2026-10-01', '--to', '2026-10-08']],
    ['non-uuid brand', [...ok, '--brand', 'x']],
    ['from equal to', ['--org', ORG, '--from', '2026-10-08', '--to', '2026-10-08']],
    ['from after to', ['--org', ORG, '--from', '2026-10-09', '--to', '2026-10-08']],
    ['bad date', ['--org', ORG, '--from', '2026-02-31', '--to', '2026-10-08']],
    ['to in the far future', ['--org', ORG, '--from', '2026-10-01', '--to', '2999-01-01']],
    ['sample 0', [...ok, '--label-sample', '0']],
    ['sample too big', [...ok, '--label-sample', '100001']],
    ['sample not an integer', [...ok, '--label-sample', '1.5']],
    ['negative seed', [...ok, '--seed', '-1']],
    ['seed too big', [...ok, '--seed', '4294967296']],
    ['unknown flag', [...ok, '--x', '1']],
    ['missing parent', [...ok, '--out', '/nonexistent-parent-dir/run']],
  ])('rejects %s', async (_name, argv) => {
    await expect(evalExportCommand(argv, ctx())).rejects.toBeInstanceOf(UsageError);
  });
});
