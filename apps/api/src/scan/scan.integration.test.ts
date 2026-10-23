// The free scan's lifecycle over the API: grant -> scan -> share -> delete, with
// visitor isolation. Grants are inserted directly; no worker runs, so created
// scans stay queued unless a test settles them through the store.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PgScanStore,
  SCAN_QUEUE,
  scanTokenCtx,
  type ScanPageOption,
  type ScanResultV1,
} from '@feedbouncer/scan';
import { open, seal } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { WEB, startTestApi, type RawResponse, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const ALL_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'ads_read',
  'instagram_basic',
  'instagram_manage_comments',
];
const BASE = '/api/v1/scan';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const pageId = () => `1${String(randomInt(0, 100_000_000_000_000)).padStart(14, '0')}`;

const RESULT: ScanResultV1 = {
  v: 1,
  limits: { windowDays: 30, maxAds: 25, maxComments: 2000 },
  totals: {
    adsCovered: 1,
    postsScanned: 1,
    commentsScanned: 40,
    scamSpam: 4,
    uncertain: 2,
    clean: 30,
    unclassified: 4,
    hiddenExcluded: 1,
    repeatedComments: 0,
  },
  sharePct: 16.7,
  reliable: true,
  empty: false,
  notices: [],
  breakdown: [{ category: 'scam_phishing', count: 4, tags: { crypto_investment: 4 } }],
  perAd: [
    {
      ordinal: 1,
      label: 'Spring sale',
      platform: 'facebook',
      adCount: 1,
      scanned: 40,
      scamSpam: 4,
      uncertain: 2,
      unclassified: 4,
      hiddenExcluded: 1,
    },
  ],
  examples: [
    {
      bucket: 'scam_spam',
      category: 'scam_phishing',
      tags: ['crypto_investment'],
      text: 'Double your coins today',
      authorLabel: 'J. D.',
      adOrdinal: 1,
      reason: 'Promises investment returns.',
      repeatCount: 1,
    },
  ],
};

let api: TestApi;
let store: PgScanStore;
let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK });
  store = new PgScanStore(api.pool);
  redis = new Redis(api.deps.env.redisUrl.href);
  queue = new Queue(SCAN_QUEUE, { connection: redis, prefix: api.deps.env.jobs.prefix });
});
afterAll(async () => {
  await queue.close();
  redis.disconnect();
  await api.close();
});
beforeEach(async () => {
  const keys = await api.deps.redis.keys(`${api.deps.redisKeyPrefix}rl:scan_*`);
  if (keys.length) await api.deps.redis.del(...keys);
});

interface Visitor {
  id: string;
  cookie: string;
}

async function visitor(): Promise<Visitor> {
  const token = randomBytes(32).toString('base64url');
  return { id: await store.createVisitor(sha256(token)), cookie: `fb_scan_visitor=${token}` };
}

const page = (over: Partial<ScanPageOption> = {}): ScanPageOption => ({
  pageId: pageId(),
  name: 'Acme',
  igUserId: null,
  igUsername: null,
  eligible: true,
  ineligibleReason: null,
  ...over,
});

const USER_TOKEN = 'EAAB-user-token-0123456789';

async function grant(
  v: Visitor,
  pages: ScanPageOption[] = [page()],
  o: { scopes?: string[]; fbUser?: string; expiresAt?: Date } = {},
): Promise<{ grantId: string; pages: ScanPageOption[] }> {
  const id = randomUUID();
  await store.insertGrant({
    id,
    visitorId: v.id,
    fbUserHash: sha256(o.fbUser ?? `user-${randomUUID()}`),
    token: await seal(api.deps.env.encryption, new Secret(USER_TOKEN), {
      organizationId: 'scan-tool',
      connectionId: id,
      kind: 'scan_user_token',
    }),
    scopes: o.scopes ?? ALL_SCOPES,
    pages,
    expiresAt: o.expiresAt ?? new Date(Date.now() + 30 * 60_000),
  });
  return { grantId: id, pages };
}

/** Like api.raw, but with the web Origin and an optional cookie. */
function send(
  method: string,
  url: string,
  o: { cookie?: string; body?: unknown } = {},
): Promise<RawResponse> {
  return api.raw(method, url, {
    headers: {
      origin: WEB,
      ...(o.cookie && { cookie: o.cookie }),
      ...(o.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
  });
}
const json = (r: RawResponse) => JSON.parse(r.text);

async function createScan(v: Visitor, grantId: string, pid: string): Promise<RawResponse> {
  return send('POST', `${BASE}/scans`, { cookie: v.cookie, body: { grantId, pageId: pid } });
}

/** A queued scan for the visitor, created through the API. */
async function queuedScan(v: Visitor): Promise<string> {
  const g = await grant(v);
  const r = await createScan(v, g.grantId, g.pages[0]!.pageId);
  expect(r.status, r.text).toBe(201);
  return json(r).scanId as string;
}

async function completedScan(v: Visitor, result: ScanResultV1 = RESULT): Promise<string> {
  const id = await queuedScan(v);
  const claimed = await store.claim(id, new Date());
  expect(await store.complete(id, claimed!.attempt, result, new Date())).toBe(true);
  return id;
}

async function metric(name: string): Promise<number> {
  const text = await api.deps.metrics.registry.metrics();
  const m = new RegExp(`^${name}\\{[^}]*\\} (\\d+)$`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

describe('isolation', () => {
  it('visitor B gets 404 not_found on A’s grant, scan GET/DELETE, share PUT/DELETE; no cookie → 404', async () => {
    const a = await visitor();
    const b = await visitor();
    const aGrant = await grant(a);
    const aScan = await completedScan(a);
    expect((await send('PUT', `${BASE}/scans/${aScan}/share`, { cookie: a.cookie })).status).toBe(
      200,
    );

    const unknown = await send('GET', `${BASE}/scans/${UNKNOWN}`, { cookie: a.cookie });
    expect(unknown.status).toBe(404);
    expect(json(unknown).error.code).toBe('not_found');

    const attempts: [string, string, unknown?][] = [
      ['GET', `${BASE}/grants/${aGrant.grantId}`],
      ['GET', `${BASE}/scans/${aScan}`],
      ['DELETE', `${BASE}/scans/${aScan}`],
      ['PUT', `${BASE}/scans/${aScan}/share`],
      ['DELETE', `${BASE}/scans/${aScan}/share`],
      ['POST', `${BASE}/scans`, { grantId: aGrant.grantId, pageId: aGrant.pages[0]!.pageId }],
      ['GET', `${BASE}/scans/not-a-uuid`],
      ['GET', `${BASE}/grants/not-a-uuid`],
    ];
    for (const cookie of [b.cookie, undefined, 'fb_scan_visitor=garbage']) {
      for (const [method, url, body] of attempts) {
        const r = await send(method, url, { ...(cookie && { cookie }), body });
        expect([method, url, r.status, r.text]).toEqual([method, url, 404, unknown.text]);
        expect(r.headers['cache-control']).toBe('no-store');
      }
    }
    for (const [method, url] of [
      ['GET', `${BASE}/scans`],
      ['DELETE', `${BASE}/me`],
    ] as const) {
      const r = await send(method, url);
      expect([r.status, r.text]).toEqual([404, unknown.text]);
    }

    // A's data is untouched: the scan, its share and the grant are still there.
    const mine = await send('GET', `${BASE}/scans/${aScan}`, { cookie: a.cookie });
    expect(mine.status).toBe(200);
    expect(json(mine).shared).toBe(true);
    expect(
      (await send('GET', `${BASE}/grants/${aGrant.grantId}`, { cookie: a.cookie })).status,
    ).toBe(200);
    // B's own list holds nothing of A's.
    const list = await send('GET', `${BASE}/scans`, { cookie: b.cookie });
    expect(json(list)).toEqual({ scans: [] });
  });

  it('state-changing routes keep the Origin check', async () => {
    const a = await visitor();
    const id = await queuedScan(a);
    const r = await api.raw('DELETE', `${BASE}/scans/${id}`, {
      headers: { cookie: a.cookie, origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
    expect(json(r).error.code).toBe('invalid_origin');
    expect((await send('GET', `${BASE}/scans/${id}`, { cookie: a.cookie })).status).toBe(200);
  });
});

describe('GET /scan/grants/:grantId', () => {
  it('lists the pages and whether Instagram was granted; an expired grant is a 404', async () => {
    const v = await visitor();
    const pages = [page(), page({ eligible: false, ineligibleReason: 'insufficient_page_role' })];
    const g = await grant(v, pages);
    const r = await send('GET', `${BASE}/grants/${g.grantId}`, { cookie: v.cookie });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(json(r)).toEqual({ pages, instagramGranted: true });

    const noIg = await grant(v, pages, { scopes: ALL_SCOPES.slice(0, 5) });
    const r2 = await send('GET', `${BASE}/grants/${noIg.grantId}`, { cookie: v.cookie });
    expect(json(r2).instagramGranted).toBe(false);

    const old = await grant(v, pages, { expiresAt: new Date(Date.now() - 1000) });
    const r3 = await send('GET', `${BASE}/grants/${old.grantId}`, { cookie: v.cookie });
    expect(r3.status).toBe(404);
  });
});

describe('POST /scan/scans', () => {
  it('create scan for a page not in the grant or ineligible → 422 page_not_eligible; grant reused → 404', async () => {
    const v = await visitor();
    const ok = page();
    const bad = page({ eligible: false, ineligibleReason: 'insufficient_page_role' });
    const g = await grant(v, [ok, bad]);

    for (const pid of [bad.pageId, pageId()]) {
      const r = await createScan(v, g.grantId, pid);
      expect(r.status).toBe(422);
      expect(json(r).error.code).toBe('page_not_eligible');
    }
    for (const body of [
      { grantId: g.grantId, pageId: 'abc' },
      { grantId: 'nope', pageId: ok.pageId },
      { grantId: g.grantId, pageId: ok.pageId, extra: 1 },
      { grantId: g.grantId },
    ]) {
      const r = await send('POST', `${BASE}/scans`, { cookie: v.cookie, body });
      expect(r.status).toBe(400);
      expect(json(r).error.code).toBe('invalid_request');
    }

    // Neither refusal consumed the grant.
    const created = await createScan(v, g.grantId, ok.pageId);
    expect(created.status).toBe(201);
    expect(json(created)).toEqual({ scanId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    const reused = await createScan(v, g.grantId, ok.pageId);
    expect(reused.status).toBe(404);
    expect(json(reused).error.code).toBe('not_found');
  });

  it('created scan is queued with jobId scan-<id>, its token re-sealed for the scan', async () => {
    const before = await metric('feedbouncer_scan_created_total');
    const v = await visitor();
    const g = await grant(v);
    const r = await createScan(v, g.grantId, g.pages[0]!.pageId);
    expect(r.status).toBe(201);
    const { scanId } = json(r);

    const job = await queue.getJob(`scan-${scanId}`);
    expect(job?.data).toEqual({ v: 1, scanId });
    expect(job?.opts.attempts).toBe(2);

    const { rows } = await api.pool.query(
      'SELECT status, page_external_id, page_name, encrypted_user_token FROM scan WHERE id = $1',
      [scanId],
    );
    expect(rows[0]).toMatchObject({
      status: 'queued',
      page_external_id: g.pages[0]!.pageId,
      page_name: 'Acme',
    });
    const token = await open(
      api.deps.env.encryption,
      rows[0].encrypted_user_token,
      scanTokenCtx(scanId),
    );
    expect(token.reveal()).toBe(USER_TOKEN);
    const grants = await api.pool.query('SELECT 1 FROM scan_grant WHERE id = $1', [g.grantId]);
    expect(grants.rowCount).toBe(0);
    expect(await metric('feedbouncer_scan_created_total')).toBe(before + 1);

    const view = await send('GET', `${BASE}/scans/${scanId}`, { cookie: v.cookie });
    expect(json(view)).toEqual({
      id: scanId,
      status: 'queued',
      failureReason: null,
      pageName: 'Acme',
      createdAt: expect.any(String),
      finishedAt: null,
      shared: false,
      result: null,
    });
  });

  it('4th scan by one visitor in a day → 429', async () => {
    const v = await visitor();
    for (let i = 0; i < 3; i++) await queuedScan(v);
    const g = await grant(v);
    const r = await createScan(v, g.grantId, g.pages[0]!.pageId);
    expect(r.status).toBe(429);
    expect(json(r).error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // The refused request keeps its grant.
    const left = await api.pool.query('SELECT 1 FROM scan_grant WHERE id = $1', [g.grantId]);
    expect(left.rowCount).toBe(1);
  });

  it('second active scan on the same page by another visitor → 409 scan_in_progress without scanId', async () => {
    const a = await visitor();
    const b = await visitor();
    const shared = page();
    const ga = await grant(a, [shared]);
    const first = await createScan(a, ga.grantId, shared.pageId);
    expect(first.status).toBe(201);
    const scanId = json(first).scanId as string;

    const gb = await grant(b, [shared]);
    const other = await createScan(b, gb.grantId, shared.pageId);
    expect(other.status).toBe(409);
    expect(json(other)).toEqual({
      error: { code: 'scan_in_progress', message: expect.any(String) },
    });
    expect(other.text).not.toContain(scanId);
    expect(other.text).not.toContain(a.id);

    const ga2 = await grant(a, [shared]);
    const own = await createScan(a, ga2.grantId, shared.pageId);
    expect(own.status).toBe(409);
    expect(json(own).error).toMatchObject({ code: 'scan_in_progress', scanId });
    // A busy page leaves the grants usable.
    const left = await api.pool.query(
      'SELECT count(*)::int AS n FROM scan_grant WHERE id = ANY($1)',
      [[gb.grantId, ga2.grantId]],
    );
    expect(left.rows[0].n).toBe(2);
  });

  const pagePoints = async (pid: string) =>
    Number(
      (await api.deps.redis.get(
        `${api.deps.redisKeyPrefix}rl:scan_create_page:${createHash('sha256').update(pid).digest('hex')}`,
      )) ?? 0,
    );

  it('busy page then a real scan still within limits (points refunded)', async () => {
    const a = await visitor();
    const b = await visitor();
    const p = page();
    const ga = await grant(a, [p]);
    const first = json(await createScan(a, ga.grantId, p.pageId)).scanId as string;
    // Without refunds these would spend B's 3 a day and the Page's 3 a day.
    for (let i = 0; i < 3; i++) {
      const g = await grant(b, [p]);
      expect((await createScan(b, g.grantId, p.pageId)).status).toBe(409);
    }
    expect(await pagePoints(p.pageId)).toBe(1);
    expect(await store.fail(first, null, 'internal', new Date())).toBe(true);
    const g = await grant(b, [p]);
    expect((await createScan(b, g.grantId, p.pageId)).status).toBe(201);
    expect(await pagePoints(p.pageId)).toBe(2);
  });

  it('concurrent double POST with the same grant leaves the page counter at 1 point used', async () => {
    const v = await visitor();
    const g = await grant(v);
    const pid = g.pages[0]!.pageId;
    const statuses = (
      await Promise.all([createScan(v, g.grantId, pid), createScan(v, g.grantId, pid)])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 404]);
    expect(await pagePoints(pid)).toBe(1);
  });

  it('unreadable grant → 404 and grant gone', async () => {
    const v = await visitor();
    const p = page();
    const id = randomUUID();
    await store.insertGrant({
      id,
      visitorId: v.id,
      fbUserHash: sha256('user-unreadable'),
      // Sealed for another grant, so it cannot be opened as this one's.
      token: await seal(api.deps.env.encryption, new Secret(USER_TOKEN), {
        organizationId: 'scan-tool',
        connectionId: randomUUID(),
        kind: 'scan_user_token',
      }),
      scopes: ALL_SCOPES,
      pages: [p],
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const r = await createScan(v, id, p.pageId);
    expect(r.status).toBe(404);
    expect(json(r).error.code).toBe('not_found');
    expect((await api.pool.query('SELECT 1 FROM scan_grant WHERE id = $1', [id])).rowCount).toBe(0);
    expect(await pagePoints(p.pageId)).toBe(0);
  });
});

describe('GET /scan/scans', () => {
  it('lists the visitor’s latest 10 scans, newest first', async () => {
    const v = await visitor();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const g = await grant(v);
      const scanId = randomUUID();
      const sealed = await seal(
        api.deps.env.encryption,
        new Secret(USER_TOKEN),
        scanTokenCtx(scanId),
      );
      expect(
        await store.createScanFromGrant({
          scanId,
          grantId: g.grantId,
          visitorId: v.id,
          page: g.pages[0]!,
          token: sealed,
          now: new Date(),
        }),
      ).toBe('created');
      await api.pool.query(
        'UPDATE scan SET created_at = now() - make_interval(mins => $2) WHERE id = $1',
        [scanId, 100 - i],
      );
      ids.push(scanId);
    }
    const r = await send('GET', `${BASE}/scans`, { cookie: v.cookie });
    expect(r.status).toBe(200);
    const scans = json(r).scans as { id: string }[];
    expect(scans.map((s) => s.id)).toEqual(ids.slice(1).reverse());
  });
});

describe('DELETE /scan/scans/:scanId', () => {
  it('deletes the scan; a running job then finds no row', async () => {
    const v = await visitor();
    const id = await queuedScan(v);
    const claimed = await store.claim(id, new Date());
    const r = await send('DELETE', `${BASE}/scans/${id}`, { cookie: v.cookie });
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    expect(await store.complete(id, claimed!.attempt, RESULT, new Date())).toBe(false);
    expect((await send('GET', `${BASE}/scans/${id}`, { cookie: v.cookie })).status).toBe(404);
    expect((await send('DELETE', `${BASE}/scans/${id}`, { cookie: v.cookie })).status).toBe(404);
  });
});

describe('sharing', () => {
  it('share → shared GET returns perAd labels null and masked authors; after DELETE share → 404; share on a failed scan → 409', async () => {
    const v = await visitor();
    const id = await completedScan(v);

    const own = await send('GET', `${BASE}/scans/${id}`, { cookie: v.cookie });
    expect(json(own)).toMatchObject({ status: 'completed', shared: false, result: RESULT });

    const put = await send('PUT', `${BASE}/scans/${id}/share`, { cookie: v.cookie });
    expect(put.status).toBe(200);
    expect(put.headers['cache-control']).toBe('no-store');
    const { shareUrl } = json(put);
    const m = new RegExp(`^${WEB}/scan/shared/([A-Za-z0-9_-]{43})$`).exec(shareUrl);
    expect(m, shareUrl).not.toBeNull();
    const token = m![1]!;
    const { rows } = await api.pool.query('SELECT share_token_hash FROM scan WHERE id = $1', [id]);
    expect(rows[0].share_token_hash).toEqual(sha256(token));

    const shared = await api.raw('GET', `${BASE}/shared/${token}`);
    expect(shared.status).toBe(200);
    expect(shared.headers['cache-control']).toBe('no-store');
    const body = json(shared);
    expect(Object.keys(body).sort()).toEqual(['finishedAt', 'pageName', 'result']);
    expect(body.pageName).toBe('Acme');
    expect(body.result.perAd.map((p: { label: unknown }) => p.label)).toEqual([null]);
    expect(body.result.examples.map((e: { authorLabel: string }) => e.authorLabel)).toEqual([
      'J. D.',
    ]);
    expect(shared.text).not.toContain('Spring sale');
    expect(shared.text).not.toContain(id);
    expect(shared.text).not.toContain(v.id);
    expect(json(await send('GET', `${BASE}/scans/${id}`, { cookie: v.cookie })).shared).toBe(true);

    // Sharing again replaces the link.
    const again = json(await send('PUT', `${BASE}/scans/${id}/share`, { cookie: v.cookie }));
    expect(again.shareUrl).not.toBe(shareUrl);
    expect((await api.raw('GET', `${BASE}/shared/${token}`)).status).toBe(404);
    const token2 = again.shareUrl.split('/').pop() as string;

    const del = await send('DELETE', `${BASE}/scans/${id}/share`, { cookie: v.cookie });
    expect(del.status).toBe(204);
    const gone = await api.raw('GET', `${BASE}/shared/${token2}`);
    expect(gone.status).toBe(404);
    expect(json(gone).error.code).toBe('not_found');
    for (const bad of ['short', `${token2}x`, `${token2.slice(0, 42)}.`]) {
      const r = await api.raw('GET', `${BASE}/shared/${encodeURIComponent(bad)}`);
      expect([r.status, r.text]).toEqual([404, gone.text]);
    }

    const failed = await queuedScan(v);
    expect(await store.fail(failed, null, 'rate_limited', new Date())).toBe(true);
    const queued = await queuedScan(v);
    for (const sid of [failed, queued]) {
      const r = await send('PUT', `${BASE}/scans/${sid}/share`, { cookie: v.cookie });
      expect(r.status).toBe(409);
      expect(json(r).error.code).toBe('scan_not_completed');
    }
    const f = json(await send('GET', `${BASE}/scans/${failed}`, { cookie: v.cookie }));
    expect(f).toMatchObject({ status: 'failed', failureReason: 'rate_limited', result: null });
  });

  it('PUT share refuses a body with unknown fields', async () => {
    const v = await visitor();
    const id = await completedScan(v);
    const r = await send('PUT', `${BASE}/scans/${id}/share`, { cookie: v.cookie, body: { x: 1 } });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /scan/me', () => {
  it('DELETE /scan/me → all rows gone (SELECT count on 4 tables = 0) and Set-Cookie Max-Age=0', async () => {
    const v = await visitor();
    const other = await visitor();
    await grant(v);
    await completedScan(v);
    await queuedScan(other);
    const auth = await send('POST', `${BASE}/authorize`, { cookie: v.cookie, body: {} });
    expect(auth.status).toBe(200);

    const counts = async (id: string) =>
      (
        await api.pool.query(
          `SELECT (SELECT count(*) FROM scan_visitor WHERE id = $1)::int AS visitors,
                  (SELECT count(*) FROM scan_oauth_state WHERE visitor_id = $1)::int AS states,
                  (SELECT count(*) FROM scan_grant WHERE visitor_id = $1)::int AS grants,
                  (SELECT count(*) FROM scan WHERE visitor_id = $1)::int AS scans`,
          [id],
        )
      ).rows[0];
    expect(await counts(v.id)).toEqual({ visitors: 1, states: 1, grants: 1, scans: 1 });

    const r = await send('DELETE', `${BASE}/me`, { cookie: v.cookie });
    expect(r.status).toBe(204);
    expect(String(r.headers['set-cookie'])).toMatch(/^fb_scan_visitor=; Path=\/; Max-Age=0; /);
    expect(await counts(v.id)).toEqual({ visitors: 0, states: 0, grants: 0, scans: 0 });
    expect(await counts(other.id)).toEqual({ visitors: 1, states: 0, grants: 0, scans: 1 });
    expect((await send('GET', `${BASE}/scans`, { cookie: v.cookie })).status).toBe(404);
  });
});

describe('stored result', () => {
  it('stored result that fails ScanResultV1 → 500 internal_error, body leaks no stored content', async () => {
    const v = await visitor();
    const id = await completedScan(v);
    const MARKER = 'stored-secret-marker-7731';
    await api.pool.query('UPDATE scan SET result = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify({ ...RESULT, examples: [{ text: MARKER }] }),
    ]);
    const share = json(await send('PUT', `${BASE}/scans/${id}/share`, { cookie: v.cookie }));
    const token = share.shareUrl.split('/').pop() as string;

    for (const r of [
      await send('GET', `${BASE}/scans/${id}`, { cookie: v.cookie }),
      await send('GET', `${BASE}/scans`, { cookie: v.cookie }),
      await api.raw('GET', `${BASE}/shared/${token}`),
    ]) {
      expect(r.status).toBe(500);
      expect(json(r)).toEqual({
        error: { code: 'internal_error', message: 'Something went wrong.' },
      });
      expect(r.text).not.toContain(MARKER);
    }
    for (const line of api.logLines) expect(line).not.toContain(MARKER);
  });
});

describe('GET /scan/cta', () => {
  it('cta → 303 to exactly /sign-up?from=scan', async () => {
    const before = await metric('feedbouncer_scan_cta_clicks_total');
    const r = await api.raw('GET', `${BASE}/cta?next=https://evil.example&from=x`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(`${WEB}/sign-up?from=scan`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await metric('feedbouncer_scan_cta_clicks_total')).toBe(before + 1);
  });

  it('counts authorizations', async () => {
    const before = await metric('feedbouncer_scan_authorize_total');
    expect((await send('POST', `${BASE}/authorize`, { body: {} })).status).toBe(200);
    expect(await metric('feedbouncer_scan_authorize_total')).toBe(before + 1);
  });
});

describe('secrets', () => {
  it('no log line carries the user token, a share token or a visitor cookie', () => {
    for (const line of api.logLines) {
      expect(line).not.toContain(USER_TOKEN);
      expect(line).not.toMatch(/fb_scan_visitor=/);
      expect(line).not.toMatch(/\/scan\/shared\/[A-Za-z0-9_-]{43}/);
    }
  });
});
