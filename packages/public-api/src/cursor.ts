import { createHash } from 'node:crypto';
import { z } from 'zod';

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

type Filters = Record<string, string | undefined>;

const CursorPayload = z.strictObject({
  v: z.literal(1),
  t: z.iso.datetime(),
  id: z.uuid(),
  f: z.string().regex(/^[0-9a-f]{16}$/),
});

function fingerprint(filters: Filters): string {
  const lines = Object.entries(filters)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex').slice(0, 16);
}

export function encodeCursor(position: { t: Date; id: string }, filters: Filters): string {
  const payload = { v: 1, t: position.t.toISOString(), id: position.id, f: fingerprint(filters) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw: string, filters: Filters): { t: Date; id: string } {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(json);
  if (!parsed.success || parsed.data.f !== fingerprint(filters)) throw new InvalidCursorError();
  return { t: new Date(parsed.data.t), id: parsed.data.id };
}
