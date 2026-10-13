import { createHmac, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const URL_PATH = '/api/v1/webhooks/facebook';
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
beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK });
  org = await orgWithRoles(api, 'hook');
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

  it('answers 500 and leaves the delivery unprocessed when enqueueing fails, so Meta retries', async () => {
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
      expect(r.status).toBe(500);
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
