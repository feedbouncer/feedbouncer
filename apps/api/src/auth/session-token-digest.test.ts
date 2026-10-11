import { describe, expect, it } from 'vitest';
import type { DBAdapter } from 'better-auth/adapters';
import { digestSessionToken, withSessionTokenDigests } from './session-token-digest.js';

type Call = { method: string; args: Record<string, unknown> };

/** Records calls and answers every read with a row carrying the stored digest of "raw-1". */
function fakeAdapter(calls: Call[]): DBAdapter {
  const row = { id: 's1', token: digestSessionToken('raw-1'), userId: 'u1' };
  const rec =
    (method: string, result: unknown) =>
    async (args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, args });
      return result;
    };
  const base = {
    id: 'fake',
    create: async (args: { data: Record<string, unknown> }) => {
      calls.push({ method: 'create', args });
      return { id: 's1', ...args.data };
    },
    findOne: rec('findOne', row),
    findMany: rec('findMany', [row]),
    count: rec('count', 1),
    update: rec('update', row),
    updateMany: rec('updateMany', 1),
    delete: rec('delete', undefined),
    deleteMany: rec('deleteMany', 1),
    consumeOne: rec('consumeOne', row),
    incrementOne: rec('incrementOne', row),
  };
  return {
    ...base,
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => cb(base),
  } as unknown as DBAdapter;
}

describe('withSessionTokenDigests', () => {
  it('stores the digest and hands the raw token back on create', async () => {
    const calls: Call[] = [];
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter(calls)));
    const res = await a.create<{ token: string }>({ model: 'session', data: { token: 'raw-1' } });
    expect(calls[0]!.args.data).toEqual({ token: digestSessionToken('raw-1') });
    expect(res.token).toBe('raw-1');
  });

  it('digests token filters and restores the raw token on rows found by it', async () => {
    const calls: Call[] = [];
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter(calls)));
    const found = await a.findOne<{ token: string }>({
      model: 'session',
      where: [{ field: 'token', value: 'raw-1' }],
    });
    expect(calls[0]!.args.where).toEqual([{ field: 'token', value: digestSessionToken('raw-1') }]);
    expect(found!.token).toBe('raw-1');
    const many = await a.findMany<{ token: string }>({
      model: 'session',
      where: [{ field: 'token', operator: 'in', value: ['raw-1', 'raw-2'] }],
    });
    expect(calls[1]!.args.where).toEqual([
      {
        field: 'token',
        operator: 'in',
        value: [digestSessionToken('raw-1'), digestSessionToken('raw-2')],
      },
    ]);
    expect(many[0]!.token).toBe('raw-1');
  });

  it('leaves the digest on rows not found by token', async () => {
    const calls: Call[] = [];
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter(calls)));
    const rows = await a.findMany<{ token: string }>({
      model: 'session',
      where: [{ field: 'userId', value: 'u1' }],
    });
    expect(rows[0]!.token).toBe(digestSessionToken('raw-1'));
  });

  it('wraps transaction adapters too', async () => {
    const calls: Call[] = [];
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter(calls)));
    await a.transaction((trx) =>
      trx.delete({ model: 'session', where: [{ field: 'token', value: 'raw-1' }] }),
    );
    expect(calls[0]!.args.where).toEqual([{ field: 'token', value: digestSessionToken('raw-1') }]);
  });

  it('refuses token filters that cannot work on a digest', async () => {
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter([])));
    await expect(
      a.findMany({
        model: 'session',
        where: [{ field: 'token', operator: 'starts_with', value: 'raw' }],
      }),
    ).rejects.toThrow('unsupported session token filter: starts_with');
  });

  it('passes other models through untouched', async () => {
    const calls: Call[] = [];
    const a = withSessionTokenDigests(Promise.resolve(fakeAdapter(calls)));
    const where = [{ field: 'token', value: 'not-a-session' }];
    await a.findOne({ model: 'verification', where });
    expect(calls[0]!.args.where).toBe(where);
  });
});
