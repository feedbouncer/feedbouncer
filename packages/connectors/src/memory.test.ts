import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import {
  MemoryConnectionDirectory,
  MemoryCredentialVault,
  MemoryDeliveryLedger,
  MemoryMembershipReader,
  MemoryOAuthStateStore,
  MemoryRefreshLock,
  StaticWebhookSecrets,
} from './memory.js';

const scope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c1' };

describe('memory adapters', () => {
  it('directory scopes loads by organization and brand', async () => {
    const d = new MemoryConnectionDirectory();
    d.seed({ scope, platform: 'facebook', externalAccountId: 'p1', status: 'active' });
    expect(await d.load(scope)).not.toBeNull();
    expect(await d.load({ ...scope, organizationId: 'o2' })).toBeNull();
    expect(await d.load({ ...scope, brandId: 'b2' })).toBeNull();
  });

  it('markReauthRequired flags once, only from active/paused/error', async () => {
    const d = new MemoryConnectionDirectory();
    d.seed({ scope, platform: 'facebook', externalAccountId: 'p1', status: 'active' });
    expect(await d.markReauthRequired(scope, 'oauth_refresh_rejected')).toBe(true);
    expect(await d.markReauthRequired(scope, 'oauth_refresh_rejected')).toBe(false);
    expect((await d.load(scope))?.status).toBe('reconnect_required');
    expect(d.statusReason('c1')).toBe('oauth_refresh_rejected');
  });

  it('markReauthRequired ignores a scope from another organization', async () => {
    const d = new MemoryConnectionDirectory();
    d.seed({ scope, platform: 'facebook', externalAccountId: 'p1', status: 'active' });
    expect(
      await d.markReauthRequired({ ...scope, organizationId: 'o2' }, 'oauth_refresh_rejected'),
    ).toBe(false);
    expect((await d.load(scope))?.status).toBe('active');
  });

  it('upsertPending is idempotent on (brand, platform, external account)', async () => {
    const d = new MemoryConnectionDirectory();
    const a = await d.upsertPending({
      organizationId: 'o1',
      brandId: 'b1',
      platform: 'facebook',
      externalAccountId: 'p1',
      displayName: null,
      grantedScopes: [],
    });
    const b = await d.upsertPending({
      organizationId: 'o1',
      brandId: 'b1',
      platform: 'facebook',
      externalAccountId: 'p1',
      displayName: 'x',
      grantedScopes: [],
    });
    expect(a.created).toBe(true);
    expect(b).toEqual({ scope: a.scope, created: false });
    expect((await d.load(a.scope))?.status).toBe('reconnect_required');
    await d.activate(a.scope, 'u1');
    expect((await d.load(a.scope))?.status).toBe('active');
  });

  it('activate never resurrects a paused or revoked connection', async () => {
    const d = new MemoryConnectionDirectory();
    for (const status of ['paused', 'revoked'] as const) {
      const sc = { organizationId: 'o1', brandId: 'b1', connectionId: `c-${status}` };
      d.seed({ scope: sc, platform: 'facebook', externalAccountId: status, status });
      await d.activate(sc, 'u1');
      expect((await d.load(sc))?.status).toBe(status);
    }
  });

  it('upsertPending refuses a brand that belongs to another organization', async () => {
    const d = new MemoryConnectionDirectory();
    await d.upsertPending({
      organizationId: 'o1',
      brandId: 'b1',
      platform: 'facebook',
      externalAccountId: 'p1',
      displayName: null,
      grantedScopes: [],
    });
    await expect(
      d.upsertPending({
        organizationId: 'o2',
        brandId: 'b1',
        platform: 'facebook',
        externalAccountId: 'p1',
        displayName: null,
        grantedScopes: [],
      }),
    ).rejects.toThrow();
  });

  it('vault can be told to fail the next write', async () => {
    const v = new MemoryCredentialVault();
    v.failNextWrite('access');
    await expect(
      v.writeAccessToken(scope, { value: new Secret('a'), expiresAt: null }),
    ).rejects.toThrow();
    await v.writeAccessToken(scope, { value: new Secret('a'), expiresAt: null });
    expect((await v.readTokens(scope)).access?.value.reveal()).toBe('a');
  });

  it('vault isolates tokens by full scope', async () => {
    const v = new MemoryCredentialVault();
    await v.writeRefreshToken(scope, { value: new Secret('r'), expiresAt: null });
    expect((await v.readTokens({ ...scope, organizationId: 'o2' })).refresh).toBeNull();
    expect((await v.readTokens({ ...scope, brandId: 'b2' })).refresh).toBeNull();
  });

  it('refresh lock serializes per connection', async () => {
    const lock = new MemoryRefreshLock();
    const order: string[] = [];
    let release!: () => void;
    const first = lock.run(
      scope,
      () =>
        new Promise<void>((r) => {
          order.push('a-start');
          release = () => {
            order.push('a-end');
            r();
          };
        }),
    );
    const second = lock.run(scope, async () => {
      order.push('b');
    });
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('state store consumes once and only with a matching binding', async () => {
    const s = new MemoryOAuthStateStore();
    const h = Buffer.alloc(32, 1);
    const binding = {
      organizationId: 'o1',
      brandId: 'b1',
      platform: 'facebook' as const,
      initiatedByUserId: 'u1',
    };
    await s.save(h, {
      id: 'st1',
      ...binding,
      redirectUri: 'https://app.test/cb',
      scopes: [],
      reconnectConnectionId: null,
      codeVerifier: new Secret('v'),
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(await s.consume(h, { ...binding, initiatedByUserId: 'u2' })).toBeNull();
    expect(await s.consume(h, { ...binding, brandId: 'b2' })).toBeNull();
    expect(s.size()).toBe(1);
    expect(await s.consume(h, binding)).not.toBeNull();
    expect(await s.consume(h, binding)).toBeNull();
  });

  it('membership reader returns the granted role only for the exact triple', async () => {
    const m = new MemoryMembershipReader();
    m.grant('o1', 'b1', 'u1', 'admin');
    expect(await m.roleInBrand('o1', 'b1', 'u1')).toBe('admin');
    expect(await m.roleInBrand('o2', 'b1', 'u1')).toBeNull();
    expect(await m.roleInBrand('o1', 'b2', 'u1')).toBeNull();
    expect(await m.roleInBrand('o1', 'b1', 'u2')).toBeNull();
  });

  it('ledger runs work once per key and rolls back the claim when work throws', async () => {
    const l = new MemoryDeliveryLedger();
    await expect(
      l.once('ns', 'k', async () => {
        throw new Error('enqueue failed');
      }),
    ).rejects.toThrow();
    let runs = 0;
    expect(
      await l.once('ns', 'k', async () => {
        runs++;
      }),
    ).toBe('processed');
    expect(
      await l.once('ns', 'k', async () => {
        runs++;
      }),
    ).toBe('duplicate');
    expect(runs).toBe(1);
  });

  it('ledger namespaces keys and coalesces concurrent deliveries', async () => {
    const l = new MemoryDeliveryLedger();
    let runs = 0;
    const work = async () => {
      runs++;
    };
    const [a, b] = await Promise.all([l.once('ns', 'k', work), l.once('ns', 'k', work)]);
    expect([a, b].sort()).toEqual(['duplicate', 'processed']);
    expect(await l.once('other', 'k', work)).toBe('processed');
    expect(runs).toBe(2);
  });

  it('webhook secrets resolve only for the matching platform', async () => {
    const app = new Secret('app');
    const conn = new Secret('conn');
    const w = new StaticWebhookSecrets(
      new Map([['facebook' as const, app]]),
      new Map([['c1', { secret: conn, externalAccountId: 'p1', platform: 'facebook' as const }]]),
    );
    expect(w.appSecret('facebook')).toBe(app);
    expect(w.appSecret('youtube')).toBeNull();
    expect((await w.connectionSecret('c1', 'facebook'))?.externalAccountId).toBe('p1');
    expect(await w.connectionSecret('c1', 'youtube')).toBeNull();
    expect(await w.connectionSecret('c2', 'facebook')).toBeNull();
  });
});
