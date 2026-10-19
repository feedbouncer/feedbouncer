import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_STATUS,
  PUBLIC_ROUTE_SPECS,
  type PublicErrorCode,
  type RouteSpec,
} from '@feedbouncer/public-api';
import { WEBHOOK_PAYLOAD_SCHEMAS } from '@feedbouncer/webhooks';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type OpenApiDocument = {
  openapi: '3.1.0';
  info: JsonObject;
  paths: Record<string, JsonObject>;
  webhooks: Record<string, JsonObject>;
  components: {
    schemas: Record<string, Json>;
    securitySchemes: Record<string, Json>;
  };
};

/** Every authenticated route can fail these ways before its handler runs. */
const COMMON_ERRORS: readonly PublicErrorCode[] = [
  'unauthenticated',
  'insufficient_scope',
  'rate_limited',
  'temporarily_unavailable',
  'internal_error',
];

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable',
  429: 'Too many requests',
  500: 'Internal error',
  503: 'Temporarily unavailable',
};

const integerHeader = (description: string): JsonObject => ({
  description,
  schema: { type: 'integer' },
});
const RATE_LIMIT_HEADERS: JsonObject = {
  'X-RateLimit-Limit': integerHeader('Requests allowed per minute for this key.'),
  'X-RateLimit-Remaining': integerHeader('Requests left in the current window.'),
};
const REPLAYED: JsonObject = {
  'Idempotent-Replayed': {
    description: '`true` when this is the stored response of an earlier request with the same key.',
    schema: { type: 'string', enum: ['true'] },
  },
};
const RETRY_AFTER: JsonObject = {
  'Retry-After': integerHeader('Whole seconds to wait before retrying (at least 1).'),
};
const REF_ERROR: JsonObject = { $ref: '#/components/schemas/Error' };

const ERROR_SCHEMA: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [...PUBLIC_ERROR_CODES],
          description: 'Stable machine-readable code. New codes may be added; none is renamed.',
        },
        message: { type: 'string' },
        max: {
          type: 'integer',
          description:
            'The limit that was hit, for `text_too_long`, `rule_limit_reached` and `pending_limit_reached`.',
        },
        reason: {
          type: 'string',
          description:
            'Why, for `reply_not_allowed`, `rule_rejected` and some `invalid_request` errors (for example `to_before_from`).',
        },
        ruleId: {
          type: 'string',
          format: 'uuid',
          description: 'The existing rule a `rule_rejected` change duplicates or conflicts with.',
        },
      },
    },
  },
};

function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string'
        ? v.replace('#/$defs/', '#/components/schemas/')
        : rewriteRefs(v),
    ]),
  );
}

class SchemaCollector {
  readonly schemas: Record<string, Json> = {};

  /** The OpenAPI 3.1 schema for a zod type; named definitions move to components.schemas. */
  convert(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
    const { $defs, ...rest } = z.toJSONSchema(schema, { io }) as JsonObject;
    delete rest.$schema;
    for (const [name, def] of Object.entries($defs ?? {}) as Array<[string, Json]>) {
      const hoisted = rewriteRefs(def);
      if (name in this.schemas && !isDeepStrictEqual(this.schemas[name], hoisted)) {
        throw new Error(`schema id "${name}" is used with two different shapes; give one a new id`);
      }
      this.schemas[name] = hoisted;
    }
    return rewriteRefs(rest) as JsonObject;
  }
}

function parameters(spec: RouteSpec, schemas: SchemaCollector): Json[] {
  const fromObject = (object: z.ZodObject | undefined, location: 'path' | 'query') =>
    Object.entries(object?.shape ?? {}).map(([name, field]) => ({
      name,
      in: location,
      required: location === 'path' || !(field as z.ZodType).isOptional(),
      schema: schemas.convert(field as z.ZodType, 'input'),
    }));
  const out: Json[] = [...fromObject(spec.params, 'path'), ...fromObject(spec.query, 'query')];
  if (spec.idempotent) {
    out.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Up to 128 characters of A-Z a-z 0-9 . _ : -. Retained for 24 hours per API key.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
    });
  }
  return out;
}

function responses(spec: RouteSpec, schemas: SchemaCollector): JsonObject {
  const out: Record<number, JsonObject> = {};
  const authenticated = spec.scope !== null;
  for (const [status, body] of Object.entries(spec.responses)) {
    out[Number(status)] = {
      description: REASONS[Number(status)] ?? 'Success',
      ...(authenticated && {
        headers: { ...RATE_LIMIT_HEADERS, ...(spec.idempotent && REPLAYED) },
      }),
      ...(body && {
        content: { 'application/json': { schema: schemas.convert(body, 'output') } },
      }),
    };
  }
  const codes = new Set<PublicErrorCode>([...spec.errors, ...(authenticated ? COMMON_ERRORS : [])]);
  const byStatus = new Map<number, PublicErrorCode[]>();
  for (const code of PUBLIC_ERROR_CODES) {
    if (!codes.has(code)) continue;
    const status = PUBLIC_ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, list] of byStatus) {
    out[status] = {
      description: `${REASONS[status] ?? 'Error'}: ${list.map((c) => `\`${c}\``).join(', ')}.`,
      ...(status === 429 && { headers: RETRY_AFTER }),
      content: { 'application/json': { schema: REF_ERROR } },
    };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)));
}

function operation(spec: RouteSpec, schemas: SchemaCollector): JsonObject {
  const params = parameters(spec, schemas);
  return {
    operationId: spec.id,
    summary: spec.summary,
    ...(spec.scope && {
      description: `Requires an API key with the \`${spec.scope}\` scope.`,
      security: [{ apiKey: [] }],
    }),
    ...(params.length > 0 && { parameters: params }),
    ...(spec.body && {
      requestBody: {
        required: !spec.bodyOptional,
        content: { 'application/json': { schema: schemas.convert(spec.body, 'input') } },
      },
    }),
    responses: responses(spec, schemas),
  };
}

/** Each event type is a callback the API makes to a registered endpoint. */
function webhookOperations(schemas: SchemaCollector): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.entries(WEBHOOK_PAYLOAD_SCHEMAS).map(([type, payload]) => [
      type,
      {
        post: {
          operationId: `receive_${type.replace('.', '_')}`,
          summary: `Delivery of a \`${type}\` event`,
          description:
            'Signed with Standard Webhooks: verify `webhook-id`, `webhook-timestamp` and `webhook-signature` against the endpoint signing secret. Any 2xx response within 10 seconds counts as delivered.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemas.convert(payload, 'output') } },
          },
          responses: { '2XX': { description: 'The event was received.' } },
        },
      },
    ]),
  );
}

export function buildOpenApiDocument(
  specs: readonly RouteSpec[] = PUBLIC_ROUTE_SPECS,
): OpenApiDocument {
  const schemas = new SchemaCollector();
  const paths: Record<string, JsonObject> = {};
  for (const spec of specs) {
    (paths[spec.path] ??= {})[spec.method.toLowerCase()] = operation(spec, schemas);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'FeedBouncer API',
      version: '1.0.0',
      description:
        'Authenticate with `Authorization: Bearer <api key>`. Error codes may be added over time and are never renamed.',
    },
    paths,
    webhooks: webhookOperations(schemas),
    components: {
      schemas: { Error: ERROR_SCHEMA, ...schemas.schemas },
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
    },
  };
}
