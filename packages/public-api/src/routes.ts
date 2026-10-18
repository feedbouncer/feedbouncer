import { z } from 'zod';
import type { ApiKeyScope } from './keys/token.js';

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
  idempotency_key_reused: 422,
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
  /** Accepts the Idempotency-Key header. */
  readonly idempotent: boolean;
  /** Success responses by status; null means no body. */
  readonly responses: Readonly<Record<number, z.ZodType | null>>;
  /** Errors specific to this route; the ones every authenticated route can return are added by the generator. */
  readonly errors: readonly PublicErrorCode[];
}

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
];

export function routeSpec(id: string): RouteSpec {
  const spec = PUBLIC_ROUTE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown public route spec: ${id}`);
  return spec;
}
