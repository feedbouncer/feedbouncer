import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from './transaction.js';

function fakePool(commitTag = 'COMMIT', failOn?: string) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === failOn) throw new Error('boom');
      return { command: sql === 'COMMIT' ? commitTag : sql, rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as never, client, calls };
}

describe('withTransaction', () => {
  it('commits and returns the work result', async () => {
    const f = fakePool();
    await expect(withTransaction(f.pool, async () => 42)).resolves.toBe(42);
    expect(f.calls).toEqual(['BEGIN', 'COMMIT']);
    expect(f.client.release).toHaveBeenCalledWith(false);
  });
  it('opens the transaction at the requested isolation level', async () => {
    const f = fakePool();
    await withTransaction(f.pool, async () => 1, { isolation: 'repeatable read' });
    expect(f.calls).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'COMMIT']);
  });
  it('rolls back and rethrows when work throws', async () => {
    const f = fakePool();
    await expect(
      withTransaction(f.pool, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(f.calls).toEqual(['BEGIN', 'ROLLBACK']);
  });
  it('treats a COMMIT answered with ROLLBACK as failure', async () => {
    const f = fakePool('ROLLBACK');
    await expect(withTransaction(f.pool, async () => 1)).rejects.toThrow(/rolled back/);
  });
  it('discards the client when ROLLBACK itself fails', async () => {
    const f = fakePool('COMMIT', 'ROLLBACK');
    await expect(
      withTransaction(f.pool, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(f.client.release).toHaveBeenCalledWith(true);
  });
});
