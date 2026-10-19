import { describe, expect, it } from 'vitest';
import { REQUIRED_OPERATIONS } from '../nodes/shared/constants';
import openApiDocument from '../../../docs/api/openapi.json';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// The repo copy of the API description; a fresh deep copy per call so tests can mutate it.
const loadSpec = (): Json => structuredClone(openApiDocument);

const EXPECTED: Record<string, [method: string, path: string]> = {
  getApiKey: ['get', '/v1/key'],
  listComments: ['get', '/v1/comments'],
  getComment: ['get', '/v1/comments/{id}'],
  hideComment: ['post', '/v1/comments/{id}/hide'],
  unhideComment: ['post', '/v1/comments/{id}/unhide'],
  getAction: ['get', '/v1/actions/{id}'],
  listRules: ['get', '/v1/rules'],
  listWebhookEndpoints: ['get', '/v1/webhook-endpoints'],
  createWebhookEndpoint: ['post', '/v1/webhook-endpoints'],
  getWebhookEndpoint: ['get', '/v1/webhook-endpoints/{id}'],
  deleteWebhookEndpoint: ['delete', '/v1/webhook-endpoints/{id}'],
};

function deref(spec: Json, node: Json): Json {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const target = node.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((acc: Json, key: string) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    if (target === undefined) throw new Error(`Unresolved $ref ${node.$ref}`);
    return deref(spec, target);
  }
  return node;
}

function findOperation(spec: Json, operationId: string) {
  for (const [path, item] of Object.entries<Json>(spec.paths)) {
    for (const [method, op] of Object.entries<Json>(item)) {
      if (op?.operationId === operationId) return { method, path, op };
    }
  }
  throw new Error(`Operation ${operationId} is missing from the API description`);
}

function responseProperties(spec: Json, operationId: string, status: string): Json {
  const response = deref(spec, findOperation(spec, operationId).op.responses[status]);
  return deref(spec, response.content['application/json'].schema).properties ?? {};
}

function assertContract(spec: Json): void {
  for (const id of REQUIRED_OPERATIONS) {
    const { method, path } = findOperation(spec, id);
    expect([method, path], id).toEqual(EXPECTED[id]);
  }

  const created = responseProperties(spec, 'createWebhookEndpoint', '201');
  expect(created).toHaveProperty('secret');
  expect(deref(spec, created.endpoint).properties).toHaveProperty('id');

  expect(responseProperties(spec, 'listComments', '200')).toHaveProperty('data');
  expect(responseProperties(spec, 'listComments', '200')).toHaveProperty('nextCursor');

  const codes = deref(spec, spec.components.schemas.Error).properties.error.properties.code.enum;
  expect(codes).toEqual(
    expect.arrayContaining([
      'insufficient_scope',
      'rate_limited',
      'unsupported_action',
      'invalid_webhook_url',
      'webhook_endpoint_limit_reached',
    ]),
  );

  expect(Object.keys(spec.webhooks)).toEqual(
    expect.arrayContaining(['comment.received', 'comment.hidden', 'item.flagged']),
  );
}

describe('FeedBouncer API contract', () => {
  it('the repo API description satisfies everything the nodes rely on', () => {
    expect(() => assertContract(loadSpec())).not.toThrow();
  });

  it('fails when a required operation is renamed', () => {
    const spec = loadSpec();
    findOperation(spec, 'hideComment').op.operationId = 'hideCommentRenamed';
    expect(() => assertContract(spec)).toThrow(/hideComment/);
  });
});
