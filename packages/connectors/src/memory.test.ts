import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { ConnectionTakenError } from './ports.js';
import {
  MemoryConnectionDirectory,
  MemoryCredentialVault,
  MemoryDeliveryLedger,
  MemoryMembershipReader,
  MemoryOAuthGrantStore,
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
    expect(await d.activate(a.scope, 'u1')).toBe(true);
    expect((await d.load(a.scope))?.status).toBe('active');
  });

  it('activate never resurrects a paused or revoked connection', async () => {
    const d = new MemoryConnectionDirectory();
    for (const status of ['paused', 'revoked'] as const) {
      const sc = { organizationId: 'o1', brandId: 'b1', connectionId: `c-${status}` };
      d.seed({ scope: sc, platform: 'facebook', externalAccountId: status, status });
      expect(await d.activate(sc, 'u1')).toBe(false);
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

const fbPending = (
  organizationId: string,
  brandId: string,
  page: string,
  displayName: string | null = null,
) => ({
  organizationId,
  brandId,
  platform: 'facebook' as const,
  externalAccountId: page,
  displayName,
  grantedScopes: [] as string[],
});

describe('MemoryConnectionDirectory (facebook pages additions)', () => {
  it('findLiveByAccount returns the live row and ignores revoked ones', async () => {
    const d = new MemoryConnectionDirectory();
    const { scope: sc } = await d.upsertPending(fbPending('org-a', 'brand-a', 'p1', 'P'));
    expect((await d.findLiveByAccount('facebook', 'p1'))?.scope).toEqual(sc);
    expect(await d.disconnect(sc, 'user-a')).toBe(true);
    expect(await d.findLiveByAccount('facebook', 'p1')).toBeNull();
    expect(await d.disconnect(sc, 'user-a')).toBe(false);
    expect(d.statusReason(sc.connectionId)).toBe('user_disconnected');
  });

  it('disconnect marks a connection revoked for another reason user_disconnected, once', async () => {
    const d = new MemoryConnectionDirectory();
    const sc = { organizationId: 'org-a', brandId: 'brand-a', connectionId: 'c-gone' };
    d.seed({ scope: sc, platform: 'facebook', externalAccountId: 'p9', status: 'revoked' });
    expect(await d.disconnect(sc, 'user-a')).toBe(true);
    expect(d.statusReason(sc.connectionId)).toBe('user_disconnected');
    expect(await d.disconnect(sc, 'user-a')).toBe(false);
  });

  it('disconnect ignores a scope from another tenant', async () => {
    const d = new MemoryConnectionDirectory();
    const { scope: sc } = await d.upsertPending(fbPending('org-a', 'brand-a', 'p1'));
    expect(await d.disconnect({ ...sc, organizationId: 'org-b' }, 'user-a')).toBe(false);
    expect(await d.disconnect({ ...sc, brandId: 'brand-b' }, 'user-a')).toBe(false);
    expect((await d.load(sc))?.status).toBe('reconnect_required');
  });

  it('upsertPending reopens a user-disconnected row but not a platform-revoked one', async () => {
    const d = new MemoryConnectionDirectory();
    const first = await d.upsertPending(fbPending('org-a', 'brand-a', 'p2'));
    await d.disconnect(first.scope, 'user-a');
    const again = await d.upsertPending(fbPending('org-a', 'brand-a', 'p2', 'P2'));
    expect(again).toEqual({ scope: first.scope, created: false });
    expect((await d.load(first.scope))?.status).toBe('reconnect_required');
    expect(d.statusReason(first.scope.connectionId)).toBe('oauth_pending');
    const other = { organizationId: 'org-a', brandId: 'brand-a', connectionId: 'c-rev' };
    d.seed({ scope: other, platform: 'facebook', externalAccountId: 'p3', status: 'revoked' });
    await d.upsertPending(fbPending('org-a', 'brand-a', 'p3'));
    expect((await d.load(other))?.status).toBe('revoked');
  });

  it('upsertPending throws ConnectionTakenError when another brand holds the page', async () => {
    const d = new MemoryConnectionDirectory();
    await d.upsertPending(fbPending('org-a', 'brand-a', 'p4'));
    await expect(d.upsertPending(fbPending('org-b', 'brand-b', 'p4'))).rejects.toBeInstanceOf(
      ConnectionTakenError,
    );
  });
});

describe('MemoryOAuthStateStore.peekBinding', () => {
  it('returns the binding without consuming, and null when expired', async () => {
    const s = new MemoryOAuthStateStore();
    const h = Buffer.alloc(32, 7);
    const binding = {
      organizationId: 'org-a',
      brandId: 'brand-a',
      platform: 'facebook' as const,
      initiatedByUserId: 'user-a',
    };
    await s.save(h, {
      id: 'st-peek',
      ...binding,
      redirectUri: 'https://x.test/cb',
      scopes: [],
      reconnectConnectionId: null,
      codeVerifier: new Secret('v'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await s.peekBinding(h)).toEqual(binding);
    expect(await s.consume(h, binding)).not.toBeNull();
    expect(await s.peekBinding(h)).toBeNull();
    const h2 = Buffer.alloc(32, 8);
    await s.save(h2, {
      id: 'st-old',
      ...binding,
      redirectUri: 'https://x.test/cb',
      scopes: [],
      reconnectConnectionId: null,
      codeVerifier: new Secret('v'),
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await s.peekBinding(h2)).toBeNull();
  });
});

describe('MemoryOAuthGrantStore', () => {
  const binding = {
    organizationId: 'org-a',
    brandId: 'brand-a',
    platform: 'facebook' as const,
    initiatedByUserId: 'user-a',
  };
  const grant = (expiresAt: Date) => ({
    id: 'g1',
    ...binding,
    reconnectConnectionId: null,
    userToken: new Secret('EAAG-SENTINEL'),
    grantedScopes: ['pages_show_list'],
    expiresAt,
  });

  it('is binding-checked and single-use', async () => {
    const grants = new MemoryOAuthGrantStore();
    await grants.save(grant(new Date(Date.now() + 60_000)));
    expect(await grants.load('g1', { ...binding, initiatedByUserId: 'user-b' })).toBeNull();
    expect((await grants.load('g1', binding))?.userToken.reveal()).toBe('EAAG-SENTINEL');
    expect(await grants.consume('g1', { ...binding, brandId: 'brand-b' })).toBeNull();
    expect((await grants.consume('g1', binding))?.grantedScopes).toEqual(['pages_show_list']);
    expect(await grants.consume('g1', binding)).toBeNull();
  });

  it('returns null without consuming once expired', async () => {
    let now = 1_000;
    const grants = new MemoryOAuthGrantStore({ now: () => now });
    await grants.save(grant(new Date(2_000)));
    expect(await grants.load('g1', binding)).not.toBeNull();
    now = 3_000;
    expect(await grants.load('g1', binding)).toBeNull();
    expect(await grants.consume('g1', binding)).toBeNull();
  });
});
