// Stores session tokens as SHA-256 digests. Better Auth has no option for
// this (verification identifiers have one, see auth.ts), so the database
// adapter is wrapped: every session write and every lookup by token goes
// through sha256, and rows read back by token get the caller's raw token again,
// because Better Auth sets the cookie from the returned row (on sign-in and on
// session refresh). A database leak therefore yields digests, which do not
// authenticate.
//
// Rows not looked up by token (for example a list by user id) come back with
// the digest in `token`. Better Auth's list/revoke-session endpoints rely on
// those values and must stay unreachable; the API proxy does not expose them.
import { createHash } from 'node:crypto';
import type { DBAdapter, DBTransactionAdapter, Where } from 'better-auth/adapters';

const SESSION_MODELS = new Set(['session', 'auth_session']);

export function digestSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Digest -> raw token, for the tokens one call was given. */
type Known = Map<string, string>;

function digest(raw: unknown, known: Known): string {
  if (typeof raw !== 'string') throw new TypeError('session token must be a string');
  const d = digestSessionToken(raw);
  known.set(d, raw);
  return d;
}

function digestWhere(where: Where[] | undefined, known: Known): Where[] | undefined {
  return where?.map((w) => {
    if (w.field !== 'token') return w;
    const op = w.operator ?? 'eq';
    if (op === 'eq' || op === 'ne') return { ...w, value: digest(w.value, known) };
    if ((op === 'in' || op === 'not_in') && Array.isArray(w.value)) {
      return { ...w, value: (w.value as unknown[]).map((v) => digest(v, known)) };
    }
    // Range or substring matches on a digest are meaningless; fail closed.
    throw new Error(`unsupported session token filter: ${op}`);
  });
}

function digestValues(
  values: Record<string, unknown> | undefined,
  known: Known,
): Record<string, unknown> | undefined {
  if (!values || !('token' in values)) return values;
  return { ...values, token: digest(values.token, known) };
}

function restore<T>(row: T, known: Known): T {
  if (Array.isArray(row)) return row.map((r: unknown) => restore(r, known)) as T;
  if (row && typeof row === 'object' && 'token' in row) {
    const raw = known.get((row as { token: unknown }).token as string);
    if (raw !== undefined) return { ...row, token: raw };
  }
  return row;
}

type Args = {
  model: string;
  where?: Where[] | undefined;
  data?: Record<string, unknown> | undefined;
  update?: Record<string, unknown> | undefined;
};

const METHODS = [
  'create',
  'findOne',
  'findMany',
  'count',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'consumeOne',
  'incrementOne',
] as const;

function wrapMethods(get: () => Promise<DBTransactionAdapter>): DBTransactionAdapter {
  const out: Record<string, (args: Args) => Promise<unknown>> = {};
  for (const name of METHODS) {
    out[name] = async (args) => {
      const inner = (await get()) as unknown as Record<string, (a: Args) => Promise<unknown>>;
      if (!SESSION_MODELS.has(args.model)) return inner[name]!(args);
      const known: Known = new Map();
      const res = await inner[name]!({
        ...args,
        ...('where' in args ? { where: digestWhere(args.where, known) } : {}),
        ...('data' in args ? { data: digestValues(args.data, known) } : {}),
        ...('update' in args ? { update: digestValues(args.update, known) } : {}),
      });
      return restore(res, known);
    };
  }
  return { id: 'kysely-session-digest', ...out } as unknown as DBTransactionAdapter;
}

/** Wraps Better Auth's own adapter (created asynchronously) so session tokens are stored as digests. */
export function withSessionTokenDigests(adapter: Promise<DBAdapter>): DBAdapter {
  return {
    ...wrapMethods(() => adapter),
    transaction: async (cb) =>
      (await adapter).transaction((trx) => cb(wrapMethods(() => Promise.resolve(trx)))),
  };
}
