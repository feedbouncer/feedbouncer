import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { nestHandlers } from './nest-handlers.js';
import { PUBLIC_API_CASES, type PublicIsolationFixture } from './public-api-isolation-cases.js';

let api: TestApi;
let f: PublicIsolationFixture;
beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  const A = await orgWithRoles(api, 'pisoA');
  const B = await orgWithRoles(api, 'pisoB');
  const { scope } = await api.seedFacebookConnection(B);
  const endpoint = async (orgId: string) =>
    (
      await api.pool.query(
        `INSERT INTO webhook_endpoint (organization_id, url, event_types, signing_key_id, encrypted_signing_secret)
         VALUES ($1, 'https://93.184.216.34/hook', ARRAY['item.flagged'], 'k1', '\\x01') RETURNING id`,
        [orgId],
      )
    ).rows[0].id as string;
  const aEndpointId = await endpoint(A.orgId);
  const bEndpointId = await endpoint(B.orgId);
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', '1_2') RETURNING id`,
    [B.orgId, scope.brandId, scope.connectionId],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, '1_2_3', 'hi', now()) RETURNING id`,
    [B.orgId, scope.brandId, scope.connectionId, source.rows[0].id],
  );
  const review = await api.pool.query(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
     VALUES ($1, $2, $3, $4, 'user') RETURNING id`,
    [B.orgId, scope.brandId, scope.connectionId, comment.rows[0].id],
  );
  const delivery = await api.pool.query(`SELECT id FROM webhook_delivery WHERE endpoint_id = $1`, [
    bEndpointId,
  ]);
  const key = await new PgApiKeys(api.pool).create(A.orgId, A.owner.userId, {
    name: 'writer',
    scope: 'write',
  });
  f = {
    A,
    B,
    aWriteToken: key.token.reveal(),
    bCommentId: comment.rows[0].id,
    bReviewItemId: review.rows[0].id,
    aEndpointId,
    bEndpointId,
    bDeliveryId: delivery.rows[0].id,
  };
});
afterAll(() => api.close());

async function snapshot(orgId: string) {
  const q = (sql: string) => api.pool.query(sql, [orgId]).then((r) => r.rows);
  return {
    comments: await q(
      'SELECT id, platform_state, updated_at FROM comment WHERE organization_id = $1 ORDER BY id',
    ),
    actions: await q(
      'SELECT id, status FROM moderation_action WHERE organization_id = $1 ORDER BY id',
    ),
    reviewItems: await q(
      'SELECT id, status, resolution FROM review_item WHERE organization_id = $1 ORDER BY id',
    ),
    apiKeys: await q(
      'SELECT id, revoked_at, last_used_at FROM api_key WHERE organization_id = $1 ORDER BY id',
    ),
    idempotency: await q('SELECT id FROM api_idempotency_record WHERE organization_id = $1'),
    jobs: await q('SELECT id, state FROM job_ledger WHERE organization_id = $1 ORDER BY id'),
    webhookEndpoints: await q(
      'SELECT id, description, status, updated_at, encrypted_signing_secret FROM webhook_endpoint WHERE organization_id = $1 ORDER BY id',
    ),
    webhookDeliveries: await q(
      'SELECT id, kind, status FROM webhook_delivery WHERE organization_id = $1 ORDER BY id',
    ),
    audit: await q(
      'SELECT sequence, action, subject_id FROM audit_event WHERE organization_id = $1 ORDER BY sequence',
    ),
  };
}

const registeredPublicRoutes = (): string[] =>
  nestHandlers(api.app)
    .map((h) => h.route.replace(/:(\w+)/g, '{$1}'))
    .filter((r) => r.split(' ')[1]!.startsWith('/v1/'));

describe('public API tenant isolation', () => {
  it('covers every registered /v1 route with a path parameter', () => {
    const covered = new Set<string>(PUBLIC_API_CASES.map((c) => c.route));
    const missing = registeredPublicRoutes().filter((r) => r.includes('{') && !covered.has(r));
    expect(missing).toEqual([]);
  });

  for (const c of PUBLIC_API_CASES) {
    it(`${c.route}${c.label ? ` (${c.label})` : ''} on B's ids with A's write key -> 404, B unchanged`, async () => {
      const before = await snapshot(f.B.orgId);
      expect(before.comments.length).toBeGreaterThan(0);
      expect(before.reviewItems.length).toBeGreaterThan(0);
      expect(before.webhookDeliveries.length).toBeGreaterThan(0);
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), {
        body: c.body?.(f),
        headers: { authorization: `Bearer ${f.aWriteToken}`, 'x-forwarded-for': '203.0.113.9' },
      });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      expect(await snapshot(f.B.orgId)).toEqual(before);
    });
  }
});
