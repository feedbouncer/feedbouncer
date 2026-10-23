import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb } from '@feedbouncer/db/testing';
import type { ScanPageOption, ScanResultV1 } from '../contract.js';
import { PgScanStore, type Sealed } from './store.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgScanStore;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'scan-store-test', onIdleError: () => {} });
  store = new PgScanStore(pool);
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const NOW = new Date('2026-10-23T12:00:00.000Z');
const DAY = 86_400_000;
const sealed = (): Sealed => ({ keyId: 'k1', blob: randomBytes(48) });
const hash = () => randomBytes(32);
const pageId = () => String(Math.floor(Math.random() * 1e12) + 1e11);
const page = (): ScanPageOption => ({
  pageId: pageId(),
  name: 'Acme',
  igUserId: null,
  igUsername: null,
  eligible: true,
  ineligibleReason: null,
});
const RESULT = { v: 1, totals: { commentsScanned: 3 } } as unknown as ScanResultV1;

async function queuedScan(visitorId?: string, p = page()) {
  const vid = visitorId ?? (await store.createVisitor(hash()));
  const grantId = randomUUID();
  await store.insertGrant({
    id: grantId,
    visitorId: vid,
    fbUserHash: hash(),
    token: sealed(),
    scopes: ['pages_read_engagement'],
    pages: [p],
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const scanId = randomUUID();
  const outcome = await store.createScanFromGrant({
    scanId,
    grantId,
    visitorId: vid,
    page: p,
    token: sealed(),
    now: NOW,
  });
  expect(outcome).toBe('created');
  return { scanId, visitorId: vid, page: p };
}

const count = async (sql: string, args: unknown[] = []) =>
  Number((await pool.query<{ n: string }>(sql, args)).rows[0]!.n);

describe('PgScanStore', () => {
  it('touches a visitor by token hash', async () => {
    const h = hash();
    const id = await store.createVisitor(h);
    expect(await store.touchVisitor(h, NOW)).toBe(id);
    expect(await store.touchVisitor(hash(), NOW)).toBeNull();
  });

  it('consumeOAuthState is single-use and visitor-bound', async () => {
    const a = await store.createVisitor(hash());
    const b = await store.createVisitor(hash());
    const stateHash = hash();
    const verifier = sealed();
    await store.insertOAuthState({
      stateHash,
      visitorId: a,
      verifier,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(await store.consumeOAuthState(stateHash, b, NOW)).toBeNull();
    expect(await store.consumeOAuthState(stateHash, a, NOW)).toEqual(verifier);
    expect(await store.consumeOAuthState(stateHash, a, NOW)).toBeNull();
  });

  it('does not consume an expired OAuth state', async () => {
    const a = await store.createVisitor(hash());
    const stateHash = hash();
    await store.insertOAuthState({
      stateHash,
      visitorId: a,
      verifier: sealed(),
      expiresAt: new Date(NOW.getTime() - 1),
    });
    expect(await store.consumeOAuthState(stateHash, a, NOW)).toBeNull();
  });

  it('createScanFromGrant consumes the grant once', async () => {
    const { scanId, visitorId, page: p } = await queuedScan();
    const grantId = randomUUID();
    await store.insertGrant({
      id: grantId,
      visitorId,
      fbUserHash: hash(),
      token: sealed(),
      scopes: [],
      pages: [p],
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect((await store.grantForVisitor(grantId, visitorId, NOW))?.pages).toEqual([p]);
    await store.fail(scanId, null, 'internal', NOW);
    const input = { grantId, visitorId, page: p, token: sealed(), now: NOW };
    expect(await store.createScanFromGrant({ ...input, scanId: randomUUID() })).toBe('created');
    expect(await store.grantForVisitor(grantId, visitorId, NOW)).toBeNull();
    expect(await store.createScanFromGrant({ ...input, scanId: randomUUID() })).toBe('grant_gone');
  });

  it('second active scan for the same page returns page_busy and keeps the grant', async () => {
    const { visitorId, page: p } = await queuedScan();
    const other = await store.createVisitor(hash());
    const grantId = randomUUID();
    await store.insertGrant({
      id: grantId,
      visitorId: other,
      fbUserHash: hash(),
      token: sealed(),
      scopes: [],
      pages: [p],
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const outcome = await store.createScanFromGrant({
      scanId: randomUUID(),
      grantId,
      visitorId: other,
      page: p,
      token: sealed(),
      now: NOW,
    });
    expect(outcome).toBe('page_busy');
    expect((await store.grantForVisitor(grantId, other, NOW))?.id).toBe(grantId);
    expect((await store.activeScanForPage(p.pageId))?.visitorId).toBe(visitorId);
  });

  it('complete clears the token and rejects a stale attempt', async () => {
    const { scanId, visitorId } = await queuedScan();
    expect((await store.claim(scanId, NOW))?.attempt).toBe(1);
    expect((await store.claim(scanId, NOW))?.attempt).toBe(2);
    expect(await store.complete(scanId, 1, RESULT, NOW)).toBe(false);
    expect(await store.complete(scanId, 2, RESULT, NOW)).toBe(true);
    const { rows } = await pool.query(
      'SELECT encrypted_user_token, key_id FROM scan WHERE id = $1',
      [scanId],
    );
    expect(rows[0]).toEqual({ encrypted_user_token: null, key_id: null });
    const row = await store.scanForVisitor(scanId, visitorId);
    expect(row).toMatchObject({ status: 'completed', result: RESULT, shared: false });
    expect(await store.claim(scanId, NOW)).toBeNull();
  });

  it('fail clears the token and result', async () => {
    const { scanId, visitorId } = await queuedScan();
    await store.claim(scanId, NOW);
    expect(await store.fail(scanId, 1, 'timeout', NOW)).toBe(true);
    expect(await store.fail(scanId, 1, 'timeout', NOW)).toBe(false);
    expect(await store.scanForVisitor(scanId, visitorId)).toMatchObject({
      status: 'failed',
      failureReason: 'timeout',
      result: null,
    });
  });

  it('terminal status with a token violates the CHECK', async () => {
    const { scanId } = await queuedScan();
    await expect(
      pool.query("UPDATE scan SET status = 'failed' WHERE id = $1", [scanId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('scanForVisitor / setShare / deleteScan return nothing for another visitor', async () => {
    const { scanId, visitorId } = await queuedScan();
    const stranger = await store.createVisitor(hash());
    expect(await store.scanForVisitor(scanId, stranger)).toBeNull();
    expect(await store.setShare(scanId, stranger, hash())).toBe('not_found');
    expect(await store.deleteScan(scanId, stranger)).toBe(false);
    expect(await store.setShare(scanId, visitorId, hash())).toBe('not_completed');
  });

  it('shares a completed scan by token hash and unshares it', async () => {
    const { scanId, visitorId } = await queuedScan();
    await store.claim(scanId, NOW);
    await store.complete(scanId, 1, RESULT, NOW);
    const h = hash();
    expect(await store.setShare(scanId, visitorId, h)).toBe('ok');
    expect(await store.sharedByTokenHash(h)).toEqual({
      pageName: 'Acme',
      finishedAt: NOW,
      result: RESULT,
    });
    expect((await store.scanForVisitor(scanId, visitorId))?.shared).toBe(true);
    expect(await store.setShare(scanId, visitorId, null)).toBe('ok');
    expect(await store.sharedByTokenHash(h)).toBeNull();
    expect(await store.deleteScan(scanId, visitorId)).toBe(true);
  });

  it('lists a visitor scans newest first', async () => {
    const vid = await store.createVisitor(hash());
    const first = await queuedScan(vid);
    const second = await queuedScan(vid);
    const rows = await store.listForVisitor(vid, 10);
    expect(rows.map((r) => r.id)).toEqual([second.scanId, first.scanId]);
    expect(await store.listForVisitor(vid, 1)).toHaveLength(1);
  });

  it('purge removes scans older than retentionDays and cascades nothing else', async () => {
    const vid = await store.createVisitor(hash());
    const old = await queuedScan(vid);
    const fresh = await queuedScan(vid);
    for (const s of [old, fresh]) {
      await store.claim(s.scanId, NOW);
      await store.complete(s.scanId, 1, RESULT, NOW);
    }
    await pool.query('UPDATE scan SET created_at = $2 WHERE id = $1', [
      old.scanId,
      new Date(NOW.getTime() - 31 * DAY),
    ]);
    await pool.query('UPDATE scan SET created_at = $2 WHERE id = $1', [
      fresh.scanId,
      new Date(NOW.getTime() - DAY),
    ]);
    const purged = await store.purge(NOW, 30);
    expect(purged.scans).toBe(1);
    expect(await store.scanForVisitor(old.scanId, vid)).toBeNull();
    expect(await store.scanForVisitor(fresh.scanId, vid)).not.toBeNull();
  });

  it('purge removes expired states and idle visitors without scans', async () => {
    const idle = hash();
    const idleId = await store.createVisitor(idle);
    await store.touchVisitor(idle, new Date(NOW.getTime() - 40 * DAY));
    await store.insertOAuthState({
      stateHash: hash(),
      visitorId: idleId,
      verifier: sealed(),
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const purged = await store.purge(NOW, 30);
    expect(purged.states).toBeGreaterThanOrEqual(1);
    expect(purged.visitors).toBeGreaterThanOrEqual(1);
    expect(await store.touchVisitor(idle, NOW)).toBeNull();
  });

  it('failStale fails long-running scans and queuedOlderThan lists old queued ones', async () => {
    const running = await queuedScan();
    const waiting = await queuedScan();
    await store.claim(running.scanId, new Date(NOW.getTime() - 700_000));
    expect(await store.failStale(NOW, 600_000)).toBeGreaterThanOrEqual(1);
    expect(await store.scanForVisitor(running.scanId, running.visitorId)).toMatchObject({
      status: 'failed',
      failureReason: 'timeout',
    });
    await pool.query('UPDATE scan SET created_at = $2 WHERE id = $1', [waiting.scanId, NOW]);
    const later = new Date(NOW.getTime() + 120_000);
    expect(await store.queuedOlderThan(later, 60_000)).toContain(waiting.scanId);
    expect(await store.queuedOlderThan(NOW, 60_000)).not.toContain(waiting.scanId);
  });

  it('deleteVisitor cascades to states, grants and scans', async () => {
    const { scanId, visitorId } = await queuedScan();
    await store.insertOAuthState({
      stateHash: hash(),
      visitorId,
      verifier: sealed(),
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await store.deleteVisitor(visitorId);
    for (const t of ['scan_oauth_state', 'scan_grant', 'scan', 'scan_visitor']) {
      const col = t === 'scan_visitor' ? 'id' : 'visitor_id';
      expect(await count(`SELECT count(*) AS n FROM ${t} WHERE ${col} = $1`, [visitorId]), t).toBe(
        0,
      );
    }
    expect(scanId).toBeDefined();
  });
});
