import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgConnectionDirectory } from '@feedbouncer/connectors';
import type { Mailer } from '@feedbouncer/mailer';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger } from '@feedbouncer/service-runtime';
import {
  EmailReconnectNotifier,
  NotifyingConnectionDirectory,
  type ReconnectNotifier,
} from './reconnect-notifier.js';

const PAGE_NAME = '<img src=x onerror=alert(1)>';
const lines: string[] = [];
const log = createLogger('comments-reconnect-test', 'info', (l) => lines.push(l));
const publicWebUrl = new URL('https://app.feedbouncer.test');

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let other: Tenant;
let owners: string[];
let mailer: MemoryMailer;

const scopeOf = (x: Tenant): ConnectionScope => ({
  organizationId: x.organizationId,
  brandId: x.brandId,
  connectionId: x.connectionId,
});
const emailOf = async (userId: string) =>
  (await ctx.c.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [userId]))
    .rows[0]!.email;
async function addMember(orgId: string, role: string, label: string): Promise<string> {
  const u = await ctx.c.query<{ id: string }>(
    'INSERT INTO app_user (email) VALUES ($1) RETURNING id',
    [`${label}@example.test`],
  );
  await ctx.c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    u.rows[0]!.id,
    role,
  ]);
  return u.rows[0]!.id;
}
const directoryWith = (m: Mailer) =>
  new NotifyingConnectionDirectory(
    new PgConnectionDirectory(pool),
    new EmailReconnectNotifier({ pool, mailer: m, publicWebUrl, log }),
    log,
  );
const resetConnection = (x: Tenant) =>
  ctx.c.query("UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1", [
    x.connectionId,
  ]);

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'reconnect-test', onIdleError: () => {} });
  t = await seedTenant(ctx.c, 'rc');
  other = await seedTenant(ctx.c, 'rc-other');
  await ctx.c.query('UPDATE connection SET display_name = $1 WHERE id = $2', [
    PAGE_NAME,
    t.connectionId,
  ]);
  const secondOwner = await addMember(t.organizationId, 'owner', 'rc-owner2');
  await addMember(t.organizationId, 'admin', 'rc-admin');
  await addMember(t.organizationId, 'member', 'rc-member');
  owners = [await emailOf(t.userId), await emailOf(secondOwner)];
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  lines.length = 0;
  mailer = new MemoryMailer();
  await resetConnection(t);
});

describe('NotifyingConnectionDirectory + EmailReconnectNotifier', () => {
  it('emails each owner of the organization once when the connection first needs reconnecting', async () => {
    const dir = directoryWith(mailer);
    expect(await dir.markReauthRequired(scopeOf(t), 'oauth_access_rejected')).toBe(true);
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(2));
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([...owners].sort());
    const url = `${publicWebUrl.origin}/orgs/${t.organizationId}/brands/${t.brandId}/connections`;
    for (const m of mailer.sent) {
      expect(m.text).toContain(url);
      expect(m.html).toContain(url);
    }

    expect(await dir.markReauthRequired(scopeOf(t), 'oauth_access_rejected')).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(mailer.sent).toHaveLength(2);
  });

  it('escapes the Page name in HTML and keeps it out of the subject', async () => {
    await directoryWith(mailer).markReauthRequired(scopeOf(t), 'oauth_refresh_rejected');
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(2));
    const m = mailer.sent[0]!;
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.subject).toBe('Action needed: reconnect a Facebook Page in FeedBouncer');
  });

  it('never emails admins, members or another organization', async () => {
    await directoryWith(mailer).markReauthRequired(scopeOf(t), 'oauth_access_rejected');
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(2));
    expect(mailer.sent.map((m) => m.to)).not.toContain(await emailOf(other.userId));
    expect(mailer.sent.some((m) => /rc-(admin|member)@/.test(m.to))).toBe(false);
  });

  it('a scope that does not match the connection sends nothing', async () => {
    const notifier = new EmailReconnectNotifier({ pool, mailer, publicWebUrl, log });
    await notifier.connectionNeedsReconnect({
      ...scopeOf(t),
      organizationId: other.organizationId,
    });
    expect(mailer.sent).toEqual([]);
  });

  it('a mailer failure is logged and never fails the caller', async () => {
    const failing: Mailer = {
      send: async () => {
        throw new Error('smtp down for owner@example.test');
      },
    };
    expect(
      await directoryWith(failing).markReauthRequired(scopeOf(t), 'oauth_access_rejected'),
    ).toBe(true);
    await vi.waitFor(() => expect(lines.join()).toContain('notification.reconnect_failed'));
    const line = JSON.parse(lines.find((l) => l.includes('notification.reconnect_failed'))!);
    expect(line).toMatchObject({ connectionId: t.connectionId, errorName: 'Error' });
    expect(lines.join()).not.toContain('smtp down');
  });

  it('delegates every other method to the inner directory', async () => {
    const calls: string[] = [];
    const inner = new PgConnectionDirectory(pool);
    const notifier: ReconnectNotifier = { connectionNeedsReconnect: async () => {} };
    const dir = new NotifyingConnectionDirectory(inner, notifier, log);
    for (const m of [
      'load',
      'findLiveByAccount',
      'disconnect',
      'activate',
      'upsertPending',
    ] as const)
      vi.spyOn(inner, m).mockImplementation(async () => {
        calls.push(m);
        return null as never;
      });
    await dir.load(scopeOf(t));
    await dir.findLiveByAccount('facebook', 'x');
    await dir.disconnect(scopeOf(t), t.userId);
    await dir.activate(scopeOf(t), t.userId);
    await dir.upsertPending({
      organizationId: t.organizationId,
      brandId: t.brandId,
      platform: 'facebook',
      externalAccountId: 'x',
      displayName: null,
      grantedScopes: [],
    });
    expect(calls).toEqual(['load', 'findLiveByAccount', 'disconnect', 'activate', 'upsertPending']);
  });
});
