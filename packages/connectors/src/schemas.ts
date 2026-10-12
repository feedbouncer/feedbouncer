// Boundary validation for everything a connector returns. Connector output is
// derived from third-party data, so it is untrusted: ids are bounded and free
// of control characters, URLs are https only, bodies are bounded. Errors carry
// no input (zod issues are not attached), only the code invalid_connector_output.
import * as z from 'zod';
import { ConnectorError } from './errors.js';
import { MODERATION_ACTIONS, type NormalizedComment, type Page } from './types.js';

const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
export const externalIdSchema = z.string().min(1).max(255).regex(NO_CONTROL);
export const cursorSchema = z.string().min(1).max(2048).regex(NO_CONTROL).nullable();
const httpsUrl = z.url({ protocol: /^https$/ }).max(2048);
/** Postgres text cannot hold NUL, so it becomes U+FFFD. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replaceAll('\u0000', '\uFFFD'));

const authorSchema = z.strictObject({
  externalId: externalIdSchema,
  displayName: text(500).nullable(),
  profileUrl: httpsUrl.nullable(),
});

export const commentSchema = z
  .strictObject({
    externalId: externalIdSchema,
    sourceExternalId: externalIdSchema,
    parentExternalId: externalIdSchema.nullable(),
    author: authorSchema.nullable(),
    body: text(100_000),
    postedAt: z.date(),
    platformState: z.enum(['visible', 'hidden', 'deleted']),
    permalink: httpsUrl.nullable(),
  })
  .refine((c) => c.parentExternalId !== c.externalId);

export const sourceSchema = z.strictObject({
  externalId: externalIdSchema,
  kind: z.enum(['organic_post', 'ad_post', 'video', 'thread']),
  permalink: httpsUrl.nullable(),
  active: z.boolean(),
});

export const commentRefSchema = z.strictObject({
  sourceExternalId: externalIdSchema,
  externalId: externalIdSchema,
});

export const actionRequestSchema = z.strictObject({
  action: z.enum(MODERATION_ACTIONS),
  target: commentRefSchema,
});

export const inboundEventsSchema = z
  .array(
    z.strictObject({
      type: z.enum(['comment.created', 'comment.updated', 'comment.deleted']),
      externalAccountId: externalIdSchema,
      ref: commentRefSchema,
      occurredAt: z.date(),
    }),
  )
  .max(1000);

const invalid = () => new ConnectorError('permanent', 'invalid_connector_output');

export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid();
  return r.data;
}

export const parseComment = (raw: unknown): NormalizedComment => parseWith(commentSchema, raw);

export function parsePage<T extends { externalId: string }>(
  item: z.ZodType<T>,
  raw: unknown,
): Page<T> {
  const page = parseWith(
    z.strictObject({ items: z.array(z.unknown()).max(500), nextCursor: cursorSchema }),
    raw,
  );
  const seen = new Set<string>();
  const items: T[] = [];
  for (const it of page.items) {
    const parsed = parseWith(item, it);
    if (seen.has(parsed.externalId)) continue;
    seen.add(parsed.externalId);
    items.push(parsed);
  }
  return { items, nextCursor: page.nextCursor };
}
