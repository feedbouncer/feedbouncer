import { z } from 'zod';
import { MAX_CHECK_TEXT_UNITS, REASON_CODES } from '@feedbouncer/moderation-contract';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';
import type { ApiKeyScope } from './keys/token.js';
import { ACTION_STATUSES, ActionResource } from './resources/action.js';
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
  'webhook_delivery_in_progress',
  'text_too_long',
  'reply_not_allowed',
  'rule_rejected',
  'rule_limit_reached',
  'pending_limit_reached',
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
  webhook_delivery_in_progress: 409,
  rule_limit_reached: 409,
  pending_limit_reached: 409,
  idempotency_key_reused: 422,
  unsupported_action: 422,
  invalid_webhook_url: 422,
  text_too_long: 422,
  reply_not_allowed: 422,
  rule_rejected: 422,
  rate_limited: 429,
  internal_error: 500,
  temporarily_unavailable: 503,
};

/** A runnable request for the documentation. Path-param values are placeholders such as `<COMMENT_ID>`. */
export interface RouteExample {
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

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
  readonly body?: z.ZodType;
  /** The request body may be omitted. */
  readonly bodyOptional?: boolean;
  /** Accepts the Idempotency-Key header. */
  readonly idempotent: boolean;
  /** Success responses by status; null means no body. */
  readonly responses: Readonly<Record<number, z.ZodType | null>>;
  /** Errors specific to this route; the ones every authenticated route can return are added by the generator. */
  readonly errors: readonly PublicErrorCode[];
  /** Required for every route with params, query or body; used to build the curl sample. */
  readonly example?: RouteExample;
}

const timestamp = z.iso.datetime({ offset: true });

export const ListCommentsQuery = z.strictObject({
  status: z.enum(['visible', 'hidden', 'flagged', 'replied', 'unanswered']).optional(),
  brandId: z.uuid().optional(),
  platform: z.enum(['facebook', 'instagram']).optional(),
  q: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .optional()
    .meta({ description: 'Case-insensitive substring of the comment text or author name' }),
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

export const GetSummaryQuery = z.strictObject({
  from: timestamp.optional().meta({
    description: 'Inclusive. Defaults to 7 days before `to`; at most 92 days before it.',
  }),
  to: timestamp.optional().meta({ description: 'Exclusive. Defaults to now.' }),
  brandId: z.uuid().optional(),
});

export const PeriodSummaryResource = z
  .object({
    period: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
    bounded: z
      .object({
        requestedFrom: z.iso.datetime(),
        reason: z.literal('max_range_92_days'),
      })
      .nullable()
      .meta({ description: 'Set when the requested start was moved forward to fit 92 days.' }),
    totals: z
      .object({ comments: z.int(), hidden: z.int(), replied: z.int(), unanswered: z.int() })
      .meta({
        description:
          "Counts of other people's comments posted in the period. Deleted comments and comments of archived brands are not counted.",
      }),
    categories: z.array(z.object({ category: z.string(), count: z.int() })).meta({
      description:
        'The ten most common categories the classifier flagged (hide, flag or remove, not approve), by comment count.',
    }),
    topRules: z.array(z.object({ ruleId: z.uuid(), name: z.string(), matches: z.int() })),
    notableThreads: z
      .array(
        z.object({
          commentId: z.uuid(),
          platform: z.enum(['facebook', 'instagram']),
          authorName: z.string().nullable(),
          textPreview: z.string(),
          replies: z.int().meta({ description: "Replies, including the account's own." }),
          postedAt: z.iso.datetime(),
        }),
      )
      .meta({ description: 'Up to five top-level comments with the most replies, then newest.' }),
  })
  .meta({ id: 'PeriodSummary' });

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

export const CreateReplyBody = z
  .strictObject({ text: z.string().trim().min(1).max(8000) })
  .meta({ id: 'CreateReplyRequest' });

export const ReplyResult = z
  .object({ action: ActionResource, comment: CommentResource })
  .meta({ id: 'ReplyResult' });

export const KeyResource = z
  .object({
    organizationId: z.uuid(),
    name: z.string(),
    scope: z.enum(['moderate', 'read', 'write']),
  })
  .meta({ id: 'Key' });

export const ListRulesQuery = z.strictObject({ brandId: z.uuid().optional() });

const PROPOSAL_OPERATIONS = ['create', 'update', 'archive'] as const;
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'stale'] as const;
const RULE_FIELDS = ['name', 'conditions', 'actions', 'mode', 'enabled'] as const;

export const RuleResource = z
  .object({
    id: z.uuid(),
    name: z.string(),
    conditions: z.record(z.string(), z.unknown()),
    actions: z.array(z.record(z.string(), z.unknown())),
    mode: z.enum(['enforce', 'suggest']),
    priority: z.int(),
    enabled: z.boolean(),
  })
  .meta({ id: 'Rule' });

export const RuleChangeSummary = z
  .object({
    id: z.uuid(),
    operation: z.enum(PROPOSAL_OPERATIONS),
    ruleId: z.uuid().nullable().meta({ description: 'The rule changed; null for a create.' }),
    status: z.enum(PROPOSAL_STATUSES),
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RuleChangeSummary' });

export const RuleSetResource = z
  .object({
    brands: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        ruleRevision: z.int().meta({ description: "Changes whenever the brand's rules change." }),
        rules: z.array(RuleResource).meta({ description: 'Live rules, in evaluation order.' }),
        changes: z.array(RuleChangeSummary).meta({
          description: 'Proposals that are pending or were settled in the last 7 days.',
        }),
      }),
    ),
  })
  .meta({ id: 'RuleSet' });

const ruleFields = z.record(z.string(), z.unknown());
const proposalBase = {
  brandId: z.uuid(),
  rationale: z.string().max(1000).optional().meta({ description: 'Shown to the reviewer.' }),
};
export const ProposeRuleChangeBody = z
  .discriminatedUnion('operation', [
    z.strictObject({
      ...proposalBase,
      operation: z.literal('create'),
      rule: ruleFields.meta({
        description:
          '`name`, `conditions`, `actions`, `mode` (default `suggest`) and `enabled` (default true), as in the rules of `listRules`.',
      }),
    }),
    z.strictObject({
      ...proposalBase,
      operation: z.literal('update'),
      ruleId: z.uuid(),
      patch: ruleFields.meta({ description: 'The rule fields to change.' }),
    }),
    z.strictObject({ ...proposalBase, operation: z.literal('archive'), ruleId: z.uuid() }),
  ])
  .meta({ id: 'ProposeRuleChangeRequest' });

export const RuleChangeProposalResource = z
  .object({
    id: z.uuid(),
    brandId: z.uuid(),
    operation: z.enum(PROPOSAL_OPERATIONS),
    ruleId: z.uuid().nullable(),
    status: z.enum(PROPOSAL_STATUSES),
    diff: z.array(
      z.object({ field: z.enum(RULE_FIELDS), before: z.unknown(), after: z.unknown() }),
    ),
    warnings: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    baseRuleRevision: z.int(),
    reviewUrl: z.url().meta({ description: 'Where a person approves or rejects the change.' }),
  })
  .meta({ id: 'RuleChangeProposal' });

export const ModerationCheckRequest = z
  .strictObject({
    text: z.string().meta({
      description: `At most ${MAX_CHECK_TEXT_UNITS} UTF-16 code units, with at least one visible character.`,
    }),
    brandId: z.uuid().optional().meta({
      description:
        'The brand whose rules, thresholds and policies apply. Required unless the workspace has exactly one active brand.',
    }),
    ref: z
      .string()
      .regex(/^[\x21-\x7E]{1,128}$/)
      .optional()
      .meta({
        description: 'Your own reference, echoed back. 1 to 128 printable ASCII characters.',
      }),
  })
  .meta({ id: 'ModerationCheckRequest' });

const nullableString = z.string().nullable();
const modelInfo = z.object({ provider: z.string(), model: z.string() }).nullable();

export const ModerationCheckResult = z
  .object({
    verdict: z.enum(['allow', 'review', 'block']),
    reasonCode: z.enum(REASON_CODES).meta({
      description: 'Stable machine-readable reason. New codes may be added; none is renamed.',
    }),
    reason: z.string(),
    decidedBy: z.enum(['rule', 'classifier', 'policy', 'none', 'degraded']),
    degraded: z.boolean().meta({
      description: 'True when a check could not run; the verdict is then never `allow`.',
    }),
    evidence: z.object({
      ruleId: z.uuid().nullable(),
      ruleName: nullableString,
      category: nullableString,
      score: z.number().nullable(),
      threshold: z.number().nullable(),
      policyId: z.uuid().nullable(),
      policyRevision: z.int().nullable(),
      language: nullableString,
    }),
    models: z.object({ classifier: modelInfo, policy: modelInfo }),
    brandId: z.uuid(),
    ref: nullableString,
    checkedAt: z.iso.datetime(),
  })
  .meta({ id: 'ModerationCheckResult' });

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
  example: { pathParams: { id: '<COMMENT_ID>' }, body: {} },
});

const IDEMPOTENCY_ERRORS = [
  'idempotency_key_reused',
  'idempotency_request_in_progress',
  'invalid_idempotency_key',
] as const;

const WEBHOOK_ID_EXAMPLE = { pathParams: { id: '<WEBHOOK_ENDPOINT_ID>' } } as const;

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
      example: {
        body: {
          url: 'https://feedbouncer.example.com/webhooks/feedbouncer',
          description: 'Moderation alerts',
          eventTypes: ['comment.received', 'item.flagged'],
        },
      },
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
      example: WEBHOOK_ID_EXAMPLE,
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
      example: { ...WEBHOOK_ID_EXAMPLE, body: { status: 'disabled' } },
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
      example: WEBHOOK_ID_EXAMPLE,
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
      example: { ...WEBHOOK_ID_EXAMPLE, body: {} },
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
      example: { ...WEBHOOK_ID_EXAMPLE, body: {} },
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
      example: { ...WEBHOOK_ID_EXAMPLE, query: { status: 'failed', limit: '20' } },
    },
    {
      ...base,
      id: 'redeliverWebhookDelivery',
      method: 'POST',
      path: '/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver',
      summary:
        'Send the event of a finished delivery again. Answers 409 `webhook_delivery_in_progress` while the delivery is still being attempted',
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
        'webhook_delivery_in_progress',
        ...IDEMPOTENCY_ERRORS,
      ],
      example: {
        pathParams: { id: '<WEBHOOK_ENDPOINT_ID>', deliveryId: '<WEBHOOK_DELIVERY_ID>' },
        body: {},
      },
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
    example: { query: { status: 'unanswered', platform: 'facebook', limit: '20' } },
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
    example: { pathParams: { id: '<COMMENT_ID>' } },
  },
  moderationSpec('hide'),
  moderationSpec('unhide'),
  {
    id: 'replyToComment',
    method: 'POST',
    path: '/v1/comments/{id}/replies',
    scope: 'write',
    summary:
      'Post a public reply to a comment. Answers 202 when queued, 200 when the outcome was known up front; poll `getAction` for the result',
    params: z.object({ id: z.uuid() }),
    body: CreateReplyBody,
    idempotent: true,
    responses: { 200: ReplyResult, 202: ReplyResult },
    errors: [
      'invalid_request',
      'not_found',
      'connection_inactive',
      'unsupported_action',
      'text_too_long',
      'reply_not_allowed',
      'idempotency_key_reused',
      'idempotency_request_in_progress',
      'invalid_idempotency_key',
    ],
    example: { pathParams: { id: '<COMMENT_ID>' }, body: { text: 'Thanks for the feedback!' } },
  },
  {
    id: 'getAction',
    method: 'GET',
    path: '/v1/actions/{id}',
    scope: 'read',
    summary: 'Fetch the status of a hide, unhide or reply',
    params: z.object({ id: z.uuid() }),
    idempotent: false,
    responses: { 200: ActionResource },
    errors: ['not_found'],
    example: { pathParams: { id: '<ACTION_ID>' } },
  },
  {
    id: 'getSummary',
    method: 'GET',
    path: '/v1/summary',
    scope: 'read',
    summary:
      'Summarize a period: totals, categories, top rules and notable threads. Answers 400 `invalid_request` with `reason` `to_before_from` or `to_in_future` for a bad range',
    query: GetSummaryQuery,
    idempotent: false,
    responses: { 200: PeriodSummaryResource },
    errors: ['invalid_request', 'not_found'],
    example: { query: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } },
  },
  {
    id: 'listRules',
    method: 'GET',
    path: '/v1/rules',
    scope: 'read',
    summary: 'List the live rules and recent rule-change proposals of every brand, or of one',
    query: ListRulesQuery,
    idempotent: false,
    responses: { 200: RuleSetResource },
    errors: ['invalid_request', 'not_found'],
    example: { query: { brandId: '00000000-0000-4000-8000-000000000001' } },
  },
  {
    id: 'proposeRuleChange',
    method: 'POST',
    path: '/v1/rule-change-proposals',
    scope: 'write',
    summary:
      'Propose a rule change for a person to approve in the dashboard; no rule changes until then. Answers 200 with the waiting proposal when the same change is already pending. 422 `rule_rejected` carries `reason`, and `ruleId` for a duplicate or conflicting rule',
    body: ProposeRuleChangeBody,
    idempotent: true,
    responses: { 200: RuleChangeProposalResource, 201: RuleChangeProposalResource },
    errors: [
      'invalid_request',
      'not_found',
      'rule_rejected',
      'rule_limit_reached',
      'pending_limit_reached',
      ...IDEMPOTENCY_ERRORS,
    ],
    example: {
      body: {
        operation: 'create',
        brandId: '00000000-0000-4000-8000-000000000001',
        rationale: 'Hide the recurring spam phrase.',
        rule: {
          name: 'Hide spam phrase',
          conditions: { type: 'keyword', terms: ['free money'] },
          actions: [{ type: 'hide' }],
          mode: 'suggest',
        },
      },
    },
  },
  {
    id: 'getApiKey',
    method: 'GET',
    path: '/v1/key',
    scope: 'moderate',
    summary: 'Describe the API key making the request',
    idempotent: false,
    responses: { 200: KeyResource },
    errors: [],
  },
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
    example: { query: { status: 'open', limit: '20' } },
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
    example: { pathParams: { id: '<FLAGGED_ITEM_ID>' } },
  },
  {
    id: 'checkModeration',
    method: 'POST',
    path: '/v1/moderation/check',
    scope: 'moderate',
    summary:
      "Check arbitrary text against a brand's rules, classifier and policies and get `allow`, `review` or `block`. Nothing is stored. Answers 503 `temporarily_unavailable` with `Retry-After: 5` when no verdict could be computed in time; a retry is always safe",
    body: ModerationCheckRequest,
    idempotent: false,
    responses: { 200: ModerationCheckResult },
    errors: ['invalid_request', 'not_found', 'text_too_long', 'temporarily_unavailable'],
    example: {
      body: {
        text: 'Win free money now',
        brandId: '00000000-0000-4000-8000-000000000001',
        ref: 'draft-42',
      },
    },
  },
  ...webhookEndpointSpecs(),
];

export function routeSpec(id: string): RouteSpec {
  const spec = PUBLIC_ROUTE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown public route spec: ${id}`);
  return spec;
}
