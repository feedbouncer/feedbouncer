import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PUBLIC_ERROR_CODES, PUBLIC_ROUTE_SPECS, type RouteSpec } from '@feedbouncer/public-api';
import { buildOpenApiDocument } from './openapi.js';

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
      expect(op.responses['201']?.headers ?? op.responses['200']?.headers).toHaveProperty(
        'X-RateLimit-Remaining',
      );
    }
  });

  it('types error codes as the closed public list', () => {
    expect(doc.components.schemas.Error).toMatchObject({
      properties: { error: { properties: { code: { enum: [...PUBLIC_ERROR_CODES] } } } },
    });
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
