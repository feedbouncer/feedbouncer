import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { memoryBudget } from './budget.js';
import type { CallContext, Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { MemoryConnectionDirectory, MemoryCredentialVault, MemoryRefreshLock } from './memory.js';
import { ConnectorRegistry } from './registry.js';
import { ConnectorRuntime, isSuccessEquivalent } from './runtime.js';
import { TokenManager } from './tokens.js';

const scope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c1' };
const comment = {
  externalId: 'c1',
  sourceExternalId: 's1',
  parentExternalId: null,
  author: null,
  body: 'hi',
  postedAt: new Date('2026-10-01T00:00:00Z'),
  platformState: 'visible' as const,
  permalink: null,
};
const ref = { sourceExternalId: 's1', externalId: 'c1' };

let act: Mock<Connector['act']>;
let listComments: Mock<Connector['listComments']>;
let refreshTokens: Mock<Connector['refreshTokens']>;
let directory: MemoryConnectionDirectory;
let runtime: ConnectorRuntime;
let lines: string[];
let budget: ReturnType<typeof memoryBudget>;

beforeEach(async () => {
  act = vi.fn(async () => ({ status: 'applied', platformActionId: 'pa1' }));
  listComments = vi.fn(async () => ({ items: [comment], nextCursor: null }));
  refreshTokens = vi.fn(async () => ({
    accessToken: new Secret('access-2'),
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
    scopes: [],
  }));
  const connector: Connector = {
    platform: 'youtube',
    capabilities: {
      actions: ['hide', 'unhide', 'delete'],
      listSources: false,
      ingestion: 'polling',
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: { points: 4, durationSec: 60, urgentReservePoints: 2, defaultRetryAfterMs: 7_000 },
      apiHosts: ['api.reference.test'],
      authorizationHosts: ['auth.reference.test'],
      defaultScopes: [],
      maxPageSize: 25,
    },
    buildAuthorizationUrl: () => new URL('https://auth.reference.test/'),
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refreshTokens,
    listComments,
    getComment: async () => null,
    act,
  };
  const registry = new ConnectorRegistry();
  registry.register(connector);
  directory = new MemoryConnectionDirectory();
  directory.seed({ scope, platform: 'youtube', externalAccountId: 'chan', status: 'active' });
  const vault = new MemoryCredentialVault();
  await vault.writeAccessToken(scope, { value: new Secret('access-1'), expiresAt: null });
  await vault.writeRefreshToken(scope, { value: new Secret('refresh-1'), expiresAt: null });
  lines = [];
  budget = memoryBudget();
  const log = createLogger('t', 'debug', (l) => lines.push(l));
  const clock = { now: () => Date.now() };
  const http = () => ({
    request: async () => {
      throw new Error('no');
    },
  });
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log,
    oauthContext: () => ({
      http: http(),
      signal: AbortSignal.timeout(1000),
      redirectUri: 'https://app.test/cb',
    }),
  });
  runtime = new ConnectorRuntime({
    registry,
    directory,
    tokens,
    budget,
    clock,
    log,
    http,
  });
});

describe('rate budget key', () => {
  it('names the full tenancy scope, never the connection id alone', async () => {
    const acquire = vi.spyOn(budget, 'acquire');
    const c = await runtime.connect(scope);
    await c.act({ action: 'hide', target: ref });
    expect(acquire).toHaveBeenCalledWith('youtube', 'o1/b1/c1', expect.anything(), 'urgent');
  });
});

describe('ConnectionClient.act', () => {
  it('applies a supported action and offers an undo when the inverse is supported', async () => {
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toEqual({
      status: 'applied',
      request: { action: 'hide', target: ref },
      platformActionId: 'pa1',
      undo: { action: 'unhide', target: ref },
    });
    expect((act.mock.calls[0]![0] as CallContext).accessToken.reveal()).toBe('access-1');
  });

  it('returns unsupported for undeclared actions without any platform call or budget use', async () => {
    const c = await runtime.connect(scope);
    for (let i = 0; i < 10; i++)
      expect((await c.act({ action: 'ban_author', target: ref })).status).toBe('unsupported');
    expect(act).not.toHaveBeenCalled();
    expect((await c.act({ action: 'hide', target: ref })).status).toBe('applied');
  });

  it('reports not_found for vanished content, success-equivalent only for delete', async () => {
    act.mockResolvedValueOnce({ status: 'not_found' });
    act.mockRejectedValueOnce(new ConnectorError('not_found', 'gone'));
    const c = await runtime.connect(scope);
    const del = await c.act({ action: 'delete', target: ref });
    const hide = await c.act({ action: 'hide', target: ref });
    expect([del.status, hide.status]).toEqual(['not_found', 'not_found']);
    expect(isSuccessEquivalent(del)).toBe(true);
    expect(isSuccessEquivalent(hide)).toBe(false);
  });

  it('refreshes once and retries when the platform rejects the access token', async () => {
    act.mockRejectedValueOnce(new ConnectorError('auth_expired', 'token_rejected'));
    const c = await runtime.connect(scope);
    expect((await c.act({ action: 'hide', target: ref })).status).toBe('applied');
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect((act.mock.calls[1]![0] as CallContext).accessToken.reveal()).toBe('access-2');
  });

  it('a second rejection flags the connection and later calls short-circuit', async () => {
    act.mockRejectedValue(new ConnectorError('auth_expired', 'token_rejected'));
    const c = await runtime.connect(scope);
    const r = await c.act({ action: 'hide', target: ref });
    expect(r).toMatchObject({
      status: 'failed',
      error: { kind: 'auth_expired', reauthorize: true },
    });
    const calls = act.mock.calls.length;
    for (let i = 0; i < 5; i++) await c.act({ action: 'hide', target: ref });
    expect(act.mock.calls.length).toBe(calls);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('returns failed with the platform retry hint and blocks the budget', async () => {
    act.mockRejectedValueOnce(
      new ConnectorError('rate_limited', 'platform_throttled', { retryAfterMs: 30_000 }),
    );
    const c = await runtime.connect(scope);
    const r = await c.act({ action: 'hide', target: ref });
    expect(r).toMatchObject({
      status: 'failed',
      error: { kind: 'rate_limited', retryAfterMs: 30_000 },
    });
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      kind: 'rate_limited',
      code: 'budget_exhausted',
    });
  });

  it('maps a foreign error to failed/permanent without its message', async () => {
    act.mockRejectedValueOnce(new Error('boom access_token=SENTINEL'));
    const c = await runtime.connect(scope);
    const r = await c.act({ action: 'hide', target: ref });
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
    expect(r).toMatchObject({
      status: 'failed',
      error: { kind: 'permanent', code: 'connector_failure' },
    });
  });

  it('validates the action request at the boundary', async () => {
    const c = await runtime.connect(scope);
    const r = await c.act({
      action: 'hide',
      target: { sourceExternalId: 's1', externalId: 'x\u0000' },
    });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'invalid_action_request' } });
    expect(act).not.toHaveBeenCalled();
  });
});

describe('ConnectionClient reads', () => {
  it('caps the page size at maxPageSize and validates output', async () => {
    const c = await runtime.connect(scope);
    await c.listComments({ sourceExternalId: 's1', cursor: null, limit: 10_000 });
    expect(listComments.mock.calls[0]![1]).toMatchObject({ limit: 25 });
    listComments.mockResolvedValueOnce({
      items: [{ ...comment, permalink: 'javascript:alert(1)' }],
      nextCursor: null,
    });
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      code: 'invalid_connector_output',
    });
  });

  it('defers bulk reads when the budget is exhausted, keeping the urgent reserve', async () => {
    const c = await runtime.connect(scope);
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    const err = await c
      .listComments({ sourceExternalId: 's1', cursor: null })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', code: 'budget_exhausted' });
    expect((err as ConnectorError).retryAfterMs).toBeGreaterThan(0);
    expect(listComments).toHaveBeenCalledTimes(2);
    expect((await c.act({ action: 'hide', target: ref })).status).toBe('applied');
  });

  it('listSources is unsupported when not declared', async () => {
    const c = await runtime.connect(scope);
    await expect(c.listSources(null)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('connect() refuses connections outside the scope', async () => {
    await expect(runtime.connect({ ...scope, organizationId: 'o2' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('paused connections fail permanently without platform calls', async () => {
    directory.seed({ scope, platform: 'youtube', externalAccountId: 'chan', status: 'paused' });
    const c = await runtime.connect(scope);
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      kind: 'permanent',
      code: 'connection_inactive',
    });
    expect(listComments).not.toHaveBeenCalled();
  });
});

describe('ConnectionClient edge cases', () => {
  it('getComment rejects a malformed ref as invalid_request and maps not_found to null', async () => {
    const c = await runtime.connect(scope);
    await expect(c.getComment({ sourceExternalId: '', externalId: 'c1' })).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_request',
    });
    expect(await c.getComment(ref)).toBeNull();
  });

  it('offers no undo when the inverse action is not declared', async () => {
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'delete', target: ref })).toMatchObject({
      status: 'applied',
      undo: null,
    });
  });

  it('revoked connections require reauthorization without platform calls', async () => {
    directory.seed({ scope, platform: 'youtube', externalAccountId: 'chan', status: 'revoked' });
    const c = await runtime.connect(scope);
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      kind: 'auth_expired',
      reauthorize: true,
    });
    expect(listComments).not.toHaveBeenCalled();
  });

  it('connect() reports an unregistered platform as unsupported', async () => {
    const other = { organizationId: 'o1', brandId: 'b1', connectionId: 'c2' };
    directory.seed({ scope: other, platform: 'x', externalAccountId: 'a', status: 'active' });
    await expect(runtime.connect(other)).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'platform_not_registered',
    });
  });

  it('replaces foreign read errors without leaking their message', async () => {
    listComments.mockRejectedValueOnce(new Error('boom access_token=SENTINEL'));
    const c = await runtime.connect(scope);
    const err = await c
      .listComments({ sourceExternalId: 's1', cursor: null })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'connector_failure' });
    expect(String((err as Error).message)).not.toContain('SENTINEL');
  });

  it('rejects a malformed connector action outcome', async () => {
    act.mockResolvedValueOnce({ status: 'bogus' } as never);
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_connector_output' },
    });
  });
});

describe('replaced connector errors', () => {
  const replacedLogs = () => lines.filter((l) => l.includes('non-ConnectorError'));

  it('logs only the error name, once, when a read throws a foreign error', async () => {
    listComments.mockRejectedValueOnce(new TypeError('boom SENTINEL'));
    const c = await runtime.connect(scope);
    const err = await c
      .listComments({ sourceExternalId: 's1', cursor: null })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'connector_failure' });
    expect(JSON.stringify(err)).not.toContain('SENTINEL');
    expect(replacedLogs()).toHaveLength(1);
    expect(replacedLogs()[0]).toContain('TypeError');
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('logs only the error name, once, when act throws a foreign error', async () => {
    act.mockRejectedValueOnce(new TypeError('boom SENTINEL'));
    const c = await runtime.connect(scope);
    const r = await c.act({ action: 'hide', target: ref });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'connector_failure' } });
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
    expect(replacedLogs()).toHaveLength(1);
    expect(replacedLogs()[0]).toContain('TypeError');
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });
});
