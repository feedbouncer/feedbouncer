// PgConnectionDirectory.activate and the review-mode window it stamps.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgConnectionDirectory } from './directory.js';

const HOURS_168_MS = 168 * 3_600_000;

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let dir: PgConnectionDirectory;
let n = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'connectors-dir-test', onIdleError: () => {} });
  t = await seedTenant(h.c, 'dir');
  dir = new PgConnectionDirectory(pool);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const pending = async (): Promise<ConnectionScope> =>
  (
    await dir.upsertPending({
      organizationId: t.organizationId,
      brandId: t.brandId,
      platform: 'facebook',
      externalAccountId: `rm-page-${++n}`,
      displayName: 'Page',
      grantedScopes: ['read'],
    })
  ).scope;

const columns = async (id: string) =>
  (
    await h.c.query<{
      review_mode: string;
      review_mode_started_at: Date | null;
      review_mode_ends_at: Date | null;
    }>(
      'SELECT review_mode, review_mode_started_at, review_mode_ends_at FROM connection WHERE id = $1',
      [id],
    )
  ).rows[0]!;

const audits = async (id: string, action: string) =>
  (
    await h.c.query(
      `SELECT actor_user_id, subject_type, details FROM audit_event
        WHERE subject_id = $1 AND action = $2`,
      [id, action],
    )
  ).rows;

describe('PgConnectionDirectory.activate review mode', () => {
  it('first activation stamps a 168h window', async () => {
    const scope = await pending();
    expect((await columns(scope.connectionId)).review_mode).toBe('on');
    const r = await dir.activate(scope, t.userId);
    const row = await columns(scope.connectionId);
    expect(row.review_mode).toBe('on');
    expect(row.review_mode_started_at).not.toBeNull();
    expect(row.review_mode_ends_at!.getTime() - row.review_mode_started_at!.getTime()).toBe(
      HOURS_168_MS,
    );
    expect(r).toEqual({
      activated: true,
      reviewMode: { state: 'active', endsAt: row.review_mode_ends_at, changed: true },
    });
    expect(await audits(scope.connectionId, 'review_mode.opted_out')).toHaveLength(0);
  });

  it('reconnect after user_disconnected keeps the original window', async () => {
    const scope = await pending();
    await dir.activate(scope, t.userId);
    const first = await columns(scope.connectionId);
    expect(await dir.disconnect(scope, t.userId)).toBe(true);
    const again = await dir.upsertPending({
      organizationId: t.organizationId,
      brandId: t.brandId,
      platform: 'facebook',
      externalAccountId: `rm-page-${n}`,
      displayName: 'Page',
      grantedScopes: ['read'],
    });
    expect(again.scope.connectionId).toBe(scope.connectionId);
    const r = await dir.activate(scope, t.userId);
    expect(r.activated).toBe(true);
    expect(r.reviewMode).toEqual({
      state: 'active',
      endsAt: first.review_mode_ends_at,
      changed: false,
    });
    expect(await columns(scope.connectionId)).toEqual(first);
  });

  it('opt-out on first activation sets opted_out and writes review_mode.opted_out', async () => {
    const scope = await pending();
    const r = await dir.activate(scope, t.userId, { reviewMode: 'opted_out' });
    expect(r).toEqual({
      activated: true,
      reviewMode: { state: 'opted_out', endsAt: null, changed: true },
    });
    expect(await columns(scope.connectionId)).toEqual({
      review_mode: 'opted_out',
      review_mode_started_at: null,
      review_mode_ends_at: null,
    });
    expect(await audits(scope.connectionId, 'review_mode.opted_out')).toEqual([
      { actor_user_id: t.userId, subject_type: 'connection', details: { platform: 'facebook' } },
    ]);
    expect(await audits(scope.connectionId, 'connection.authorized')).toHaveLength(1);
  });

  it('opt-out on a reconnect is ignored', async () => {
    const scope = await pending();
    await dir.activate(scope, t.userId);
    const first = await columns(scope.connectionId);
    const r = await dir.activate(scope, t.userId, { reviewMode: 'opted_out' });
    expect(r).toEqual({
      activated: true,
      reviewMode: { state: 'active', endsAt: first.review_mode_ends_at, changed: false },
    });
    expect(await columns(scope.connectionId)).toEqual(first);
    expect(await audits(scope.connectionId, 'review_mode.opted_out')).toHaveLength(0);
  });

  it('legacy rows are never stamped', async () => {
    const scope = {
      organizationId: t.organizationId,
      brandId: t.brandId,
      connectionId: t.connectionId,
    };
    for (const opts of [undefined, { reviewMode: 'opted_out' as const }]) {
      const r = await dir.activate(scope, t.userId, opts);
      expect(r).toEqual({
        activated: true,
        reviewMode: { state: 'off', endsAt: null, changed: false },
      });
      expect(await columns(scope.connectionId)).toEqual({
        review_mode: 'legacy',
        review_mode_started_at: null,
        review_mode_ends_at: null,
      });
    }
    expect(await audits(scope.connectionId, 'review_mode.opted_out')).toHaveLength(0);
  });

  it('a connection that does not activate keeps its review columns', async () => {
    const scope = await pending();
    await h.c.query("UPDATE connection SET status = 'paused' WHERE id = $1", [
      scope.connectionId,
    ]);
    const r = await dir.activate(scope, t.userId, { reviewMode: 'opted_out' });
    expect(r).toEqual({
      activated: false,
      reviewMode: { state: 'active', endsAt: null, changed: false },
    });
    expect(await columns(scope.connectionId)).toEqual({
      review_mode: 'on',
      review_mode_started_at: null,
      review_mode_ends_at: null,
    });
  });

  it('another tenant scope activates nothing', async () => {
    const scope = await pending();
    const other = await seedTenant(h.c, `dir-other-${n}`);
    const r = await dir.activate({ ...scope, organizationId: other.organizationId }, other.userId);
    expect(r).toEqual({
      activated: false,
      reviewMode: { state: 'off', endsAt: null, changed: false },
    });
    expect((await columns(scope.connectionId)).review_mode_started_at).toBeNull();
  });
});
