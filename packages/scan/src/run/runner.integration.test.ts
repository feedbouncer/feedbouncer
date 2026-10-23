import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ProviderError, type PreparedInput } from '@feedbouncer/ai';
import {
  CATEGORIES,
  type ClassifierProvider,
  type RawClassification,
} from '@feedbouncer/classifier';
import { createSafeHttp, memoryBudget } from '@feedbouncer/connectors';
import { GRAPH_HOST, createFacebookConnector } from '@feedbouncer/connector-facebook';
import { FakeGraph, testConfig } from '@feedbouncer/connector-facebook/testing';
import { createPool } from '@feedbouncer/db';
import { migratedDb } from '@feedbouncer/db/testing';
import { seal } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, type Logger } from '@feedbouncer/service-runtime';
import { ScanResultV1 } from '../contract.js';
import type { ScanGraph } from '../graph/pages.js';
import { SCAN_OPTIONAL_SCOPES, SCAN_REQUIRED_SCOPES } from '../scopes.js';
import { PgScanStore } from '../pg/store.js';
import type { ScanSettings } from '../config.js';
import { runScanMaintenance } from './maintenance.js';
import { runScan, type ScanMetrics, type ScanRunnerDeps } from './runner.js';
import { scanTokenCtx } from './transport.js';

const APP_SECRET = 's'.repeat(32);
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const keys = testKeyring();
const SETTINGS: ScanSettings = {
  enabled: true,
  maxComments: 2000,
  retentionDays: 30,
  workerConcurrency: 2,
};

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgScanStore;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'scan-runner-test', onIdleError: () => {} });
  store = new PgScanStore(pool);
});
beforeEach(async () => {
  await pool.query('DELETE FROM scan');
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

const zero = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as RawClassification['scores'];

/** Scores by keyword: "scam" is phishing, "spam" is spam, "maybe" is uncertain; "hola" is Spanish. */
function scripted(): ClassifierProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'scripted',
    model: 'scripted',
    calls,
    async classify(input: PreparedInput) {
      calls.push(input.text);
      const t = input.text.toLowerCase();
      const scores = { ...zero };
      if (t.includes('scam')) scores.scam_phishing = 0.95;
      else if (t.includes('spam')) scores.spam = 0.9;
      else if (t.includes('maybe')) scores.spam = 0.6;
      return { scores, language: t.includes('hola') ? 'es' : 'en' };
    },
  };
}

type Fault = { suffix: string; after: number; res: () => Response };
type Rewrite = { suffix: string; fn: (body: { data: unknown[] }) => unknown };

const graphError =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify({ error: { message: 'x', type: 'GraphError', code } }), {
      status: 400,
      headers: { 'content-type': 'application/json', ...headers },
    });

async function userTokenFor(graph: FakeGraph, userId: string, decline: string[] = []) {
  const verifier = 'v'.repeat(48);
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('state', 'st');
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('redirect_uri', 'https://app.test/cb');
  url.searchParams.set('scope', [...SCAN_REQUIRED_SCOPES, ...SCAN_OPTIONAL_SCOPES].join(','));
  const { code } = graph.consent(url, userId, { decline });
  const exchange = async (form: Record<string, string>) => {
    const res = await graph.fetch('https://graph.facebook.com/v26.0/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '123456',
        client_secret: APP_SECRET,
        ...form,
      }).toString(),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  };
  const short = await exchange({
    code,
    redirect_uri: 'https://app.test/cb',
    code_verifier: verifier,
  });
  return exchange({ grant_type: 'fb_exchange_token', fb_exchange_token: short });
}

async function world(o: { tasks?: string[]; decline?: string[] } = {}) {
  let now = NOW;
  const graph = new FakeGraph({ appSecret: APP_SECRET, appId: '123456', clock: () => now });
  const faults: Fault[] = [];
  const rewrites: Rewrite[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const i = faults.findIndex((f) => path.endsWith(f.suffix) && f.after-- === 0);
    if (i >= 0) return faults.splice(i, 1)[0]!.res();
    const res = await graph.fetch(input, init);
    const rw = rewrites.find((r) => path.endsWith(r.suffix));
    if (!rw || res.status !== 200) return res;
    const body = rw.fn((await res.json()) as { data: unknown[] });
    return new Response(JSON.stringify(body), { status: 200, headers: res.headers });
  };
  const fb = testConfig(graph);
  const g: ScanGraph = {
    fb,
    ig: { meta: fb },
    meta: { meta: fb, activeStatuses: ['ACTIVE'] },
    http: createSafeHttp({ allowedHosts: [GRAPH_HOST], fetch }),
    nowMs: () => now,
  };
  const { userId } = graph.addUser();
  const userToken = await userTokenFor(graph, userId, o.decline);
  const { pageId } = graph.addPage(userId, { tasks: o.tasks ?? ['MODERATE'], name: 'Acme' });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'acme' });
  const { adAccountId } = graph.addAdAccount(userId);
  const baseline = graph.calls().length;

  /** One ad on a new dark post, with `n` comments built by `make`. */
  const adPost = (
    n: number,
    make: (i: number) => { message?: string; authorName?: string } = () => ({}),
  ) => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId, name: `ad ${postId}` });
    const ids = Array.from(
      { length: n },
      (_, i) =>
        graph.addComment(pageId, { postId, createdAtMs: NOW - (i + 1) * 1000, ...make(i) })
          .commentId,
    );
    return { postId, ids };
  };

  const classifier = scripted();
  const slept: number[] = [];
  const lines: string[] = [];
  const finished: Parameters<ScanMetrics['finished']>[0][] = [];
  const push = (level: string) => (msg: string, f?: object) =>
    void lines.push(JSON.stringify({ level, msg, ...f }));
  const log: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  const deps: ScanRunnerDeps = {
    store,
    keys,
    graph: g,
    classifier,
    languages: ['en'],
    budget: memoryBudget(),
    facebookRatePolicy: createFacebookConnector(fb).capabilities.rateLimit,
    settings: SETTINGS,
    nowMs: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    log,
    metrics: { finished: (m) => void finished.push(m) },
  };

  /** Queues a scan of this world's Page, or of another Page id when one is given. */
  async function queueScan(forPage = pageId): Promise<string> {
    const visitorId = await store.createVisitor(randomBytes(32));
    const grantId = randomUUID();
    const scanId = randomUUID();
    const page = {
      pageId: forPage,
      name: 'Acme',
      igUserId,
      igUsername: 'acme',
      eligible: true,
      ineligibleReason: null,
    };
    await store.insertGrant({
      id: grantId,
      visitorId,
      fbUserHash: randomBytes(32),
      token: { keyId: 'k', blob: randomBytes(16) },
      scopes: [],
      pages: [page],
      expiresAt: new Date(NOW + 60_000),
    });
    const token = await seal(keys, new Secret(userToken), scanTokenCtx(scanId));
    expect(
      await store.createScanFromGrant({
        scanId,
        grantId,
        visitorId,
        page,
        token,
        now: new Date(NOW),
      }),
    ).toBe('created');
    return scanId;
  }

  return {
    graph,
    deps,
    classifier,
    slept,
    lines,
    finished,
    pageId,
    igUserId,
    adAccountId,
    adPost,
    queueScan,
    fault: (suffix: string, res: () => Response, after = 0) =>
      void faults.push({ suffix, after, res }),
    rewrite: (suffix: string, fn: Rewrite['fn']) => void rewrites.push({ suffix, fn }),
    requests: () => graph.calls().slice(baseline),
  };
}

async function row(scanId: string) {
  const { rows } = await pool.query<{
    status: string;
    failure_reason: string | null;
    result: unknown;
    encrypted_user_token: Buffer | null;
    key_id: string | null;
  }>(
    'SELECT status, failure_reason, result, encrypted_user_token, key_id FROM scan WHERE id = $1',
    [scanId],
  );
  return rows[0];
}

async function completed(scanId: string): Promise<ScanResultV1> {
  const r = await row(scanId);
  expect(r).toMatchObject({ status: 'completed', encrypted_user_token: null, key_id: null });
  return ScanResultV1.parse(r!.result);
}

async function failedWith(scanId: string, reason: string) {
  expect(await row(scanId)).toMatchObject({
    status: 'failed',
    failure_reason: reason,
    result: null,
    encrypted_user_token: null,
    key_id: null,
  });
}

describe('runScan', () => {
  it('happy path: 2 ad posts, 30 comments incl. 2 hidden and 1 reply → completed, totals match, token null, no non-GET request recorded', async () => {
    const w = await world();
    const a = w.adPost(18, (i) => ({
      message: i < 4 ? `free scam prize ${i}` : i < 6 ? `buy spam ${i}` : `lovely ${i}`,
      authorName: i < 4 ? 'Zelda Quixote' : 'Marta Ortega',
    }));
    const b = w.adPost(11, (i) => ({ message: i === 0 ? 'maybe a deal' : `nice ad ${i}` }));
    w.graph.addComment(w.pageId, { postId: b.postId, parentId: b.ids[1]!, message: 'thanks!' });
    w.graph.hideComment(a.ids[16]!);
    w.graph.hideComment(b.ids[10]!);
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });

    const result = await completed(scanId);
    expect(result.totals).toEqual({
      adsCovered: 2,
      postsScanned: 2,
      commentsScanned: 28,
      scamSpam: 6,
      uncertain: 1,
      clean: 21,
      unclassified: 0,
      hiddenExcluded: 2,
      repeatedComments: 0,
    });
    expect(result.sharePct).toBe(21.4);
    expect(result.reliable).toBe(true);
    expect(result.examples.filter((e) => e.category === 'scam_phishing')).toHaveLength(3);
    expect(result.examples.find((e) => e.category === 'scam_phishing')).toMatchObject({
      authorLabel: 'Z. Q.',
      reason: expect.stringContaining('Classifier'),
    });
    expect(w.requests().every((c) => c.method === 'GET')).toBe(true);
    expect(w.finished).toEqual([
      expect.objectContaining({ status: 'completed', reason: null, commentsScanned: 28 }),
    ]);
  });

  it('stores masked author labels only and logs no comment text, name or token', async () => {
    const w = await world();
    w.adPost(25, (i) => ({
      message: i < 5 ? `claim your scam reward ${i}` : `great ${i}`,
      authorName: i < 5 ? 'Acme Support Desk' : 'Bartholomew Pennywhistle',
    }));
    const scanId = await w.queueScan();
    await runScan(w.deps, scanId);

    const json = JSON.stringify((await row(scanId))!.result);
    for (const raw of ['Acme Support', 'Support Desk', 'Bartholomew', 'Pennywhistle']) {
      expect(json).not.toContain(raw);
    }
    const result = await completed(scanId);
    expect(result.examples[0]).toMatchObject({ authorLabel: 'A. S.' });
    expect(result.breakdown[0]!.tags.impersonation).toBe(5);
    const logs = w.lines.join('\n');
    for (const raw of [
      'scam reward',
      'great',
      'Bartholomew',
      'Acme Support',
      ...w.graph.issuedSecrets(),
    ]) {
      expect(logs).not.toContain(raw);
    }
  });

  it('Graph 190 on the second comments page → failed access_revoked, result null, token null', async () => {
    const w = await world();
    const { postId } = w.adPost(150);
    w.fault(`${postId}/comments`, graphError(190), 1);
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'failed', reason: 'access_revoked' });
    await failedWith(scanId, 'access_revoked');
    expect(w.classifier.calls).toEqual([]);
  });

  it('a lost page permission mid-fetch → failed missing_permissions', async () => {
    const w = await world();
    const { postId } = w.adPost(30);
    w.fault(`${postId}/comments`, graphError(200));
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({
      status: 'failed',
      reason: 'missing_permissions',
    });
    await failedWith(scanId, 'missing_permissions');
  });

  it('same comment id on two pages and an IG reply returned inline and via replies → counted once; identical text from 4 ids → repeatedComments 4', async () => {
    const w = await world();
    const a = w.adPost(10, (i) => ({
      message: i < 4 ? 'Free scam crypto at x.example' : `ok ${i}`,
    }));
    const b = w.adPost(10, (i) => ({ message: `fine ${i}` }));
    const again = {
      id: a.ids[0],
      message: 'Free scam crypto at x.example',
      created_time: new Date(NOW - 1000).toISOString(),
      from: { id: '42' },
      is_hidden: false,
    };
    w.rewrite(`${b.postId}/comments`, (body) => ({ ...body, data: [again, ...body.data] }));

    const top = w.graph.addIgComment(w.igUserId, { text: 'love it' });
    w.graph.addIgComment(w.igUserId, {
      mediaId: top.mediaId,
      parentId: top.commentId,
      text: 'same',
    });
    for (let i = 0; i < 2; i++)
      w.graph.addIgComment(w.igUserId, { mediaId: top.mediaId, text: `ig ${i}` });
    const story = w.graph.addDarkPost(w.pageId).postId;
    w.graph.addAd(w.adAccountId, { storyId: story, igMediaId: top.mediaId, igUserId: w.igUserId });
    w.rewrite(`${top.mediaId}/comments`, (body) => {
      const withReplies = body.data.find(
        (c) => (c as { replies?: { data: unknown[] } }).replies?.data.length,
      ) as { replies: { data: unknown[] } };
      return { ...body, data: [...body.data, ...withReplies.replies.data] };
    });
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result.totals.commentsScanned).toBe(10 + 10 + 4);
    expect(result.totals.repeatedComments).toBe(4);
    expect(result.examples[0]).toMatchObject({ repeatCount: 4 });
    expect(w.classifier.calls.filter((t) => t.includes('Free scam'))).toHaveLength(1);
    expect(result.notices).not.toContain('instagram_not_included');
  });

  it('613 with retryAfterMs 60_000 after 25 comments → completed with partial_rate_limited', async () => {
    const w = await world();
    w.adPost(25);
    const second = w.adPost(10);
    w.fault(`${second.postId}/comments`, graphError(613, { 'retry-after': '60' }));
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result.totals.commentsScanned).toBe(25);
    expect(result.notices).toContain('partial_rate_limited');
    expect(w.slept).toEqual([]);
  });

  it('613 with retryAfterMs 60_000 after 5 comments → failed rate_limited', async () => {
    const w = await world();
    w.adPost(5);
    const second = w.adPost(10);
    w.fault(`${second.postId}/comments`, graphError(613, { 'retry-after': '60' }));
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'failed', reason: 'rate_limited' });
    await failedWith(scanId, 'rate_limited');
  });

  it('a short throttle is waited out and retried, at most 3 times per scan', async () => {
    const w = await world();
    const { postId } = w.adPost(30);
    for (let i = 0; i < 3; i++)
      w.fault(`${postId}/comments`, graphError(613, { 'retry-after': '5' }));
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    expect(w.slept).toEqual([5000, 5000, 5000]);
    expect((await completed(scanId)).notices).not.toContain('partial_rate_limited');

    const v = await world();
    const p = v.adPost(30);
    for (let i = 0; i < 4; i++)
      v.fault(`${p.postId}/comments`, graphError(613, { 'retry-after': '5' }));
    const again = await v.queueScan();
    expect(await runScan(v.deps, again)).toEqual({ status: 'failed', reason: 'rate_limited' });
    expect(v.slept).toHaveLength(3);
  });

  it('a platform outage after enough comments → completed with partial_platform_unavailable', async () => {
    const w = await world();
    w.adPost(25);
    const second = w.adPost(10);
    w.fault(`${second.postId}/comments`, () => new Response('oops', { status: 503 }));
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    expect((await completed(scanId)).notices).toContain('partial_platform_unavailable');
  });

  it('comment cap: settings.maxComments 100 across 3 posts of 80 → 100 scanned, sampled_comment_cap', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) w.adPost(80);
    const scanId = await w.queueScan();
    const deps = { ...w.deps, settings: { ...SETTINGS, maxComments: 100 } };

    expect(await runScan(deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result.totals.commentsScanned).toBe(100);
    expect(result.limits.maxComments).toBe(100);
    expect(result.notices).toContain('sampled_comment_cap');
  });

  it('classifier always throws unavailable → failed classifier_unavailable', async () => {
    const w = await world();
    w.adPost(30, (i) => ({ message: `text number ${i}` }));
    const scanId = await w.queueScan();
    let calls = 0;
    const deps = {
      ...w.deps,
      classifier: {
        id: 'x',
        model: 'x',
        classify: async () => {
          calls++;
          throw new ProviderError('unavailable', true);
        },
      },
    };

    expect(await runScan(deps, scanId)).toEqual({
      status: 'failed',
      reason: 'classifier_unavailable',
    });
    await failedWith(scanId, 'classifier_unavailable');
    expect(calls).toBe(60);
    expect(w.slept.every((ms) => ms === 250)).toBe(true);
  });

  it('emoji-only and unsupported-language comments → unclassified, excluded from sharePct', async () => {
    const w = await world();
    w.adPost(25, (i) => ({
      message:
        i < 10
          ? `scam link ${i}`
          : i < 20
            ? `really good ${i}`
            : i < 23
              ? '🔥🔥🔥'
              : `hola amigos ${i}`,
    }));
    const scanId = await w.queueScan();

    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result.totals).toMatchObject({ scamSpam: 10, clean: 10, unclassified: 5 });
    expect(result.sharePct).toBe(50);
    expect(w.classifier.calls.some((t) => t.includes('🔥'))).toBe(false);
  });

  it('no recent ads → completed, result.empty true, sharePct null', async () => {
    const w = await world();
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result).toMatchObject({ empty: true, sharePct: null, reliable: false });
    expect(result.totals.postsScanned).toBe(0);
  });

  it('declined instagram scopes → instagram placements skipped with instagram_not_included', async () => {
    const w = await world({ decline: [...SCAN_OPTIONAL_SCOPES] });
    const top = w.graph.addIgComment(w.igUserId, { text: 'hi' });
    const story = w.graph.addDarkPost(w.pageId).postId;
    w.graph.addAd(w.adAccountId, { storyId: story, igMediaId: top.mediaId, igUserId: w.igUserId });
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const result = await completed(scanId);
    expect(result.notices).toContain('instagram_not_included');
    expect(result.perAd.map((p) => p.platform)).toEqual(['facebook']);
  });

  it('page without MODERATE → failed insufficient_page_role', async () => {
    const w = await world({ tasks: ['ANALYZE'] });
    w.adPost(30);
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({
      status: 'failed',
      reason: 'insufficient_page_role',
    });
    await failedWith(scanId, 'insufficient_page_role');
  });

  it('runScan twice for the same id → second returns skipped, one result written', async () => {
    const w = await world();
    w.adPost(30);
    const scanId = await w.queueScan();
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'completed' });
    const first = (await row(scanId))!.result;
    expect(await runScan(w.deps, scanId)).toEqual({ status: 'skipped' });
    expect((await row(scanId))!.result).toEqual(first);
    expect(w.finished).toHaveLength(1);
  });

  it('scan deleted by the visitor mid-run → complete returns false, no row resurrected', async () => {
    const w = await world();
    w.adPost(30);
    const scanId = await w.queueScan();
    const inner = w.deps.classifier;
    const deps = {
      ...w.deps,
      classifier: {
        ...inner,
        classify: async (input: PreparedInput, signal: AbortSignal) => {
          await pool.query('DELETE FROM scan WHERE id = $1', [scanId]);
          return inner.classify(input, signal);
        },
      },
    };

    expect(await runScan(deps, scanId)).toEqual({ status: 'skipped' });
    expect(await row(scanId)).toBeUndefined();
  });

  it('an unexpected error → failed internal with the token cleared', async () => {
    const w = await world();
    w.adPost(30);
    const scanId = await w.queueScan();
    const deps = { ...w.deps, languages: null as unknown as string[] };
    expect(await runScan(deps, scanId)).toEqual({ status: 'failed', reason: 'internal' });
    await failedWith(scanId, 'internal');
  });
});

describe('runScanMaintenance', () => {
  const otherPage = () => String(1e11 + Math.floor(Math.random() * 1e11));

  it('maintenance marks a running scan older than 10 min failed timeout and purges a 31-day-old scan', async () => {
    const w = await world();
    const stale = await w.queueScan(otherPage());
    await store.claim(stale, new Date(NOW - 11 * 60_000));
    const old = await w.queueScan(otherPage());
    await pool.query('UPDATE scan SET created_at = $2 WHERE id = $1', [
      old,
      new Date(NOW - 31 * DAY),
    ]);
    const queued = await w.queueScan(otherPage());
    await pool.query('UPDATE scan SET created_at = $2 WHERE id = $1', [
      queued,
      new Date(NOW - 5 * 60_000),
    ]);
    const added: unknown[] = [];
    const queue = { add: async (...args: unknown[]) => void added.push(args) };

    await runScanMaintenance({
      pool,
      store,
      queue,
      settings: SETTINGS,
      now: () => new Date(NOW),
      log: w.deps.log,
    });

    await failedWith(stale, 'timeout');
    expect(await row(old)).toBeUndefined();
    expect(added).toContainEqual([
      'scan',
      { v: 1, scanId: queued },
      expect.objectContaining({ jobId: `scan-${queued}` }),
    ]);
  });

  it('skips the run while another process holds the maintenance lock', async () => {
    const w = await world();
    const stale = await w.queueScan();
    await store.claim(stale, new Date(NOW - 11 * 60_000));
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('fb.scan_maintenance'))");
      await runScanMaintenance({
        pool,
        store,
        queue: { add: async () => undefined },
        settings: SETTINGS,
        now: () => new Date(NOW),
        log: w.deps.log,
      });
      expect((await row(stale))!.status).toBe('running');
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('fb.scan_maintenance'))");
      holder.release();
    }
  });
});
