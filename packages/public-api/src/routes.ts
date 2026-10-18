import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';
import type { ApiKeyScope } from './keys/token.js';
import { CommentResource } from './resources/comment.js';
import { FlaggedItemResource } from './resources/flagged-item.js';
import { pageOf } from './resources/page.js';

/** Codes may be added, never renamed: integrations match on them. */
export const PUBLIC_ERROR_CODES = [
  'invalid_request',
  'invalid_cursor',
  'unauthenticated',
  'insufficient_scope',
  'not_found',
  'rate_limited',
  'temporarily_unavailable',
  'internal_error',
  'idempotency_key_reused',
  'idempotency_request_in_progress',
  'invalid_idempotency_key',
  'connection_inactive',
  'unsupported_action',
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export const PUBLIC_ERROR_STATUS: Readonly<Record<PublicErrorCode, number>> = {
  invalid_request: 400,
  invalid_cursor: 400,
  invalid_idempotency_key: 400,
  unauthenticated: 401,
  insufficient_scope: 403,
  not_found: 404,
  idempotency_request_in_progress: 409,
  connection_inactive: 409,
  idempotency_key_reused: 422,
  unsupported_action: 422,
  rate_limited: 429,
  internal_error: 500,
  temporarily_unavailable: 503,
};

export interface RouteSpec {
  /** operationId */
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI form, e.g. '/v1/comments/{id}' */
  readonly path: `/v1/${string}`;
  /** Null only for the unauthenticated document route. */
  readonly scope: ApiKeyScope | null;
  readonly summary: string;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodObject;
  /** The request body may be omitted. */
  readonly bodyOptional?: boolean;
  /** Accepts the Idempotency-Key header. */
  readonly idempotent: boolean;
  /** Success responses by status; null means no body. */
  readonly responses: Readonly<Record<number, z.ZodType | null>>;
  /** Errors specific to this route; the ones every authenticated route can return are added by the generator. */
  readonly errors: readonly PublicErrorCode[];
}

const timestamp = z.iso.datetime({ offset: true });

export const ListCommentsQuery = z.strictObject({
  status: z.enum(['visible', 'hidden', 'flagged']).optional(),
  brandId: z.uuid().optional(),
  postedFrom: timestamp.optional().meta({ description: 'Inclusive. ISO 8601 with an offset.' }),
  postedTo: timestamp.optional().meta({ description: 'Exclusive. ISO 8601 with an offset.' }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(512).optional(),
});

export const ListFlaggedItemsQuery = z.strictObject({
  status: z.enum(['open', 'resolved']).default('open'),
  brandId: z.uuid().optional(),
  createdFrom: timestamp.optional().meta({ description: 'Inclusive. ISO 8601 with an offset.' }),
  createdTo: timestamp.optional().meta({ description: 'Exclusive. ISO 8601 with an offset.' }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(512).optional(),
});

const ACTION_STATUSES = ['pending', 'applied', 'noop', 'not_eligible', 'failed'] as const;

export const ModerationResult = z
  .object({
    action: z.object({
      id: z.uuid(),
      kind: z.enum(['hide', 'unhide']),
      status: z.enum(ACTION_STATUSES),
      code: z.string().nullable().meta({
        description: 'Why nothing was done or it failed, e.g. `already_hidden`; null otherwise.',
      }),
    }),
    comment: CommentResource,
  })
  .meta({ id: 'ModerationResult' });

const moderationSpec = (kind: 'hide' | 'unhide'): RouteSpec => ({
  id: `${kind}Comment`,
  method: 'POST',
  path: `/v1/comments/{id}/${kind}`,
  scope: 'write',
  summary: `${kind === 'hide' ? 'Hide' : 'Unhide'} a comment on its platform`,
  params: z.object({ id: z.uuid() }),
  body: z.strictObject({}),
  bodyOptional: true,
  idempotent: true,
  responses: { 200: ModerationResult, 202: ModerationResult },
  errors: [
    'invalid_request',
    'not_found',
    'connection_inactive',
    'unsupported_action',
    'idempotency_key_reused',
    'idempotency_request_in_progress',
    'invalid_idempotency_key',
  ],
});

export const PUBLIC_ROUTE_SPECS: readonly RouteSpec[] = [
  {
    id: 'getOpenApi',
    method: 'GET',
    path: '/v1/openapi.json',
    scope: null,
    summary: 'The OpenAPI 3.1 description of this API',
    idempotent: false,
    responses: { 200: z.record(z.string(), z.unknown()) },
    errors: [],
  },
  {
    id: 'listComments',
    method: 'GET',
    path: '/v1/comments',
    scope: 'read',
    summary: 'List comments, newest first',
    query: ListCommentsQuery,
    idempotent: false,
    responses: { 200: pageOf(CommentResource, 'CommentPage') },
    errors: ['invalid_request', 'invalid_cursor'],
  },
  {
    id: 'getComment',
    method: 'GET',
    path: '/v1/comments/{id}',
    scope: 'read',
    summary: 'Fetch one comment',
    params: z.object({ id: z.uuid() }),
    idempotent: false,
    responses: { 200: CommentResource },
    errors: ['not_found'],
  },
  moderationSpec('hide'),
  moderationSpec('unhide'),
  {
    id: 'listFlaggedItems',
    method: 'GET',
    path: '/v1/flagged-items',
    scope: 'read',
    summary: 'List flagged items, newest first',
    query: ListFlaggedItemsQuery,
    idempotent: false,
    responses: { 200: pageOf(FlaggedItemResource, 'FlaggedItemPage') },
    errors: ['invalid_request', 'invalid_cursor'],
  },
  {
    id: 'getFlaggedItem',
    method: 'GET',
    path: '/v1/flagged-items/{id}',
    scope: 'read',
    summary: 'Fetch one flagged item',
    params: z.object({ id: z.uuid() }),
    idempotent: false,
    responses: { 200: FlaggedItemResource },
    errors: ['not_found'],
  },
];

export function routeSpec(id: string): RouteSpec {
  const spec = PUBLIC_ROUTE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown public route spec: ${id}`);
  return spec;
}
