import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_INPUT_FILE_BYTES, RUN_SCHEMA_VERSION } from './constants.js';
import { UsageError } from '@feedbouncer/jobs';
import { parse } from 'csv-parse/sync';
import {
  InputError,
  LABEL_SHEET_COLUMNS,
  createRunDir,
  labelSheetCsv,
  readRun,
  writeRunFile,
} from './io.js';

const ID1 = 'i_0000000000000001';
const ID2 = 'i_0000000000000002';

const manifest = {
  runSchemaVersion: RUN_SCHEMA_VERSION,
  exportedAt: '2026-10-18T00:00:00Z',
  window: { from: '2026-10-01', to: '2026-10-17' },
  brandsScoped: true,
  itemCount: 1,
  labelSheetCount: 1,
  sample: null,
  excludedAuthorDeleted: 0,
  timingUnavailableBeforeRetention: 0,
  bytesPerComment: null,
  promptVersions: [],
  jobRetentionDays: 30,
};

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

async function makeRun(opts: { items?: string; labels?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-run-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(
    join(dir, 'items.jsonl'),
    opts.items ?? `${JSON.stringify(item(ID1))}\n${JSON.stringify(item(ID2))}\n`,
  );
  if (opts.labels) {
    await mkdir(join(dir, 'labels'));
    for (const [name, body] of Object.entries(opts.labels)) {
      await writeFile(join(dir, 'labels', name), body);
    }
  }
  return dir;
}

describe('readRun', () => {
  it('parses an Excel-saved CSV', async () => {
    const csv =
      '﻿text,verdict,item,labeller\r\n' +
      `"hello, ""world""",should_hide,${ID1},ann\r\n` +
      `plain,should_stay,${ID2},bob\r\n`;
    const dir = await makeRun({ labels: { 'a.csv': csv } });
    const run = await readRun(dir);
    expect(run.items).toHaveLength(2);
    expect(run.labels).toEqual([
      { item: ID1, labeller: 'ann', verdict: 'should_hide' },
      { item: ID2, labeller: 'bob', verdict: 'should_stay' },
    ]);
    expect(run.meta).toBeNull();
    expect(run.pricing).toBeNull();
    const digest = run.inputDigests.find((d) => d.file === 'manifest.json');
    expect(digest?.sha256).toBe(
      createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    );
    expect(run.inputDigests.map((d) => d.file)).toContain('labels/a.csv');
  });

  it('sorts label files by name', async () => {
    const dir = await makeRun({
      labels: {
        'b.csv': `item,labeller,verdict\n${ID2},bob,should_stay\n`,
        'a.csv': `item,labeller,verdict\n${ID1},ann,should_hide\n`,
      },
    });
    const run = await readRun(dir);
    expect(run.labels.map((l) => l.labeller)).toEqual(['ann', 'bob']);
  });

  it('error names file, row and field but not content', async () => {
    const dir = await makeRun({
      labels: { 'a.csv': `item,labeller,verdict\n${ID1},ann,=HYPERLINK("x")\n` },
    });
    const err = await readRun(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InputError);
    const msg = (err as InputError).message;
    expect(msg).toContain('labels/a.csv');
    expect(msg).toContain('row 2');
    expect(msg).toContain('verdict');
    expect(msg).not.toContain('HYPERLINK');
  });

  it('rejects duplicate header names and ignores unknown columns', async () => {
    const dup = await makeRun({
      labels: { 'a.csv': `item,labeller,verdict,verdict\n${ID1},ann,should_hide,should_hide\n` },
    });
    await expect(readRun(dup)).rejects.toBeInstanceOf(InputError);
    const proto = await makeRun({
      labels: { 'a.csv': `item,labeller,verdict,__proto__,extra\n${ID1},ann,should_hide,x,y\n` },
    });
    const run = await readRun(proto);
    expect(run.labels).toEqual([{ item: ID1, labeller: 'ann', verdict: 'should_hide' }]);
  });

  it('rejects a ragged row without echoing content', async () => {
    const dir = await makeRun({
      labels: { 'a.csv': `item,labeller,verdict\n${ID1},SECRETCELL\n` },
    });
    const err = (await readRun(dir).catch((e: unknown) => e)) as InputError;
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).not.toContain('SECRETCELL');
  });

  it('rejects symlinked input', async () => {
    const dir = await makeRun();
    const other = await makeRun();
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, 'items.jsonl'));
    await symlink(join(other, 'items.jsonl'), join(dir, 'items.jsonl'));
    await expect(readRun(dir)).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a file over MAX_INPUT_FILE_BYTES', async () => {
    const dir = await makeRun();
    const { truncate } = await import('node:fs/promises');
    await truncate(join(dir, 'items.jsonl'), MAX_INPUT_FILE_BYTES + 1);
    await expect(readRun(dir)).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a missing manifest or items file', async () => {
    const dir = await makeRun();
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, 'manifest.json'));
    await expect(readRun(dir)).rejects.toBeInstanceOf(InputError);
    const dir2 = await makeRun();
    await rm(join(dir2, 'items.jsonl'));
    await expect(readRun(dir2)).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a duplicate item id and names the line', async () => {
    const line = JSON.stringify(item(ID1));
    const dir = await makeRun({ items: `${line}\n${line}\n` });
    const err = (await readRun(dir).catch((e: unknown) => e)) as InputError;
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).toContain('line 2');
  });

  it('rejects meta.csv without meta-config.json', async () => {
    const dir = await makeRun();
    await writeFile(join(dir, 'meta.csv'), `item,meta_outcome\n${ID1},hidden\n`);
    await expect(readRun(dir)).rejects.toBeInstanceOf(InputError);
  });

  it('reads meta with its config', async () => {
    const dir = await makeRun();
    await writeFile(join(dir, 'meta.csv'), `item,meta_outcome\n${ID1},hidden\n`);
    await writeFile(
      join(dir, 'meta-config.json'),
      JSON.stringify({
        observedOn: '2026-10-10',
        page: 'test page',
        profanityFilter: 'off',
        blockedKeywords: [],
        method: 'm',
        notCompared: [],
      }),
    );
    const run = await readRun(dir);
    expect(run.meta).toEqual([{ item: ID1, meta_outcome: 'hidden' }]);
    expect(run.metaConfig?.page).toBe('test page');
  });

  it('reports invalid JSON by line without content', async () => {
    const dir = await makeRun({ items: 'not json SECRET\n' });
    const err = (await readRun(dir).catch((e: unknown) => e)) as InputError;
    expect(err).toBeInstanceOf(InputError);
    expect(err.message).toContain('line 1');
    expect(err.message).not.toContain('SECRET');
  });
});

describe('run writers', () => {
  const sheetRows = [
    { item: ID1, platform: 'facebook', text: '=1+1' },
    { item: ID2, platform: 'instagram', text: '@cmd, "quoted"' },
  ];

  it('label sheet escapes formulas', () => {
    const csv = labelSheetCsv(sheetRows);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const records = parse(csv, { bom: true }) as string[][];
    expect(records[1]).toEqual([ID1, 'facebook', "'=1+1", '', '', '', '', '']);
    expect(records[2]![2]).toBe(`'@cmd, "quoted"`);
  });

  it('label sheet has no outcome columns', () => {
    const records = parse(labelSheetCsv(sheetRows), { bom: true }) as string[][];
    expect(records[0]!.join(',')).toBe('item,platform,text,labeller,verdict,category,role,note');
    expect(LABEL_SHEET_COLUMNS.join(',')).toBe(
      'item,platform,text,labeller,verdict,category,role,note',
    );
  });

  it('out dir is 0700, files 0600, existing dir refused', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'eval-out-'));
    const dir = join(parent, 'run');
    await createRunDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await writeRunFile(dir, 'items.jsonl', 'x\n');
    expect((await stat(join(dir, 'items.jsonl'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'items.jsonl'), 'utf8')).toBe('x\n');
    await expect(writeRunFile(dir, 'items.jsonl', 'y')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(createRunDir(dir)).rejects.toBeInstanceOf(UsageError);
    await expect(createRunDir(join(parent, 'missing', 'run'))).rejects.toBeInstanceOf(UsageError);
  });
});
