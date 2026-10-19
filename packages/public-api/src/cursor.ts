import { createHash } from 'node:crypto';
import { z } from 'zod';

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

type Filters = Record<string, string | undefined>;

const base = {
  t: z.iso.datetime(),
  id: z.uuid(),
  f: z.string().regex(/^[0-9a-f]{16}$/),
};
const CursorPayload = z.discriminatedUnion('v', [
  z.strictObject({ v: z.literal(1), ...base }),
  z.strictObject({ v: z.literal(2), ...base, a: z.iso.datetime() }),
]);

function fingerprint(filters: Filters): string {
  const lines = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex').slice(0, 16);
}

/**
 * `asOf` pins the snapshot: later pages exclude rows ingested after the first page was read.
 * It is not part of the fingerprint, since a reader cannot supply it. Without it, a v1 cursor is written.
 */
export function encodeCursor(
  position: { t: Date; id: string },
  filters: Filters,
  asOf?: Date,
): string {
  const payload = {
    t: position.t.toISOString(),
    id: position.id,
    f: fingerprint(filters),
    ...(asOf ? { v: 2, a: asOf.toISOString() } : { v: 1 }),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** `asOf` is null for a v1 cursor, which carries no snapshot. */
export function decodeCursor(
  raw: string,
  filters: Filters,
): { t: Date; id: string; asOf: Date | null } {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(json);
  if (!parsed.success || parsed.data.f !== fingerprint(filters)) throw new InvalidCursorError();
  const { data } = parsed;
  return { t: new Date(data.t), id: data.id, asOf: data.v === 2 ? new Date(data.a) : null };
}
