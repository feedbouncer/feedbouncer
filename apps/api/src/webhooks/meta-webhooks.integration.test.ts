import { createHmac, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { Secret } from '@feedbouncer/service-runtime';
import {
  WEB,
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const VERIFY = 'verify-token-0123456789';
const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret(VERIFY),
};
const INSTAGRAM = { meta: FACEBOOK };
const URL_PATH = '/api/v1/webhooks/facebook';
const IG_PATH = '/api/v1/webhooks/instagram';
const JSON_CT = { 'content-type': 'application/json' };

const sign = (raw: string) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const payload = (pageId: string, pad = '') =>
  JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 1_760_000_100,
        changes: [
          {
            field: 'feed',
            value: {
              item: 'comment',
              verb: 'add',
              post_id: `${pageId}_1`,
              comment_id: `${pageId}_1_${randomInt(1, 1_000_000_000)}`,
              created_time: 1_760_000_000,
            },
          },
        ],
      },
    ],
    ...(pad ? { pad } : {}),
  });

let api: TestApi;
let org: OrgFixture;
let other: OrgFixture;
let graph: FakeGraph;
beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: FACEBOOK.appId });
  api = await startTestApi({ facebook: FACEBOOK, instagram: INSTAGRAM }, { fetch: graph.fetch });
  org = await orgWithRoles(api, 'hook');
  other = await orgWithRoles(api, 'hook2', {
    owner: org.admin,
    admin: org.owner,
    member: org.member,
  });
});
afterAll(() => api.close());

const jobsOf = async (connectionId: string) =>
  (
    await api.pool.query<{ job_type: string }>(
      'SELECT job_type FROM job_ledger WHERE connection_id = $1 ORDER BY created_at',
      [connectionId],
    )
  ).rows.map((r) => r.job_type);

describe('GET /api/v1/webhooks/facebook (handshake)', () => {
  it('echoes the challenge as text/plain when the token matches', async () => {
    const r = await api.raw(
      'GET',
      `${URL_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`,
    );
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^text\/plain/);
    expect(r.text).toBe('1158201444');
  });

  it('403s a wrong token and never reflects markup', async () => {
    const bad = await api.raw(
      'GET',
      `${URL_PATH}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
    );
    expect(bad.status).toBe(403);
    const r = await api.raw(
      'GET',
      `${URL_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`,
    );
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('<script>');
    expect(r.text).not.toContain(VERIFY);
  });
});

describe('POST /api/v1/webhooks/facebook', () => {
  it('accepts a signed body from a foreign origin (no Origin check) and enqueues ingest', async () => {
    const page = await api.seedFacebookConnection(org);
    const raw = payload(page.pageId);
    const r = await api.raw('POST', URL_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw), origin: 'https://facebook.com' },
    });
    expect(r.status).toBe(200);
    expect(await jobsOf(page.scope.connectionId)).toEqual(['comment_ingest']);
  });

  it('rejects missing and invalid signatures with 403 and enqueues nothing', async () => {
    const page = await api.seedFacebookConnection(org);
    const raw = payload(page.pageId);
    for (const headers of [
      {},
      { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      { 'x-hub-signature-256': sign(`${raw} `) },
    ]) {
      const r = await api.raw('POST', URL_PATH, { body: raw, headers: { ...JSON_CT, ...headers } });
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(SECRET);
    }
    expect(await jobsOf(page.scope.connectionId)).toEqual([]);
  });

  it('treats a replayed body as success without new jobs', async () => {
    const page = await api.seedFacebookConnection(org);
    const raw = payload(page.pageId);
    const send = () =>
      api.raw('POST', URL_PATH, {
        body: raw,
        headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(await jobsOf(page.scope.connectionId)).toHaveLength(1);
  });

  it('routes events only to the connection that owns the Page id', async () => {
    const mine = await api.seedFacebookConnection(org);
    const other = await api.seedFacebookConnection(org);
    const raw = payload(mine.pageId);
    await api.raw('POST', URL_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
    });
    expect(await jobsOf(mine.scope.connectionId)).toHaveLength(1);
    expect(await jobsOf(other.scope.connectionId)).toEqual([]);
  });

  it('accepts bodies above the global 64 KiB limit up to 1 MiB, refuses larger', async () => {
    const page = await api.seedFacebookConnection(org);
    const big = payload(page.pageId, 'x'.repeat(200 * 1024));
    const ok = await api.raw('POST', URL_PATH, {
      body: big,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(big) },
    });
    expect(ok.status).toBe(200);
    const huge = payload(page.pageId, 'x'.repeat(1_100 * 1024));
    const refused = await api.raw('POST', URL_PATH, {
      body: huge,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(huge) },
    });
    expect(refused.status).toBe(413);
  });

  it('the Origin exemption is per route: other POSTs from a foreign origin still 403', async () => {
    const r = await api.raw('POST', '/api/v1/orgs', {
      body: '{}',
      headers: { ...JSON_CT, origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
  });

  it('answers 503 and leaves the delivery unprocessed when enqueueing fails, so Meta retries', async () => {
    const failing = await startTestApi(
      { facebook: FACEBOOK },
      {
        producer: {
          enqueue: async () => {
            throw new Error('redis down');
          },
        } as never,
      },
    );
    try {
      const fixture = await orgWithRoles(failing, 'hookfail');
      const page = await failing.seedFacebookConnection(fixture);
      const raw = payload(page.pageId);
      const r = await failing.raw('POST', URL_PATH, {
        body: raw,
        headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
      });
      expect(r.status).toBe(503);
      expect(r.text).not.toContain('redis down');
      const done = await failing.pool.query(
        "SELECT 1 FROM processed_job WHERE queue = 'webhook:facebook'",
      );
      expect(done.rows).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });
});

/** An IG account behind a FakeGraph Page, connected (seeded) in `f`'s brand. */
async function seededInstagram(f: OrgFixture) {
  const { userId } = graph.addUser();
  const { pageId } = graph.addPage(userId);
  const { igUserId } = graph.addInstagramAccount(pageId);
  const conn = await api.seedConnection(f, { platform: 'instagram', externalAccountId: igUserId });
  return { igUserId, scope: conn.scope };
}

const ledgerOf = async (connectionId: string) =>
  (
    await api.pool.query<{
      job_type: string;
      platform: string;
      organization_id: string;
      brand_id: string;
    }>(
      `SELECT job_type, platform, organization_id, brand_id FROM job_ledger
        WHERE connection_id = $1 ORDER BY created_at`,
      [connectionId],
    )
  ).rows;

const deliverIg = (d: { headers: Record<string, string>; rawBody: Buffer }) =>
  api.raw('POST', IG_PATH, { body: d.rawBody.toString('utf8'), headers: d.headers });

describe('/api/v1/webhooks/instagram', () => {
  it('GET handshake on /api/v1/webhooks/instagram returns the challenge for the right verify token, 403 otherwise', async () => {
    const ok = await api.raw(
      'GET',
      `${IG_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=987654321`,
    );
    expect(ok.status).toBe(200);
    expect(String(ok.headers['content-type'])).toMatch(/^text\/plain/);
    expect(ok.text).toBe('987654321');
    for (const q of [
      `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      `hub.mode=subscribe&hub.challenge=1`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`,
    ]) {
      const bad = await api.raw('GET', `${IG_PATH}?${q}`);
      expect(bad.status, q).toBe(403);
      expect(bad.text).not.toContain(VERIFY);
      expect(bad.text).not.toContain('<script>');
    }
  });

  it('POST with a valid signature returns 200 and enqueues one comment_ingest scoped to the owning brand', async () => {
    const mine = await seededInstagram(org);
    const elsewhere = await seededInstagram(other);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const r = await deliverIg(
      graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]),
    );
    expect(r.status).toBe(200);
    expect(await ledgerOf(mine.scope.connectionId)).toEqual([
      {
        job_type: 'comment_ingest',
        platform: 'instagram',
        organization_id: org.orgId,
        brand_id: org.brandId,
      },
    ]);
    expect(await ledgerOf(elsewhere.scope.connectionId)).toEqual([]);
  });

  it('POST with a missing or invalid signature returns 403 and enqueues nothing', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const d = graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]);
    const raw = d.rawBody.toString('utf8');
    for (const sig of [undefined, `sha256=${'0'.repeat(64)}`, sign(`${raw} `), 'sha1=abc']) {
      const r = await api.raw('POST', IG_PATH, {
        body: raw,
        headers: { ...JSON_CT, ...(sig === undefined ? {} : { 'x-hub-signature-256': sig }) },
      });
      expect(r.status, String(sig)).toBe(403);
      expect(r.text).not.toContain(SECRET);
    }
    expect(await ledgerOf(mine.scope.connectionId)).toEqual([]);
  });

  it('replaying the same body returns 200 and enqueues nothing new', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const d = graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]);
    expect((await deliverIg(d)).status).toBe(200);
    expect((await deliverIg(d)).status).toBe(200);
    expect(await ledgerOf(mine.scope.connectionId)).toHaveLength(1);
  });

  it('a body for an unknown IG account returns 200 and enqueues nothing', async () => {
    const spy = vi.spyOn(api.deps.producer!, 'enqueue');
    try {
      const { userId } = graph.addUser();
      const { igUserId } = graph.addInstagramAccount(graph.addPage(userId).pageId);
      const { mediaId, commentId } = graph.addIgComment(igUserId);
      const r = await deliverIg(graph.signedInstagramDelivery(igUserId, [{ commentId, mediaId }]));
      expect(r.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('an IG account id that is only connected as a facebook page is not routed', async () => {
    const fbOnly = await api.seedFacebookConnection(org);
    const r = await deliverIg(
      graph.signedInstagramDelivery(fbOnly.pageId, [{ commentId: '17890000000000001' }]),
    );
    expect(r.status).toBe(200);
    expect(await jobsOf(fbOnly.scope.connectionId)).toEqual([]);
  });

  it('the response does not wait for ingest: the producer only enqueues; no Graph call happens during the request', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const before = graph.calls().length;
    const spy = vi.spyOn(api.deps.producer!, 'enqueue');
    try {
      const r = await deliverIg(
        graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]),
      );
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({
        platform: 'instagram',
        type: 'comment_ingest',
        scope: mine.scope,
        payload: { sourceExternalId: mediaId, commentExternalId: commentId, event: 'created' },
      });
    } finally {
      spy.mockRestore();
    }
    expect(graph.calls()).toHaveLength(before);
  });

  it('a page-object body posted to the instagram route is accepted (200) and enqueues nothing', async () => {
    const page = await api.seedFacebookConnection(org);
    const raw = payload(page.pageId);
    const r = await api.raw('POST', IG_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
    });
    expect(r.status).toBe(200);
    expect(await jobsOf(page.scope.connectionId)).toEqual([]);
  });

  it('a 1 MiB + 1 body is rejected 413 without parsing', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const body = JSON.parse(
      graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]).rawBody.toString(),
    ) as Record<string, unknown>;
    const bare = JSON.stringify({ ...body, pad: '' });
    const raw = JSON.stringify({ ...body, pad: 'x'.repeat(1_048_577 - Buffer.byteLength(bare)) });
    expect(Buffer.byteLength(raw)).toBe(1_048_577);
    const r = await api.raw('POST', IG_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
    });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.text)).toEqual({
      error: { code: 'invalid_request', message: 'Request body too large.' },
    });
    expect(await ledgerOf(mine.scope.connectionId)).toEqual([]);
    const seen = await api.pool.query(
      "SELECT 1 FROM processed_job WHERE queue = 'webhook:instagram'",
    );
    // Nothing from this delivery reached the gate's ledger.
    const exact = JSON.stringify({ ...body, pad: 'x'.repeat(1_048_576 - Buffer.byteLength(bare)) });
    expect(Buffer.byteLength(exact)).toBe(1_048_576);
    const accepted = await api.raw('POST', IG_PATH, {
      body: exact,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(exact) },
    });
    expect(accepted.status).toBe(200);
    const after = await api.pool.query(
      "SELECT 1 FROM processed_job WHERE queue = 'webhook:instagram'",
    );
    expect(after.rows).toHaveLength(seen.rows.length + 1);
  });

  it('a signed instagram delivery from a foreign origin is not origin-checked', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const d = graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]);
    const r = await api.raw('POST', IG_PATH, {
      body: d.rawBody.toString('utf8'),
      headers: { ...d.headers, origin: 'https://www.instagram.com' },
    });
    expect(r.status).toBe(200);
  });

  it('the facebook webhook still works unchanged', async () => {
    const page = await api.seedFacebookConnection(org);
    const raw = payload(page.pageId);
    const r = await api.raw('POST', URL_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(raw) },
    });
    expect(r.status).toBe(200);
    expect(await ledgerOf(page.scope.connectionId)).toEqual([
      {
        job_type: 'comment_ingest',
        platform: 'facebook',
        organization_id: org.orgId,
        brand_id: org.brandId,
      },
    ]);
    // A facebook body sent to the facebook route never routes to an instagram connection.
    const ig = await seededInstagram(org);
    const crossed = payload(ig.igUserId);
    expect(
      (
        await api.raw('POST', URL_PATH, {
          body: crossed,
          headers: { ...JSON_CT, 'x-hub-signature-256': sign(crossed) },
        })
      ).status,
    ).toBe(200);
    expect(await ledgerOf(ig.scope.connectionId)).toEqual([]);
  });

  it('answers 503 and enqueues nothing when enqueueing fails, so Meta retries', async () => {
    const mine = await seededInstagram(org);
    const { mediaId, commentId } = graph.addIgComment(mine.igUserId);
    const d = graph.signedInstagramDelivery(mine.igUserId, [{ commentId, mediaId }]);
    const spy = vi
      .spyOn(api.deps.producer!, 'enqueue')
      .mockRejectedValueOnce(new Error('redis down at 10.0.0.7'));
    try {
      const r = await deliverIg(d);
      expect(r.status).toBe(503);
      expect(r.text).not.toContain('10.0.0.7');
    } finally {
      spy.mockRestore();
    }
    // Meta's redelivery then succeeds.
    expect((await deliverIg(d)).status).toBe(200);
    expect(await ledgerOf(mine.scope.connectionId)).toHaveLength(1);
  });
});

describe('with instagram disabled', () => {
  it('has no instagram webhook routes, while facebook still answers', async () => {
    const fbOnly = await startTestApi({ facebook: FACEBOOK });
    try {
      const post = await fbOnly.raw('POST', IG_PATH, {
        body: '{}',
        headers: { ...JSON_CT, origin: WEB },
      });
      expect(post.status).toBe(404);
      expect(
        (
          await fbOnly.raw(
            'GET',
            `${IG_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fbOnly.raw(
            'GET',
            `${URL_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
          )
        ).status,
      ).toBe(200);
    } finally {
      await fbOnly.close();
    }
  });
});

describe('without facebook configured', () => {
  it('has no webhook routes', async () => {
    const plain = await startTestApi();
    try {
      // A POST that matches no route goes through the normal Origin check, so send the app's own.
      const post = await plain.raw('POST', URL_PATH, {
        body: '{}',
        headers: { ...JSON_CT, origin: WEB },
      });
      expect(post.status).toBe(404);
      expect((await plain.raw('GET', URL_PATH)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
