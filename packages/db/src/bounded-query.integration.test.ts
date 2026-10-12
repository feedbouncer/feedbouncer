import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { boundedQuery } from './bounded-query.js';
import { createPool } from './pool.js';

// Not a Turborepo task: integration tests run via `test:integration`, outside the task graph.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const raw = process.env.DATABASE_URL;
if (!raw) {
  throw new Error(
    'DATABASE_URL must be set for integration tests (start the stack with compose.expose-db.yaml).',
  );
}

let pool: Pool;
beforeAll(() => {
  pool = createPool(new URL(raw), {
    applicationName: 'db-bounded-query-test',
    onIdleError: () => {},
  });
});
afterAll(() => pool.end());

describe('boundedQuery', () => {
  it('a slow statement is cancelled by the statement timeout and the pool stays usable', async () => {
    await expect(boundedQuery(pool, 'SELECT pg_sleep(5)', [], 200)).rejects.toThrow(
      /statement timeout/,
    );
    const rows = await boundedQuery<{ n: number }>(pool, 'SELECT 1 AS n', [], 1000);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('rejects writes', async () => {
    await expect(boundedQuery(pool, 'CREATE TEMP TABLE t (x int)', [], 1000)).rejects.toThrow(
      /read-only/,
    );
  });
});
