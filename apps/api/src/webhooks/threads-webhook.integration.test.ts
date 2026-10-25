import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeThreads } from '@feedbouncer/connector-threads/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';
import { THREADS_WEBHOOK_PATH } from './meta-webhooks.plugin.js';

const THREADS_SECRET = 'threads-app-secret-0123456789abcdef';
const FB_SECRET = 'fb-app-secret-0123456789abcdef';
const VERIFY = 'threads-verify-token-0123456789';
const THREADS = {
  appId: '2220001112223334',
  appSecret: new Secret(THREADS_SECRET),
  webhookVerifyToken: new Secret(VERIFY),
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};
const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret(FB_SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('fb-verify-token-0123456789'),
};
const JSON_CT = { 'content-type': 'application/json' };

const sign = (secret: string, raw: string | Buffer) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

let api: TestApi;
let org: OrgFixture;
let fake: FakeThreads;
beforeAll(async () => {
  fake = new FakeThreads({ appId: THREADS.appId, appSecret: THREADS_SECRET });
  api = await startTestApi({ facebook: FACEBOOK, threads: THREADS }, { fetch: fake.fetch });
  org = await orgWithRoles(api, 'threads-hook');
});
afterAll(() => api.close());

/** A Threads account connected in the org's brand, with one post and one reply on it. */
async function connectedReply(status: 'active' | 'reconnect_required' = 'active') {
  const { userId } = fake.addUser();
  const conn = await api.seedConnection(org, { platform: 'threads', externalAccountId: userId });
  if (status !== 'active')
    await api.pool.query(
      "UPDATE connection SET status = $2, status_reason = 'token_expired' WHERE id = $1",
      [conn.scope.connectionId, status],
    );
  const { postId } = fake.addPost(userId);
  const { replyId } = fake.addReply(postId, { at: new Date(), byUserId: fake.addUser().userId });
  return { userId, postId, replyId, scope: conn.scope };
}

const deliver = (d: { headers: Record<string, string>; rawBody: Buffer }) =>
  api.raw('POST', THREADS_WEBHOOK_PATH, { body: d.rawBody.toString('utf8'), headers: d.headers });

const pendingOf = async (connectionId: string) =>
  (
    await api.pool.query<{ external_id: string; source_external_id: string }>(
      `SELECT external_id, source_external_id FROM threads_pending_reply
        WHERE connection_id = $1 ORDER BY external_id`,
      [connectionId],
    )
  ).rows;

const jobsOf = async (connectionId: string) =>
  (
    await api.pool.query<{ job_type: string }>(
      'SELECT job_type FROM job_ledger WHERE connection_id = $1',
      [connectionId],
    )
  ).rows.map((r) => r.job_type);

const logged = (msg: string) =>
  api.logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === msg);

describe('Threads webhook', () => {
  it('GET handshake echoes hub.challenge with the right verify token, 403 otherwise', async () => {
    const ok = await api.raw(
      'GET',
      `${THREADS_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4815162342`,
    );
    expect(ok.status).toBe(200);
    expect(String(ok.headers['content-type'])).toMatch(/^text\/plain/);
    expect(ok.text).toBe('4815162342');
    for (const q of [
      'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
      // The Facebook app's token does not open the Threads route.
      'hub.mode=subscribe&hub.verify_token=fb-verify-token-0123456789&hub.challenge=1',
      'hub.mode=subscribe&hub.challenge=1',
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`,
    ]) {
      const bad = await api.raw('GET', `${THREADS_WEBHOOK_PATH}?${q}`);
      expect(bad.status, q).toBe(403);
      expect(bad.text).not.toContain(VERIFY);
      expect(bad.text).not.toContain('<script>');
    }
  });

  it('signed replies notification → 200, one pending row, source next_poll_at <= now, no comment_ingest job', async () => {
    const r = await connectedReply();
    const res = await deliver(fake.signedDelivery({ replyId: r.replyId }));
    expect(res.status).toBe(200);
    expect(await pendingOf(r.scope.connectionId)).toEqual([
      { external_id: r.replyId, source_external_id: r.postId },
    ]);
    const src = await api.pool.query<{ kind: string; next_poll_at: Date }>(
      `SELECT s.kind, sp.next_poll_at FROM source s JOIN source_poll sp ON sp.source_id = s.id
        WHERE s.connection_id = $1 AND s.external_id = $2`,
      [r.scope.connectionId, r.postId],
    );
    expect(src.rows).toHaveLength(1);
    expect(src.rows[0]!.kind).toBe('thread');
    expect(src.rows[0]!.next_poll_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await jobsOf(r.scope.connectionId)).toEqual([]);
    // Nothing the stranger wrote, and no secret, reaches the logs.
    const all = api.logLines.join('\n');
    for (const s of [THREADS_SECRET, VERIFY]) expect(all).not.toContain(s);
  });

  it('same body delivered twice → one pending row (ledger dedup)', async () => {
    const r = await connectedReply();
    const d = fake.signedDelivery({ replyId: r.replyId });
    expect((await deliver(d)).status).toBe(200);
    expect((await deliver(d)).status).toBe(200);
    expect(await pendingOf(r.scope.connectionId)).toHaveLength(1);
    expect(logged('duplicate webhook delivery skipped')).toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'threads' })]),
    );
  });

  it('unsigned → 403 and log "webhook rejected" {platform:"threads", check:"signature_missing"}', async () => {
    const r = await connectedReply();
    const d = fake.signedDelivery({ replyId: r.replyId });
    api.logLines.length = 0;
    const res = await api.raw('POST', THREADS_WEBHOOK_PATH, {
      body: d.rawBody.toString('utf8'),
      headers: JSON_CT,
    });
    expect(res.status).toBe(403);
    expect(logged('webhook rejected')).toEqual([
      expect.objectContaining({ platform: 'threads', check: 'signature_missing' }),
    ]);
    expect(await pendingOf(r.scope.connectionId)).toEqual([]);
  });

  it('bad signature → 403, check signature_mismatch', async () => {
    const r = await connectedReply();
    const raw = fake.signedDelivery({ replyId: r.replyId }).rawBody.toString('utf8');
    api.logLines.length = 0;
    const res = await api.raw('POST', THREADS_WEBHOOK_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(THREADS_SECRET, `${raw} `) },
    });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(THREADS_SECRET);
    expect(logged('webhook rejected')).toEqual([
      expect.objectContaining({ platform: 'threads', check: 'signature_mismatch' }),
    ]);
    expect(await pendingOf(r.scope.connectionId)).toEqual([]);
  });

  it('signed with the Facebook app secret → 403', async () => {
    const r = await connectedReply();
    const raw = fake.signedDelivery({ replyId: r.replyId }).rawBody.toString('utf8');
    const res = await api.raw('POST', THREADS_WEBHOOK_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(FB_SECRET, raw) },
    });
    expect(res.status).toBe(403);
    expect(await pendingOf(r.scope.connectionId)).toEqual([]);
    // And the reverse: a Threads-signed body is not accepted on the Facebook route.
    const fb = await api.raw('POST', '/api/v1/webhooks/facebook', {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(THREADS_SECRET, raw) },
    });
    expect(fb.status).toBe(403);
  });

  it('account with no live connection → 200, nothing stored, webhook.unrouted_events logged', async () => {
    const { userId } = fake.addUser();
    const { postId } = fake.addPost(userId);
    const { replyId } = fake.addReply(postId, { at: new Date() });
    api.logLines.length = 0;
    const res = await deliver(fake.signedDelivery({ replyId }));
    expect(res.status).toBe(200);
    const stored = await api.pool.query(
      'SELECT 1 FROM threads_pending_reply WHERE external_id = $1',
      [replyId],
    );
    expect(stored.rows).toEqual([]);
    const src = await api.pool.query('SELECT 1 FROM source WHERE external_id = $1', [postId]);
    expect(src.rows).toEqual([]);
    expect(logged('webhook.unrouted_events')).toEqual([
      expect.objectContaining({ platform: 'threads', count: 1 }),
    ]);
  });

  it('notification for a reconnect_required connection is still recorded', async () => {
    const r = await connectedReply('reconnect_required');
    expect((await deliver(fake.signedDelivery({ replyId: r.replyId }))).status).toBe(200);
    expect(await pendingOf(r.scope.connectionId)).toEqual([
      { external_id: r.replyId, source_external_id: r.postId },
    ]);
  });

  it('body over 1 MiB → 413/403 without parsing', async () => {
    const r = await connectedReply();
    const body = JSON.parse(
      fake.signedDelivery({ replyId: r.replyId }).rawBody.toString('utf8'),
    ) as Record<string, unknown>;
    const raw = JSON.stringify({ ...body, pad: 'x'.repeat(1_048_577) });
    const seen = await api.pool.query(
      "SELECT 1 FROM processed_job WHERE queue = 'webhook:threads'",
    );
    const res = await api.raw('POST', THREADS_WEBHOOK_PATH, {
      body: raw,
      headers: { ...JSON_CT, 'x-hub-signature-256': sign(THREADS_SECRET, raw) },
    });
    expect([413, 403]).toContain(res.status);
    expect(await pendingOf(r.scope.connectionId)).toEqual([]);
    const after = await api.pool.query(
      "SELECT 1 FROM processed_job WHERE queue = 'webhook:threads'",
    );
    expect(after.rows).toHaveLength(seen.rows.length);
  });

  it('answers 503 and stores nothing when recording the wake fails, so Meta retries', async () => {
    const r = await connectedReply();
    const d = fake.signedDelivery({ replyId: r.replyId });
    // A constraint that refuses every new row stands in for a failing write.
    await api.pool.query(
      'ALTER TABLE threads_pending_reply ADD CONSTRAINT test_refuse CHECK (false) NOT VALID',
    );
    try {
      const res = await deliver(d);
      expect(res.status).toBe(503);
      expect(res.text).not.toContain('test_refuse');
    } finally {
      await api.pool.query('ALTER TABLE threads_pending_reply DROP CONSTRAINT test_refuse');
    }
    expect(await pendingOf(r.scope.connectionId)).toEqual([]);
    expect((await deliver(d)).status).toBe(200);
    expect(await pendingOf(r.scope.connectionId)).toHaveLength(1);
  });
});

describe('Threads webhook enablement', () => {
  it('route registers with Threads alone, without the Facebook config', async () => {
    const solo = await startTestApi({ threads: THREADS });
    try {
      const ok = await solo.raw(
        'GET',
        `${THREADS_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=7`,
      );
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('7');
      expect((await solo.raw('GET', '/api/v1/webhooks/facebook?hub.mode=subscribe')).status).toBe(
        404,
      );
    } finally {
      await solo.close();
    }
  });

  it('route absent (404) when THREADS_WEBHOOK_VERIFY_TOKEN is unset', async () => {
    const off = await startTestApi({
      facebook: FACEBOOK,
      threads: { ...THREADS, webhookVerifyToken: null },
    });
    try {
      expect(
        (
          await off.raw(
            'GET',
            `${THREADS_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
          )
        ).status,
      ).toBe(404);
      const post = await off.raw('POST', THREADS_WEBHOOK_PATH, {
        body: '{}',
        headers: { ...JSON_CT, origin: 'http://localhost:3000' },
      });
      expect(post.status).toBe(404);
      // Facebook's route is unaffected.
      expect(
        (
          await off.raw(
            'GET',
            '/api/v1/webhooks/facebook?hub.mode=subscribe&hub.verify_token=fb-verify-token-0123456789&hub.challenge=1',
          )
        ).status,
      ).toBe(200);
    } finally {
      await off.close();
    }
  });
});
