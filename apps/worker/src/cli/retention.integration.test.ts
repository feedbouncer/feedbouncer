import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { UsageError } from '@feedbouncer/jobs';
import { migratedDb } from '@feedbouncer/db/testing';
import {
  RETENTION_CATEGORIES,
  loadRetentionSettings,
  publishRetentionStatus,
} from '@feedbouncer/privacy';
import { runRetention } from './retention.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'retention-cli-test', onIdleError: () => {} });
  await publishRetentionStatus(
    pool,
    loadRetentionSettings({ RETENTION_COMMENTS_DAYS: '30', RETENTION_AUDIT_DAYS: '90' }),
  );
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRetention(
    argv,
    { pool, log: silent },
    {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    },
  );
  return { code, out, err };
}

describe('pnpm ops retention', () => {
  it('refuses a confirmation that does not match the current setting', async () => {
    const r = await run('confirm', '--category', 'comments', '--days', '31', '--as', 'ops');
    expect(r.code).toBe(2);
    expect(r.err).toEqual(['Setting for comments is 30, not 31; nothing confirmed.']);
    expect((await h.c.query('SELECT 1 FROM retention_confirmation')).rowCount).toBe(0);
  });

  it('refuses a confirmation for a category kept forever', async () => {
    const r = await run('confirm', '--category', 'decisions', '--days', '30', '--as', 'ops');
    expect(r.code).toBe(2);
    expect(r.err).toEqual(['Setting for decisions is forever, not 30; nothing confirmed.']);
    expect((await h.c.query('SELECT 1 FROM retention_confirmation')).rowCount).toBe(0);
  });

  it('records a confirmation that matches', async () => {
    const r = await run('confirm', '--category', 'comments', '--days', '30', '--as', 'ops');
    expect(r.code).toBe(0);
    const { rows } = await h.c.query(
      'SELECT category, days, confirmed_by FROM retention_confirmation',
    );
    expect(rows).toEqual([{ category: 'comments', days: 30, confirmed_by: 'ops' }]);
  });

  it('previews one line per category', async () => {
    const r = await run('preview');
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(RETENTION_CATEGORIES.length);
    RETENTION_CATEGORIES.forEach((c, i) => expect(r.out[i]).toMatch(new RegExp(`^${c}: `)));
    expect(r.out[0]).toContain('days=30');
    expect(r.out[0]).toContain('confirmed=yes');
  });

  it('runs a purge and shows it in the status', async () => {
    const ran = await run('run');
    expect(ran.code).toBe(0);
    expect(ran.out[0]).toMatch(/^run [0-9a-f-]{36}: done/);

    const status = await run('status');
    expect(status.code).toBe(0);
    const text = status.out.join('\n');
    expect(text).toContain('comments: 30 days');
    expect(text).toContain('audit_below_recommended');
    expect(text).toMatch(/last run: done/);
  });

  it('tells the operator to start the worker when no settings are published yet', async () => {
    await h.c.query("UPDATE retention_status SET settings = '{}'::jsonb WHERE id = 1");
    try {
      const calls: string[][] = [
        ['status'],
        ['preview'],
        ['run'],
        ['confirm', '--category', 'comments', '--days', '30', '--as', 'ops'],
      ];
      for (const argv of calls) {
        const r = await run(...argv);
        expect(r.code).toBe(1);
        expect(r.out).toEqual([]);
        expect(r.err).toEqual([
          'No retention settings published yet: start the worker once, then retry.',
        ]);
      }
    } finally {
      await publishRetentionStatus(
        pool,
        loadRetentionSettings({ RETENTION_COMMENTS_DAYS: '30', RETENTION_AUDIT_DAYS: '90' }),
      );
    }
  });

  it('rejects an unknown subcommand as a usage error', async () => {
    await expect(run('nope')).rejects.toThrow(UsageError);
  });
});
