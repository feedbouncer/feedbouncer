import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';
import type { ApiKeyScope } from './keys/token.js';
import { CommentResource } from './resources/comment.js';
import { FlaggedItemResource } from './resources/flagged-item.js';
import { pageOf } from './resources/page.js';
import {
  DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WebhookDeliveryResource,
  WebhookEndpointResource,
} from './resources/webhook.js';

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
  'invalid_webhook_url',
  'webhook_endpoint_limit_reached',
  'webhook_endpoint_disabled',
  'webhook_event_unavailable',
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
  webhook_endpoint_limit_reached: 409,
  webhook_endpoint_disabled: 409,
  webhook_event_unavailable: 409,
  idempotency_key_reused: 422,
  unsupported_action: 422,
  invalid_webhook_url: 422,
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

const eventTypes = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1)
  .refine((types) => new Set(types).size === types.length, 'Event types must be unique.')
  .meta({ description: 'The events this endpoint receives. At least one, without repeats.' });
const webhookUrl = z.string().max(2048).meta({
  description:
    'An `https://` URL on port 443 that resolves to public addresses only, at most 2048 characters.',
});
const description = z.string().max(500);

export const CreateWebhookEndpointBody = z
  .strictObject({ url: webhookUrl, description: description.optional(), eventTypes })
  .meta({ id: 'CreateWebhookEndpointRequest' });

export const UpdateWebhookEndpointBody = z
  .strictObject({
    url: webhookUrl.optional(),
    description: description.nullable().optional(),
    eventTypes: eventTypes.optional(),
    status: z.enum(['active', 'disabled']).optional().meta({
      description: 'Setting `active` on a disabled endpoint resets its failure count.',
    }),
  })
  .meta({ id: 'UpdateWebhookEndpointRequest' });

const SIGNING_SECRET = 'The signing secret. It is shown once and cannot be retrieved again.';

export const WebhookEndpointCreated = z
  .object({
    endpoint: WebhookEndpointResource,
    secret: z.string().meta({ description: SIGNING_SECRET }),
  })
  .meta({ id: 'WebhookEndpointCreated' });

export const WebhookSecretRotation = z
  .object({
    secret: z.string().meta({ description: SIGNING_SECRET }),
    previousSecretExpiresAt: z.iso.datetime().meta({
      description: 'Until then deliveries are signed with the old secret as well.',
    }),
  })
  .meta({ id: 'WebhookSecretRotation' });

export const ListWebhookDeliveriesQuery = z.strictObject({
  status: z.enum(DELIVERY_STATUSES).optional(),
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

const IDEMPOTENCY_ERRORS = [
  'idempotency_key_reused',
  'idempotency_request_in_progress',
  'invalid_idempotency_key',
] as const;

function webhookEndpointSpecs(): readonly RouteSpec[] {
  const endpointParams = z.object({ id: z.uuid() });
  const base = { scope: 'write', idempotent: false } as const;
  return [
    {
      ...base,
      id: 'listWebhookEndpoints',
      method: 'GET',
      path: '/v1/webhook-endpoints',
      summary: 'List webhook endpoints',
      responses: { 200: pageOf(WebhookEndpointResource, 'WebhookEndpointPage') },
      errors: [],
    },
    {
      ...base,
      id: 'createWebhookEndpoint',
      method: 'POST',
      path: '/v1/webhook-endpoints',
      summary: 'Create a webhook endpoint; the signing secret is returned once',
      idempotent: true,
      body: CreateWebhookEndpointBody,
      responses: { 201: WebhookEndpointCreated },
      errors: [
        'invalid_request',
        'invalid_webhook_url',
        'webhook_endpoint_limit_reached',
        ...IDEMPOTENCY_ERRORS,
      ],
    },
    {
      ...base,
      id: 'getWebhookEndpoint',
      method: 'GET',
      path: '/v1/webhook-endpoints/{id}',
      summary: 'Fetch one webhook endpoint',
      params: endpointParams,
      responses: { 200: WebhookEndpointResource },
      errors: ['not_found'],
    },
    {
      ...base,
      id: 'updateWebhookEndpoint',
      method: 'PATCH',
      path: '/v1/webhook-endpoints/{id}',
      summary: 'Change, disable or re-enable a webhook endpoint',
      idempotent: true,
      params: endpointParams,
      body: UpdateWebhookEndpointBody,
      responses: { 200: WebhookEndpointResource },
      errors: ['invalid_request', 'not_found', 'invalid_webhook_url', ...IDEMPOTENCY_ERRORS],
    },
    {
      ...base,
      id: 'deleteWebhookEndpoint',
      method: 'DELETE',
      path: '/v1/webhook-endpoints/{id}',
      summary: 'Delete a webhook endpoint and its delivery history',
      params: endpointParams,
      responses: { 204: null },
      errors: ['not_found'],
    },
    {
      ...base,
      id: 'rotateWebhookSecret',
      method: 'POST',
      path: '/v1/webhook-endpoints/{id}/rotate-secret',
      summary: 'Issue a new signing secret; the old one keeps signing for 24 hours',
      idempotent: true,
      params: endpointParams,
      body: z.strictObject({}),
      bodyOptional: true,
      responses: { 200: WebhookSecretRotation },
      errors: ['invalid_request', 'not_found', ...IDEMPOTENCY_ERRORS],
    },
    {
      ...base,
      id: 'testWebhookEndpoint',
      method: 'POST',
      path: '/v1/webhook-endpoints/{id}/test',
      summary: 'Send a `webhook.test` event to the endpoint',
      idempotent: true,
      params: endpointParams,
      body: z.strictObject({}),
      bodyOptional: true,
      responses: { 202: WebhookDeliveryResource },
      errors: ['invalid_request', 'not_found', 'webhook_endpoint_disabled', ...IDEMPOTENCY_ERRORS],
    },
    {
      ...base,
      id: 'listWebhookDeliveries',
      method: 'GET',
      path: '/v1/webhook-endpoints/{id}/deliveries',
      summary: 'List the deliveries of an endpoint, newest first',
      params: endpointParams,
      query: ListWebhookDeliveriesQuery,
      responses: { 200: pageOf(WebhookDeliveryResource, 'WebhookDeliveryPage') },
      errors: ['invalid_request', 'invalid_cursor', 'not_found'],
    },
    {
      ...base,
      id: 'redeliverWebhookDelivery',
      method: 'POST',
      path: '/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver',
      summary:
        'Send the event of a finished delivery again. Answers 409 `invalid_request` while the delivery is still being attempted',
      idempotent: true,
      params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
      body: z.strictObject({}),
      bodyOptional: true,
      responses: { 202: WebhookDeliveryResource },
      errors: [
        'invalid_request',
        'not_found',
        'webhook_endpoint_disabled',
        'webhook_event_unavailable',
        ...IDEMPOTENCY_ERRORS,
      ],
    },
  ];
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
  ...webhookEndpointSpecs(),
];

export function routeSpec(id: string): RouteSpec {
  const spec = PUBLIC_ROUTE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown public route spec: ${id}`);
  return spec;
}
