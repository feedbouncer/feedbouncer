import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PUBLIC_ERROR_CODES, PUBLIC_ROUTE_SPECS, type RouteSpec } from '@feedbouncer/public-api';
import { buildOpenApiDocument } from './openapi.js';

const toOpenApiPath = (path: string): string => path;

const Thing = z.object({ id: z.uuid(), name: z.string() }).meta({ id: 'Thing' });
const fixture: RouteSpec[] = [
  ...PUBLIC_ROUTE_SPECS,
  {
    id: 'createThing',
    method: 'POST',
    path: '/v1/things/{id}',
    scope: 'write',
    summary: 'Create a thing',
    params: z.object({ id: z.uuid() }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    body: z.object({ name: z.string().min(1) }).meta({ id: 'ThingInput' }),
    idempotent: true,
    responses: { 201: Thing, 204: null },
    errors: ['not_found', 'idempotency_key_reused'],
  },
];

type Operation = {
  security?: unknown;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses: Record<string, { headers?: Record<string, unknown> }>;
};
const operations = (doc: ReturnType<typeof buildOpenApiDocument>) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item as Record<string, Operation & { operationId: string }>).map(
      ([method, op]) => ({ path, method, op }),
    ),
  );

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument(fixture);

  it('is a valid OpenAPI 3.1 document', async () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(await new Validator().validate(doc)).toMatchObject({ valid: true });
    expect(await new Validator().validate(buildOpenApiDocument())).toMatchObject({ valid: true });
  });

  it('declares bearer API-key auth on every operation but the document route', () => {
    expect(doc.components.securitySchemes).toEqual({ apiKey: { type: 'http', scheme: 'bearer' } });
    for (const { path, op } of operations(doc)) {
      if (path === '/v1/openapi.json') expect(op.security).toBeUndefined();
      else expect(op.security).toEqual([{ apiKey: [] }]);
    }
  });

  it('has no $schema key and no unresolved #/$defs/ reference', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"$schema"');
    expect(text).not.toContain('#/$defs/');
    expect(doc.components.schemas).toHaveProperty('Thing');
    expect(text).toContain('#/components/schemas/Thing');
  });

  it('documents path, query and header parameters, and required request bodies', () => {
    const op = (doc.paths['/v1/things/{id}'] as Record<string, Operation>).post!;
    expect(op.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'limit', in: 'query', required: false }),
      ]),
    );
    expect(op).toHaveProperty('requestBody.required', true);
  });

  it('documents the Idempotency-Key header on idempotent operations', () => {
    const idempotent = new Set(fixture.filter((s) => s.idempotent).map((s) => s.id));
    const seen = operations(doc).filter(({ op }) =>
      idempotent.has((op as unknown as { operationId: string }).operationId),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const { op } of seen) {
      expect(op.parameters).toContainEqual(
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: false }),
      );
    }
  });

  it('documents Retry-After on every 429 and rate-limit headers on authenticated successes', () => {
    for (const { path, op } of operations(doc)) {
      if (path === '/v1/openapi.json') continue;
      expect(op.responses['429']?.headers).toHaveProperty('Retry-After');
      const success = Object.entries(op.responses).find(([status]) => status.startsWith('2'))![1];
      expect(success.headers).toHaveProperty('X-RateLimit-Remaining');
    }
  });

  it('documents each event payload under the top-level webhooks map', () => {
    const ids: Record<string, string> = {
      'comment.received': 'CommentReceivedEvent',
      'comment.hidden': 'CommentHiddenEvent',
      'item.flagged': 'ItemFlaggedEvent',
      'webhook.test': 'WebhookTestEvent',
    };
    expect(Object.keys(doc.webhooks)).toEqual(Object.keys(ids));
    for (const [type, id] of Object.entries(ids)) {
      expect(doc.components.schemas).toHaveProperty(id);
      expect(doc.webhooks[type]).toMatchObject({
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}` } } },
          },
          responses: { '2XX': { description: expect.any(String) as string } },
        },
      });
    }
  });

  it('types error codes as the closed public list', () => {
    expect(doc.components.schemas.Error).toMatchObject({
      properties: { error: { properties: { code: { enum: [...PUBLIC_ERROR_CODES] } } } },
    });
  });

  it('documents the optional error details: max, reason, ruleId, field, problem and maxLength', () => {
    const error = (
      doc.components.schemas.Error as {
        properties: { error: { required: string[]; properties: Record<string, unknown> } };
      }
    ).properties.error;
    expect(error.required).toEqual(['code', 'message']);
    expect(error.properties).toMatchObject({
      max: { type: 'integer' },
      reason: { type: 'string' },
      ruleId: { type: 'string', format: 'uuid' },
      field: { type: 'string' },
      problem: { type: 'string' },
      maxLength: { type: 'integer' },
    });
  });

  it('documents the moderation check for the moderate scope', () => {
    const op = (doc.paths['/v1/moderation/check'] as Record<string, Operation>).post!;
    expect(op).toMatchObject({
      operationId: 'checkModeration',
      description: 'Requires an API key with the `moderate` scope.',
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ModerationCheckRequest' } },
        },
      },
    });
    expect(Object.keys(op.responses)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '413',
      '422',
      '429',
      '500',
      '503',
    ]);
    expect(doc.components.schemas).toHaveProperty('ModerationCheckResult');
  });

  const real = buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  it('gives every operation one curl sample that runs against $FEEDBOUNCER_URL', () => {
    for (const spec of PUBLIC_ROUTE_SPECS) {
      const op = real.paths[toOpenApiPath(spec.path)]![spec.method.toLowerCase()]!;
      const samples = op['x-codeSamples'] as Array<{ source: string }>;
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ lang: 'curl', label: 'curl' });
      const src = samples[0]!.source;
      expect(src.startsWith('curl -sS')).toBe(true);
      expect(src).toContain(
        `"$FEEDBOUNCER_URL${spec.path.replace(/\{(\w+)\}/g, (_, p: string) => spec.example!.pathParams![p]!)}`,
      );
      expect(src.includes('Authorization: Bearer $FEEDBOUNCER_API_KEY')).toBe(spec.scope !== null);
      expect(src.includes('Idempotency-Key: <UNIQUE_KEY>')).toBe(spec.idempotent);
      expect(src).not.toMatch(
        /fbk_[a-z2-7]{16}_|localhost|127\.0\.0\.1|https?:\/\/(?!feedbouncer\.example\.com)/,
      );
    }
  });

  it('has a body example that the route schema accepts, with no single quotes', () => {
    for (const spec of PUBLIC_ROUTE_SPECS.filter((s) => s.body)) {
      expect(spec.body!.safeParse(spec.example?.body).success, spec.id).toBe(true);
      expect(JSON.stringify(spec.example!.body)).not.toContain("'");
    }
  });

  it('has query and path examples that parse, with placeholder path params', () => {
    for (const spec of PUBLIC_ROUTE_SPECS) {
      if (spec.query)
        expect(spec.query.safeParse(spec.example?.query ?? {}).success, spec.id).toBe(true);
      for (const [, name] of spec.path.matchAll(/\{(\w+)\}/g)) {
        expect(spec.example?.pathParams?.[name!], `${spec.id} ${name}`).toMatch(
          /^<[A-Z][A-Z0-9_]*>$/,
        );
      }
    }
  });

  it('documents 413 invalid_request on every route with a body', () => {
    for (const spec of PUBLIC_ROUTE_SPECS) {
      const res = real.paths[spec.path]![spec.method.toLowerCase()]!.responses as Record<
        string,
        unknown
      >;
      if (spec.body) {
        expect(res['413']).toEqual({
          description: 'Request body larger than 64 KiB.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        });
      } else {
        expect(res['413']).toBeUndefined();
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument(fixture))).toBe(JSON.stringify(doc));
  });

  it('matches the committed docs/api/openapi.json', () => {
    const file = new URL('../../../../docs/api/openapi.json', import.meta.url);
    const expected = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    expect(
      readFileSync(file, 'utf8'),
      'docs/api/openapi.json is stale: run pnpm --filter @feedbouncer/api openapi:write',
    ).toBe(expected);
  });
});
