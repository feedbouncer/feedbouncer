// /v1/webhook-endpoints: management, test events, delivery history and redelivery.
// Endpoint URLs are public IP literals, which need no DNS lookup.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgApiKeys, routeSpec, type RouteSpec } from '@feedbouncer/public-api';
import {
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestResponse,
} from '../testing/harness.js';

const URL_PATH = '/hooks/secret-path-4f2a';
const URL_OK = `https://93.184.216.34${URL_PATH}`;
const ALL = ['comment.received', 'comment.hidden', 'item.flagged'];

let api: TestApi;
let A: OrgFixture;
let writer: string;
let reader: string;
let ipCounter = 0;

function call(
  method: string,
  path: string,
  o: { token?: string; idem?: string; body?: unknown } = {},
): Promise<TestResponse> {
  return api.req(method, path, {
    headers: {
      authorization: `Bearer ${o.token ?? writer}`,
      'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
      ...(o.idem !== undefined && { 'idempotency-key': o.idem }),
    },
    ...(o.body !== undefined && { body: o.body }),
  });
}

const expectDocumented = (id: string, status: number, body: unknown) => {
  const schema = (routeSpec(id) as RouteSpec).responses[status];
  expect(schema, `${id} documents ${status}`).toBeTruthy();
  schema!.parse(body);
};

const create = (body: Record<string, unknown> = {}, idem?: string) =>
  call('POST', '/v1/webhook-endpoints', {
    body: { url: URL_OK, eventTypes: ALL, ...body },
    ...(idem !== undefined && { idem }),
  });

async function seedLiveComment(org: OrgFixture): Promise<string> {
  const { scope } = await api.seedFacebookConnection(org);
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [org.orgId, scope.brandId, scope.connectionId, `post-${randomUUID()}`],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'hello', now()) RETURNING id`,
    [org.orgId, scope.brandId, scope.connectionId, source.rows[0].id, `c-${randomUUID()}`],
  );
  return comment.rows[0].id;
}

const deliveries = (endpointId: string) =>
  api.pool
    .query('SELECT * FROM webhook_delivery WHERE endpoint_id = $1 ORDER BY created_at, id', [
      endpointId,
    ])
    .then((r) => r.rows);

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1, publicApiRateLimitPerMinute: 10_000 });
  A = await orgWithRoles(api, 'whA');
  const keys = new PgApiKeys(api.pool);
  const key = (scope: 'read' | 'write') =>
    keys.create(A.orgId, A.owner.userId, { name: `${scope}-${randomUUID()}`, scope });
  writer = (await key('write')).token.reveal();
  reader = (await key('read')).token.reveal();
});
afterAll(() => api.close());
beforeEach(async () => {
  await api.pool.query('DELETE FROM webhook_endpoint WHERE organization_id = $1', [A.orgId]);
});

describe('endpoint CRUD', () => {
  it('creates, lists, fetches, updates and deletes with a write key', async () => {
    const created = await create({ description: 'prod' });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expectDocumented('createWebhookEndpoint', 201, created.body);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.endpoint).toMatchObject({
      url: URL_OK,
      description: 'prod',
      eventTypes: ALL,
      status: 'active',
      disabledReason: null,
      rotationOverlapUntil: null,
    });
    const id = created.body.endpoint.id as string;

    const listed = await call('GET', '/v1/webhook-endpoints');
    expect(listed.status).toBe(200);
    expectDocumented('listWebhookEndpoints', 200, listed.body);
    expect(listed.body).toEqual({ data: [created.body.endpoint], nextCursor: null });

    const got = await call('GET', `/v1/webhook-endpoints/${id}`);
    expectDocumented('getWebhookEndpoint', 200, got.body);
    expect(got.body).toEqual(created.body.endpoint);
    expect(JSON.stringify(got.body)).not.toContain('whsec_');

    const patched = await call('PATCH', `/v1/webhook-endpoints/${id}`, {
      body: { description: null, eventTypes: ['item.flagged'] },
    });
    expect(patched.status).toBe(200);
    expectDocumented('updateWebhookEndpoint', 200, patched.body);
    expect(patched.body).toMatchObject({ description: null, eventTypes: ['item.flagged'] });

    const removed = await call('DELETE', `/v1/webhook-endpoints/${id}`);
    expect(removed.status).toBe(204);
    expect((await call('GET', `/v1/webhook-endpoints/${id}`)).status).toBe(404);
    expect((await call('DELETE', `/v1/webhook-endpoints/${id}`)).status).toBe(404);
  });

  it('re-enables a disabled endpoint and clears its failure state', async () => {
    const id = (await create()).body.endpoint.id as string;
    const off = await call('PATCH', `/v1/webhook-endpoints/${id}`, {
      body: { status: 'disabled' },
    });
    expect(off.body).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    await api.pool.query(
      `UPDATE webhook_endpoint SET consecutive_failures = 5, first_failure_at = now() WHERE id = $1`,
      [id],
    );
    const on = await call('PATCH', `/v1/webhook-endpoints/${id}`, { body: { status: 'active' } });
    expect(on.body).toMatchObject({ status: 'active', disabledReason: null, disabledAt: null });
    const row = await api.pool.query(
      'SELECT consecutive_failures, first_failure_at FROM webhook_endpoint WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ consecutive_failures: 0, first_failure_at: null });
    const audit = await api.pool.query(
      `SELECT action, details FROM audit_event WHERE organization_id = $1 AND action LIKE 'webhook_endpoint.%'
        ORDER BY sequence`,
      [A.orgId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.enabled',
    ]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/whsec_|93\.184|secret-path/);
  });

  it('rejects an insecure url with its reason and never echoes the url', async () => {
    const r = await create({ url: `http://93.184.216.34${URL_PATH}` });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'invalid_webhook_url', reason: 'not_https' });
    expect(JSON.stringify(r.body)).not.toMatch(/93\.184|secret-path/);
    const priv = await create({ url: 'https://10.0.0.5/hook' });
    expect(priv.body.error).toMatchObject({
      code: 'invalid_webhook_url',
      reason: 'private_address',
    });
    expect(JSON.stringify(priv.body)).not.toContain('10.0.0.5');
    const id = (await create()).body.endpoint.id as string;
    const patch = await call('PATCH', `/v1/webhook-endpoints/${id}`, {
      body: { url: 'https://169.254.169.254/' },
    });
    expect(patch.status).toBe(422);
    expect(patch.body.error.reason).toBe('private_address');
  });

  it.each([
    ['no event types', { eventTypes: [] }],
    ['a duplicate event type', { eventTypes: ['item.flagged', 'item.flagged'] }],
    ['an unknown event type', { eventTypes: ['webhook.test'] }],
    ['an unknown field', { extra: 1 }],
    ['a missing url', { url: undefined }],
    ['an over-long description', { description: 'x'.repeat(501) }],
  ])('rejects a body with %s as 400 invalid_request', async (_name, over) => {
    const r = await create(over);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
  });

  it('refuses the eleventh endpoint with 409 webhook_endpoint_limit_reached', async () => {
    for (let n = 0; n < 10; n++) expect((await create()).status).toBe(201);
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('webhook_endpoint_limit_reached');
  });

  it('rejects a read key on every webhook route', async () => {
    const id = randomUUID();
    const routes: Array<[string, string]> = [
      ['GET', '/v1/webhook-endpoints'],
      ['POST', '/v1/webhook-endpoints'],
      ['GET', `/v1/webhook-endpoints/${id}`],
      ['PATCH', `/v1/webhook-endpoints/${id}`],
      ['DELETE', `/v1/webhook-endpoints/${id}`],
      ['POST', `/v1/webhook-endpoints/${id}/rotate-secret`],
      ['POST', `/v1/webhook-endpoints/${id}/test`],
      ['GET', `/v1/webhook-endpoints/${id}/deliveries`],
      ['POST', `/v1/webhook-endpoints/${id}/deliveries/${id}/redeliver`],
    ];
    for (const [method, path] of routes) {
      const r = await call(method, path, {
        token: reader,
        body: method === 'GET' ? undefined : {},
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe('insufficient_scope');
    }
  });
});

describe('idempotency and secrets', () => {
  it('replays a create without the secret, and stores no secret', async () => {
    const first = await create({}, 'create-1');
    const replay = await create({}, 'create-1');
    expect(first.status).toBe(201);
    expect(first.body.secret).toMatch(/^whsec_/);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.body.endpoint.id).toBe(first.body.endpoint.id);
    expect(replay.body).not.toHaveProperty('secret');
    expect((await call('GET', '/v1/webhook-endpoints')).body.data).toHaveLength(1);

    const stored = await api.pool.query(
      `SELECT response_body::text AS t FROM api_idempotency_record
        WHERE organization_id = $1 AND idempotency_key = 'create-1'`,
      [A.orgId],
    );
    expect(stored.rows[0].t).not.toContain('whsec_');
    expect(stored.rows[0].t).not.toContain(first.body.secret);
  });

  it('rotates the secret: 200 with the new secret once, replay without it', async () => {
    const id = (await create()).body.endpoint.id as string;
    const r = await call('POST', `/v1/webhook-endpoints/${id}/rotate-secret`, { idem: 'rot-1' });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expectDocumented('rotateWebhookSecret', 200, r.body);
    expect(r.body.secret).toMatch(/^whsec_/);
    const overlapHours = (Date.parse(r.body.previousSecretExpiresAt) - Date.now()) / 3_600_000;
    expect(overlapHours).toBeGreaterThan(23.9);
    expect((await call('GET', `/v1/webhook-endpoints/${id}`)).body.rotationOverlapUntil).toBe(
      r.body.previousSecretExpiresAt,
    );
    const replay = await call('POST', `/v1/webhook-endpoints/${id}/rotate-secret`, {
      idem: 'rot-1',
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual({ previousSecretExpiresAt: r.body.previousSecretExpiresAt });
    const stored = await api.pool.query(
      `SELECT response_body::text AS t FROM api_idempotency_record WHERE idempotency_key = 'rot-1'`,
    );
    expect(stored.rows[0].t).not.toContain('whsec_');
  });

  it('reuses of a key with another body are 422 idempotency_key_reused', async () => {
    await create({}, 'create-2');
    const r = await create({ description: 'other' }, 'create-2');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reused');
  });

  it('never writes a secret or the endpoint url path to the logs', () => {
    const logs = api.logLines.join('\n');
    expect(logs).not.toContain('whsec_');
    expect(logs).not.toContain('secret-path');
  });
});

describe('test events', () => {
  it('queues one test delivery and describes it', async () => {
    const id = (await create()).body.endpoint.id as string;
    const r = await call('POST', `/v1/webhook-endpoints/${id}/test`);
    expect(r.status).toBe(202);
    expectDocumented('testWebhookEndpoint', 202, r.body);
    expect(r.body).toMatchObject({
      eventType: 'webhook.test',
      kind: 'test',
      status: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastErrorCode: null,
      succeededAt: null,
    });
    const rows = await deliveries(id);
    expect(rows.map((d) => [d.id, d.kind])).toEqual([[r.body.id, 'test']]);
    const event = await api.pool.query(
      'SELECT type, dedupe_key, brand_id, test_endpoint_id FROM webhook_event WHERE id = $1',
      [r.body.eventId],
    );
    expect(event.rows[0]).toMatchObject({
      type: 'webhook.test',
      brand_id: null,
      test_endpoint_id: id,
    });
    expect(event.rows[0].dedupe_key).toMatch(/^test:[0-9a-f-]{36}$/);
  });

  it('replays an idempotent test without queuing a second one', async () => {
    const id = (await create()).body.endpoint.id as string;
    const first = await call('POST', `/v1/webhook-endpoints/${id}/test`, { idem: 't-1' });
    const again = await call('POST', `/v1/webhook-endpoints/${id}/test`, { idem: 't-1' });
    expect(again.body).toEqual(first.body);
    expect(await deliveries(id)).toHaveLength(1);
  });

  it('answers 409 webhook_endpoint_disabled for a disabled endpoint', async () => {
    const id = (await create()).body.endpoint.id as string;
    await call('PATCH', `/v1/webhook-endpoints/${id}`, { body: { status: 'disabled' } });
    const r = await call('POST', `/v1/webhook-endpoints/${id}/test`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('webhook_endpoint_disabled');
    expect(await deliveries(id)).toHaveLength(0);
  });
});

describe('delivery history', () => {
  it('lists newest first with a keyset cursor and a status filter', async () => {
    const id = (await create()).body.endpoint.id as string;
    const made: string[] = [];
    for (let n = 0; n < 3; n++)
      made.push((await call('POST', `/v1/webhook-endpoints/${id}/test`)).body.id);
    await api.pool.query(
      `UPDATE webhook_delivery SET status = 'succeeded', succeeded_at = now(), attempts = 1 WHERE id = $1`,
      [made[0]],
    );

    const page1 = await call('GET', `/v1/webhook-endpoints/${id}/deliveries?limit=2`);
    expect(page1.status).toBe(200);
    expectDocumented('listWebhookDeliveries', 200, page1.body);
    expect(page1.body.data.map((d: { id: string }) => d.id)).toEqual([made[2], made[1]]);
    const page2 = await call(
      'GET',
      `/v1/webhook-endpoints/${id}/deliveries?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.data.map((d: { id: string }) => d.id)).toEqual([made[0]]);
    expect(page2.body.nextCursor).toBeNull();

    const done = await call('GET', `/v1/webhook-endpoints/${id}/deliveries?status=succeeded`);
    expect(done.body.data.map((d: { id: string }) => d.id)).toEqual([made[0]]);
    expect(done.body.data[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('rejects a forged cursor, a cursor of another filter, and a cursor of another endpoint', async () => {
    const id = (await create()).body.endpoint.id as string;
    const other = (await create()).body.endpoint.id as string;
    for (let n = 0; n < 2; n++) await call('POST', `/v1/webhook-endpoints/${id}/test`);
    const page = await call('GET', `/v1/webhook-endpoints/${id}/deliveries?limit=1`);
    const cursor = page.body.nextCursor as string;
    for (const url of [
      `/v1/webhook-endpoints/${id}/deliveries?cursor=forged`,
      `/v1/webhook-endpoints/${id}/deliveries?limit=1&status=failed&cursor=${cursor}`,
      `/v1/webhook-endpoints/${other}/deliveries?limit=1&cursor=${cursor}`,
    ]) {
      const r = await call('GET', url);
      expect(r.status, url).toBe(400);
      expect(r.body.error.code).toBe('invalid_cursor');
    }
    const bad = await call('GET', `/v1/webhook-endpoints/${id}/deliveries?status=bogus`);
    expect(bad.status).toBe(400);
  });
});

describe('redelivery', () => {
  async function succeededTest(): Promise<{
    endpointId: string;
    deliveryId: string;
    eventId: string;
  }> {
    const endpointId = (await create()).body.endpoint.id as string;
    const t = await call('POST', `/v1/webhook-endpoints/${endpointId}/test`);
    await api.pool.query(
      `UPDATE webhook_delivery SET status = 'succeeded', succeeded_at = now(), attempts = 1 WHERE id = $1`,
      [t.body.id],
    );
    return { endpointId, deliveryId: t.body.id, eventId: t.body.eventId };
  }
  const redeliver = (e: string, d: string, idem?: string) =>
    call('POST', `/v1/webhook-endpoints/${e}/deliveries/${d}/redeliver`, {
      ...(idem !== undefined && { idem }),
    });

  it('creates a new redelivery row for the same event', async () => {
    const s = await succeededTest();
    const r = await redeliver(s.endpointId, s.deliveryId);
    expect(r.status).toBe(202);
    expectDocumented('redeliverWebhookDelivery', 202, r.body);
    expect(r.body).toMatchObject({ kind: 'redelivery', status: 'pending', eventId: s.eventId });
    expect(r.body.id).not.toBe(s.deliveryId);
    expect((await deliveries(s.endpointId)).map((d) => d.kind)).toEqual(['test', 'redelivery']);
  });

  it('replays an idempotent redelivery without queuing another', async () => {
    const s = await succeededTest();
    const first = await redeliver(s.endpointId, s.deliveryId, 'rd-1');
    const again = await redeliver(s.endpointId, s.deliveryId, 'rd-1');
    expect(again.body).toEqual(first.body);
    expect(await deliveries(s.endpointId)).toHaveLength(2);
  });

  it.each(['pending', 'sending', 'retrying'])(
    'refuses a delivery that is still %s with 409 invalid_request',
    async (status) => {
      const s = await succeededTest();
      await api.pool.query(
        `UPDATE webhook_delivery SET status = $2, succeeded_at = NULL,
                lease_until = CASE WHEN $2 = 'sending' THEN now() + interval '1 minute' END
          WHERE id = $1`,
        [s.deliveryId, status],
      );
      const r = await redeliver(s.endpointId, s.deliveryId);
      expect(r.status).toBe(409);
      expect(r.body.error).toEqual({
        code: 'invalid_request',
        message: 'This delivery is still being attempted.',
      });
      expect(await deliveries(s.endpointId)).toHaveLength(1);
    },
  );

  it('allows failed and cancelled deliveries', async () => {
    for (const status of ['failed', 'cancelled']) {
      const s = await succeededTest();
      await api.pool.query(
        `UPDATE webhook_delivery SET status = $2, succeeded_at = NULL WHERE id = $1`,
        [s.deliveryId, status],
      );
      expect((await redeliver(s.endpointId, s.deliveryId)).status).toBe(202);
    }
  });

  it('answers 409 webhook_event_unavailable once the comment is deleted', async () => {
    const endpointId = (await create()).body.endpoint.id as string;
    const commentId = await seedLiveComment(A);
    const delivery = await api.pool.query(
      `UPDATE webhook_delivery d SET status = 'failed', attempts = 7
         FROM webhook_event e
        WHERE d.endpoint_id = $1 AND e.id = d.event_id AND e.comment_id = $2 RETURNING d.id`,
      [endpointId, commentId],
    );
    expect(delivery.rowCount).toBe(1);
    const deliveryId = delivery.rows[0].id as string;
    expect((await redeliver(endpointId, deliveryId)).status).toBe(202);
    await api.pool.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [
      commentId,
    ]);
    const r = await redeliver(endpointId, deliveryId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('webhook_event_unavailable');
    expect(await deliveries(endpointId)).toHaveLength(2);
  });

  it('answers 409 webhook_endpoint_disabled for a disabled endpoint', async () => {
    const s = await succeededTest();
    await call('PATCH', `/v1/webhook-endpoints/${s.endpointId}`, { body: { status: 'disabled' } });
    const r = await redeliver(s.endpointId, s.deliveryId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('webhook_endpoint_disabled');
  });

  it('is 404 for an unknown delivery and for a delivery of another endpoint', async () => {
    const s = await succeededTest();
    const other = (await create()).body.endpoint.id as string;
    expect((await redeliver(s.endpointId, randomUUID())).status).toBe(404);
    expect((await redeliver(other, s.deliveryId)).status).toBe(404);
  });
});
