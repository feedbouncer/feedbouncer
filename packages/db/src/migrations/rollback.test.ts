import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  PRISMA_MIGRATE_LOCK_ID,
  RollbackError,
  listMigrationDirs,
  rollbackLatest,
} from './rollback.js';

type Row = Record<string, unknown>;
function fakeClient(answers: {
  ledgerExists?: boolean;
  failed?: string[];
  latest?: string | null;
  failOn?: RegExp;
}) {
  const calls: { text: string; values?: unknown[] | undefined }[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (answers.failOn?.test(text)) throw new Error('boom');
      if (text.includes('to_regclass'))
        return {
          rows: [{ t: answers.ledgerExists === false ? null : '_prisma_migrations' }],
          rowCount: 1,
        };
      if (text.includes('finished_at IS NULL'))
        return {
          rows: (answers.failed ?? []).map((m) => ({ migration_name: m })),
          rowCount: answers.failed?.length ?? 0,
        };
      if (text.includes('ORDER BY migration_name DESC')) {
        const rows: Row[] = answers.latest ? [{ migration_name: answers.latest }] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.ClientBase;
  return { client, calls, texts: () => calls.map((c) => c.text) };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fb-mig-'));
  await mkdir(path.join(dir, '20261011000100_tenancy'));
  await writeFile(path.join(dir, '20261011000100_tenancy', 'down.sql'), 'DROP TABLE organization;');
  await mkdir(path.join(dir, 'not_a_migration'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('listMigrationDirs', () => {
  it('returns only well-formed names, sorted', async () => {
    await mkdir(path.join(dir, '20261010000000_processed_job'));
    expect(await listMigrationDirs(dir)).toEqual([
      '20261010000000_processed_job',
      '20261011000100_tenancy',
    ]);
  });
});

describe('rollbackLatest', () => {
  it('runs down.sql and deletes the ledger row inside one transaction, under the Prisma lock', async () => {
    const f = fakeClient({ latest: '20261011000100_tenancy' });
    expect(await rollbackLatest(f.client, dir)).toEqual({
      status: 'rolled_back',
      migration: '20261011000100_tenancy',
    });
    const t = f.texts();
    expect(t[0]).toMatch(/pg_advisory_lock/);
    expect(f.calls[0]!.values).toEqual([PRISMA_MIGRATE_LOCK_ID]);
    const begin = t.indexOf('BEGIN');
    expect(t.slice(begin)).toEqual([
      'BEGIN',
      'DROP TABLE organization;',
      'DELETE FROM _prisma_migrations WHERE migration_name = $1',
      'COMMIT',
      expect.stringMatching(/pg_advisory_unlock/),
    ]);
  });

  it('reports nothing to roll back when the ledger table is missing or empty', async () => {
    expect(await rollbackLatest(fakeClient({ ledgerExists: false }).client, dir)).toEqual({
      status: 'nothing_to_roll_back',
    });
    expect(await rollbackLatest(fakeClient({ latest: null }).client, dir)).toEqual({
      status: 'nothing_to_roll_back',
    });
  });

  it('refuses while a failed migration is unresolved, and names the recovery command', async () => {
    const f = fakeClient({ failed: ['20261011000200_content'], latest: '20261011000100_tenancy' });
    await expect(rollbackLatest(f.client, dir)).rejects.toThrow(
      /prisma migrate resolve --rolled-back 20261011000200_content/,
    );
    expect(f.texts()).not.toContain('BEGIN');
    expect(f.texts().at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it.each(['../../etc', '20261011000100_tenancy/../../x', '20991231000000_unknown'])(
    'refuses a ledger name that is not a known directory: %s',
    async (name) => {
      const f = fakeClient({ latest: name });
      await expect(rollbackLatest(f.client, dir)).rejects.toBeInstanceOf(RollbackError);
      expect(f.texts()).not.toContain('BEGIN');
    },
  );

  it('refuses when down.sql is missing', async () => {
    await mkdir(path.join(dir, '20261012000000_no_down'));
    const f = fakeClient({ latest: '20261012000000_no_down' });
    await expect(rollbackLatest(f.client, dir)).rejects.toThrow(/down\.sql/);
    expect(f.texts()).not.toContain('BEGIN');
  });

  it('rolls back the transaction and still unlocks when down.sql fails', async () => {
    const f = fakeClient({ latest: '20261011000100_tenancy', failOn: /^DROP TABLE/ });
    await expect(rollbackLatest(f.client, dir)).rejects.toThrow('boom');
    const t = f.texts();
    expect(t).toContain('ROLLBACK');
    expect(t).not.toContain('COMMIT');
    expect(t.at(-1)).toMatch(/pg_advisory_unlock/);
  });
});
