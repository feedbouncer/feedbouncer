// Boundary validation for everything a connector returns. Connector output is
// derived from third-party data, so it is untrusted: ids are bounded and free
// of control characters, URLs are https only, bodies are bounded. Errors carry
// no input (zod issues are not attached), only the code invalid_connector_output.
import * as z from 'zod';
import { ConnectorError } from './errors.js';
import { Secret } from '@feedbouncer/service-runtime';
import { MODERATION_ACTIONS, RESPONSE_KINDS, type NormalizedComment, type Page } from './types.js';

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

const digits = z.string().regex(/^\d{1,32}$/);
const placementSchema = z
  .strictObject({
    platform: z.enum(['facebook', 'instagram']),
    accountExternalId: digits.nullable(),
    sourceExternalId: z
      .string()
      .regex(/^\d{1,32}(_\d{1,32})?$/)
      .nullable(),
    unresolvedReason: z
      .enum([
        'no_post',
        'dynamic_creative_unsupported',
        'post_deleted',
        'invalid_platform_id',
        'instagram_media_pending',
        'not_instagram',
      ])
      .nullable(),
  })
  .refine((p) => (p.sourceExternalId === null) !== (p.unresolvedReason === null));
const adInfoSchema = z.strictObject({
  adAccountExternalId: digits,
  effectiveStatus: z.string().regex(/^[A-Z_]{1,40}$/),
  placements: z
    .array(placementSchema)
    .length(2)
    .refine((ps) => new Set(ps.map((p) => p.platform)).size === 2),
});

export const sourceSchema = z.strictObject({
  externalId: externalIdSchema,
  kind: z.enum(['organic_post', 'ad_post', 'video', 'thread']),
  permalink: httpsUrl.nullable(),
  active: z.boolean(),
  ad: adInfoSchema.optional(),
});

export const recentSourceSchema = z.strictObject({
  externalId: externalIdSchema,
  createdAt: z.date().refine((d) => !Number.isNaN(d.getTime())),
  permalink: httpsUrl.nullable(),
});

export const commentRefSchema = z.strictObject({
  sourceExternalId: externalIdSchema,
  externalId: externalIdSchema,
});

export const actionRequestSchema = z.strictObject({
  action: z.enum(MODERATION_ACTIONS),
  target: commentRefSchema,
  authorExternalId: externalIdSchema.optional(),
});

const REPLY_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const replyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(8000)
  .refine((s) => !REPLY_FORBIDDEN.test(s));

export const respondRequestSchema = z.strictObject({
  kind: z.enum(RESPONSE_KINDS),
  target: commentRefSchema,
  text: replyTextSchema,
});

const SNAKE = /^[a-z][a-z0-9_]{0,62}$/;
export const grantableAccountSchema = z.strictObject({
  externalAccountId: externalIdSchema,
  displayName: z.string().max(500).nullable(),
  eligible: z.boolean(),
  ineligibleReason: z.string().regex(SNAKE).nullable(),
  limitations: z.array(z.string().regex(SNAKE)).max(20),
  accessToken: z.instanceof(Secret),
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
