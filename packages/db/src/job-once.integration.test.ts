import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { runJobOnce } from './job-once.js';

// Not a Turborepo task: integration tests run via `test:integration`, outside the task graph.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const raw = process.env.DATABASE_URL;
if (!raw) {
  throw new Error(
    'DATABASE_URL must be set for integration tests (start the stack with compose.expose-db.yaml).',
  );
}

let pool: Pool;
const queue = `test_${randomUUID()}`;
const key = (jobId: string, workerId = 'w1') => ({ queue, jobId, workerId });

beforeAll(() => {
  pool = createPool(new URL(raw), {
    applicationName: 'db-integration-test',
    max: 12,
    onIdleError: () => {},
  });
});
afterAll(async () => {
  await pool.query('DELETE FROM processed_job WHERE queue = $1', [queue]);
  await pool.end();
});

async function row(jobId: string) {
  const { rows } = await pool.query(
    'SELECT processed_by, duplicate_deliveries FROM processed_job WHERE queue = $1 AND job_id = $2',
    [queue, jobId],
  );
  return rows[0] as { processed_by: string; duplicate_deliveries: number } | undefined;
}

describe('runJobOnce', () => {
  it('processes the first delivery and refuses the second', async () => {
    let calls = 0;
    const work = async () => {
      calls += 1;
    };
    expect(await runJobOnce(pool, key('a'), work)).toBe('processed');
    expect(await runJobOnce(pool, key('a', 'w2'), work)).toBe('duplicate');
    expect(calls).toBe(1);
    expect(await row('a')).toEqual({ processed_by: 'w1', duplicate_deliveries: 1 });
  });

  it('commits work done on the provided client together with the claim', async () => {
    await runJobOnce(pool, key('b'), async (client) => {
      await client.query(
        'UPDATE processed_job SET processed_by = $3 WHERE queue = $1 AND job_id = $2',
        [queue, 'b', 'written-inside-work'],
      );
    });
    expect((await row('b'))?.processed_by).toBe('written-inside-work');
  });

  it('leaves no trace when work fails, so a retry processes', async () => {
    await expect(
      runJobOnce(pool, key('c'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await row('c')).toBeUndefined();
    expect(await runJobOnce(pool, key('c'), async () => {})).toBe('processed');
  });

  it('rejects when work swallows a failed statement, since the transaction is aborted', async () => {
    await expect(
      runJobOnce(pool, key('e'), async (client) => {
        try {
          await client.query('SELECT * FROM table_that_does_not_exist');
        } catch {
          // swallowed on purpose: the transaction is now aborted
        }
      }),
    ).rejects.toThrow();
    expect(await row('e')).toBeUndefined();
    expect(await runJobOnce(pool, key('e'), async () => {})).toBe('processed');
  });

  it('lets exactly one of many concurrent deliveries do the work', async () => {
    let calls = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runJobOnce(pool, key('d', `w${i}`), async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 50));
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(9);
    expect((await row('d'))?.duplicate_deliveries).toBe(9);
  });

  it('treats hostile-looking ids as plain data (parameterized SQL)', async () => {
    const jobId = `x'); DROP TABLE processed_job; --`;
    expect(await runJobOnce(pool, key(jobId), async () => {})).toBe('processed');
    expect(await row(jobId)).toBeDefined();
  });
});
