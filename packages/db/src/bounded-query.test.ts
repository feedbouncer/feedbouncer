import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { boundedQuery } from './bounded-query.js';

function fakePool(onQuery: (text: string) => unknown = () => ({ rows: [] })) {
  const statements: string[] = [];
  const released: Array<boolean | undefined> = [];
  const client = {
    query: async (text: string) => {
      statements.push(text);
      return onQuery(text);
    },
    release: (destroy?: boolean) => released.push(destroy),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, released };
}

describe('boundedQuery', () => {
  it('runs one statement in a read-only transaction with a local statement timeout', async () => {
    const f = fakePool((text) => (text === 'SELECT 1' ? { rows: [{ n: 1 }] } : { rows: [] }));
    await expect(boundedQuery(f.pool, 'SELECT 1', [], 250)).resolves.toEqual([{ n: 1 }]);
    expect(f.statements).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('statement_timeout', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(f.released).toEqual([undefined]);
  });

  it('destroys the connection when a statement fails', async () => {
    const f = fakePool((text) => {
      if (text === 'SELECT 1') throw new Error('boom');
      return { rows: [] };
    });
    await expect(boundedQuery(f.pool, 'SELECT 1', [], 250)).rejects.toThrow('boom');
    expect(f.released).toEqual([true]);
  });

  it('gives up after the client-side bound even when the statement never returns', async () => {
    const f = fakePool((text) => (text === 'SELECT 1' ? new Promise(() => {}) : { rows: [] }));
    await expect(boundedQuery(f.pool, 'SELECT 1', [], 10)).rejects.toThrow(/timed out/);
  });
});
