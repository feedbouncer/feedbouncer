import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { memoryBudget } from './budget.js';
import type { CallContext, Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { MemoryConnectionDirectory, MemoryCredentialVault, MemoryRefreshLock } from './memory.js';
import { ConnectorRegistry } from './registry.js';
import { isPlatform } from './types.js';
import type { QuotaMeter } from './quota.js';
import { ConnectorRuntime, isSuccessEquivalent, type RuntimeDeps } from './runtime.js';
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
let listReplies: Mock<NonNullable<Connector['listReplies']>>;
const bareScope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c2' };
let refreshTokens: Mock<Connector['refreshTokens']>;
let directory: MemoryConnectionDirectory;
let runtime: ConnectorRuntime;
let baseConnector: Connector;
let runtimeDeps: ConstructorParameters<typeof ConnectorRuntime>[0];
let lines: string[];
let budget: ReturnType<typeof memoryBudget>;
let vault: MemoryCredentialVault;

beforeEach(async () => {
  act = vi.fn(async () => ({ status: 'applied', platformActionId: 'pa1' }));
  listComments = vi.fn(async () => ({ items: [comment], nextCursor: null }));
  listReplies = vi.fn(async () => ({
    items: [{ ...comment, externalId: 'r1', parentExternalId: 'c1' }],
    nextCursor: null,
  }));
  refreshTokens = vi.fn(async () => ({
    accessToken: new Secret('access-2'),
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
    scopes: [],
  }));
  baseConnector = {
    platform: 'youtube',
    capabilities: {
      actions: ['hide', 'unhide', 'delete'],
      listSources: false,
      recentSources: false,
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
    listReplies,
    getComment: async () => null,
    act,
  };
  const registry = new ConnectorRegistry();
  registry.register(baseConnector);
  const withoutReplies: Connector = { ...baseConnector };
  delete withoutReplies.listReplies;
  registry.register({ ...withoutReplies, platform: 'tiktok' });
  directory = new MemoryConnectionDirectory();
  directory.seed({ scope, platform: 'youtube', externalAccountId: 'chan', status: 'active' });
  directory.seed({
    scope: bareScope,
    platform: 'tiktok',
    externalAccountId: 'tt',
    status: 'active',
  });
  vault = new MemoryCredentialVault();
  for (const sc of [scope, bareScope]) {
    await vault.writeAccessToken(sc, { value: new Secret('access-1'), expiresAt: null });
    await vault.writeRefreshToken(sc, { value: new Secret('refresh-1'), expiresAt: null });
  }
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
  runtimeDeps = {
    registry,
    directory,
    tokens,
    budget,
    clock,
    log,
    http,
  };
  runtime = new ConnectorRuntime(runtimeDeps);
});

describe('rate budget key', () => {
  it('names the full tenancy scope, never the connection id alone', async () => {
    const acquire = vi.spyOn(budget, 'acquire').mockResolvedValue({ granted: true });
    const c = await runtime.connect(scope);
    await c.act({ action: 'hide', target: ref });
    expect(acquire).toHaveBeenCalledWith('youtube', 'o1/b1/c1', expect.anything(), 'urgent');
  });
});

describe('ConnectionClient.lookupAd', () => {
  it('unsupported connector -> ConnectorError unsupported', async () => {
    const c = await runtime.connect(scope);
    await expect(c.lookupAd('123')).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'lookup_ad',
    });
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

describe('ConnectionClient batch actions and probes', () => {
  const ref2 = { sourceExternalId: 's1', externalId: 'c2' };
  let actBatch: Mock<NonNullable<Connector['actBatch']>>;
  let probeComments: Mock<NonNullable<Connector['probeComments']>>;
  let meter: QuotaMeter;
  let quotaMeters: Mock<NonNullable<RuntimeDeps['quotaMeters']>>;
  let batching: ConnectorRuntime;

  beforeEach(() => {
    actBatch = vi.fn(async () => ({ status: 'applied' }));
    probeComments = vi.fn(async (_ctx, refs) =>
      refs.map((r) => ({
        externalId: r.externalId,
        state: 'visible' as const,
        updatedAt: null,
        authorExternalId: 'UCauthor',
      })),
    );
    meter = { reserve: vi.fn(), settle: vi.fn() };
    quotaMeters = vi.fn(() => meter);
    const registry = new ConnectorRegistry();
    registry.register({
      ...baseConnector,
      capabilities: {
        ...baseConnector.capabilities,
        actionDispatch: 'budgeted',
        batchActions: { maxTargets: 2 },
      },
      actBatch,
      probeComments,
    });
    batching = new ConnectorRuntime({ ...runtimeDeps, registry, quotaMeters });
  });

  it("actBatch passes ctx.quota from quotaMeters and maps a thrown rate_limited to {status:'failed'}", async () => {
    const c = await batching.connect(scope);
    expect(await c.actBatch({ action: 'hide', targets: [ref, ref2] })).toEqual({
      status: 'applied',
    });
    expect(quotaMeters).toHaveBeenCalledWith('youtube', scope);
    const ctx = actBatch.mock.calls[0]![0];
    expect(ctx.quota).toBe(meter);
    expect(ctx.accessToken.reveal()).toBe('access-1');
    expect(actBatch.mock.calls[0]![1]).toEqual({ action: 'hide', targets: [ref, ref2] });

    actBatch.mockRejectedValueOnce(
      new ConnectorError('rate_limited', 'quota_budget_exhausted', { retryAfterMs: 3_600_000 }),
    );
    expect(await c.actBatch({ action: 'delete', targets: [ref] })).toEqual({
      status: 'failed',
      error: {
        kind: 'rate_limited',
        code: 'quota_budget_exhausted',
        retryAfterMs: 3_600_000,
        reauthorize: false,
      },
    });
    // A local quota refusal is not a platform throttle: reads keep their rate budget.
    await expect(c.probeComments([ref])).resolves.toHaveLength(1);
  });

  it("actBatch on a connector without actBatch returns failed 'unsupported'", async () => {
    const c = await runtime.connect(scope);
    expect(await c.actBatch({ action: 'hide', targets: [ref] })).toEqual({
      status: 'failed',
      error: { kind: 'unsupported', code: 'unsupported', retryAfterMs: null, reauthorize: false },
    });
    await expect(c.probeComments([ref])).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'probe_comments',
    });
  });

  it('actBatch maps not_found, refuses undeclared actions and oversize or malformed batches without a call', async () => {
    const c = await batching.connect(scope);
    actBatch.mockResolvedValueOnce({ status: 'not_found' });
    expect(await c.actBatch({ action: 'hide', targets: [ref] })).toEqual({ status: 'not_found' });
    actBatch.mockRejectedValueOnce(new ConnectorError('not_found', 'comment_not_found'));
    expect(await c.actBatch({ action: 'hide', targets: [ref] })).toEqual({ status: 'not_found' });
    const calls = actBatch.mock.calls.length;
    expect(await c.actBatch({ action: 'ban_author', targets: [ref] })).toMatchObject({
      status: 'failed',
      error: { kind: 'unsupported' },
    });
    for (const targets of [
      [],
      [ref, ref2, ref],
      [{ sourceExternalId: 's1', externalId: 'x\u0000' }],
    ])
      expect(await c.actBatch({ action: 'hide', targets })).toMatchObject({
        status: 'failed',
        error: { kind: 'permanent' },
      });
    expect(actBatch.mock.calls.length).toBe(calls);
  });

  it('actBatch refreshes once on a rejected token, then flags the connection', async () => {
    actBatch.mockRejectedValue(new ConnectorError('auth_expired', 'token_rejected'));
    const c = await batching.connect(scope);
    expect(await c.actBatch({ action: 'hide', targets: [ref] })).toMatchObject({
      status: 'failed',
      error: { kind: 'auth_expired', reauthorize: true },
    });
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect((await directory.load(scope))?.status).toBe('reconnect_required');
  });

  it('actBatch rejects connector output it does not recognise', async () => {
    actBatch.mockResolvedValueOnce({ status: 'done' } as never);
    const c = await batching.connect(scope);
    expect(await c.actBatch({ action: 'hide', targets: [ref] })).toMatchObject({
      status: 'failed',
      error: { kind: 'permanent', code: 'invalid_connector_output' },
    });
  });

  it('probeComments validates refs and output and passes ctx.quota', async () => {
    const c = await batching.connect(scope);
    expect(await c.probeComments([ref, ref2])).toEqual([
      { externalId: 'c1', state: 'visible', updatedAt: null, authorExternalId: 'UCauthor' },
      { externalId: 'c2', state: 'visible', updatedAt: null, authorExternalId: 'UCauthor' },
    ]);
    expect(probeComments.mock.calls[0]![0].quota).toBe(meter);
    for (const refs of [[], [ref, ref2, ref]])
      await expect(c.probeComments(refs)).rejects.toMatchObject({ code: 'invalid_request' });
    probeComments.mockResolvedValueOnce([
      { externalId: 'c1', state: 'nuked' as never, updatedAt: null, authorExternalId: null },
    ]);
    await expect(c.probeComments([ref])).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_connector_output',
    });
  });

  it('no quotaMeters, or none for the platform, leaves ctx.quota unset', async () => {
    const c = await runtime.connect(scope);
    await c.act({ action: 'hide', target: ref });
    expect(act.mock.calls[0]![0].quota).toBeUndefined();
    quotaMeters.mockReturnValue(undefined);
    const b = await batching.connect(scope);
    await b.actBatch({ action: 'hide', targets: [ref] });
    expect(actBatch.mock.calls[0]![0].quota).toBeUndefined();
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

  it('listReplies caps the limit, validates output and runs on the bulk budget', async () => {
    const acquire = vi.spyOn(budget, 'acquire').mockResolvedValue({ granted: true });
    const c = await runtime.connect(scope);
    const page = await c.listReplies({ parent: ref, cursor: null, limit: 10_000 });
    expect(page?.items).toHaveLength(1);
    expect(listReplies.mock.calls[0]![1]).toMatchObject({ parent: ref, cursor: null, limit: 25 });
    expect(acquire).toHaveBeenCalledWith('youtube', 'o1/b1/c1', expect.anything(), 'bulk');
    listReplies.mockResolvedValueOnce({
      items: [{ ...comment, permalink: 'javascript:alert(1)' }],
      nextCursor: null,
    });
    await expect(c.listReplies({ parent: ref, cursor: null })).rejects.toMatchObject({
      code: 'invalid_connector_output',
    });
  });

  it('listReplies returns null without I/O when the connector has none', async () => {
    const acquire = vi.spyOn(budget, 'acquire').mockResolvedValue({ granted: true });
    const c = await runtime.connect(bareScope);
    expect(await c.listReplies({ parent: ref, cursor: null })).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
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

  it('revoked connections are terminal: auth_expired, not reauthorizable, no platform calls', async () => {
    directory.seed({ scope, platform: 'youtube', externalAccountId: 'chan', status: 'revoked' });
    const c = await runtime.connect(scope);
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      kind: 'auth_expired',
      reauthorize: false,
    });
    expect(listComments).not.toHaveBeenCalled();
  });

  it('respond draws from the bulk budget when responsePriority is bulk: with only the urgent reserve left, respond is rate_limited/budget_exhausted while act succeeds', async () => {
    const respond = vi.fn(async (_ctx: CallContext, req: { kind: 'public_reply' }) => ({
      status: 'sent' as const,
      request: req,
      platformRef: 'r1',
    }));
    const threadsLike = {
      ...baseConnector,
      platform: 'bluesky',
      capabilities: {
        ...baseConnector.capabilities,
        responses: ['public_reply'],
        responsePriority: 'bulk',
      },
      respond,
    } as unknown as Connector;
    const registry = new ConnectorRegistry();
    registry.register(threadsLike);
    const sc = { organizationId: 'o1', brandId: 'b1', connectionId: 'c3' };
    directory.seed({ scope: sc, platform: 'bluesky', externalAccountId: 'bs', status: 'active' });
    await vault.writeAccessToken(sc, { value: new Secret('access-1'), expiresAt: null });
    await vault.writeRefreshToken(sc, { value: new Secret('refresh-1'), expiresAt: null });
    const rt = new ConnectorRuntime({ ...runtimeDeps, registry, budget: memoryBudget() });
    const c = await rt.connect(sc);
    // 4 points, 2 reserved for urgent: two bulk calls use up the bulk share.
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    const r = await c.respond({ kind: 'public_reply', target: ref, text: 'hello' });
    expect(r).toMatchObject({
      status: 'failed',
      error: { kind: 'rate_limited', code: 'budget_exhausted' },
    });
    expect(respond).not.toHaveBeenCalled();
    expect((await c.act({ action: 'hide', target: ref })).status).toBe('applied');
  });

  it('respond stays urgent when the connector does not set responsePriority', async () => {
    const respond = vi.fn(async (_ctx: CallContext, req: { kind: 'public_reply' }) => ({
      status: 'sent' as const,
      request: req,
      platformRef: 'r1',
    }));
    const registry = new ConnectorRegistry();
    registry.register({
      ...baseConnector,
      platform: 'bluesky',
      capabilities: { ...baseConnector.capabilities, responses: ['public_reply'] },
      respond,
    } as unknown as Connector);
    const sc = { organizationId: 'o1', brandId: 'b1', connectionId: 'c3' };
    directory.seed({ scope: sc, platform: 'bluesky', externalAccountId: 'bs', status: 'active' });
    await vault.writeAccessToken(sc, { value: new Secret('access-1'), expiresAt: null });
    await vault.writeRefreshToken(sc, { value: new Secret('refresh-1'), expiresAt: null });
    const rt = new ConnectorRuntime({ ...runtimeDeps, registry, budget: memoryBudget() });
    const c = await rt.connect(sc);
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    expect((await c.respond({ kind: 'public_reply', target: ref, text: 'hello' })).status).toBe(
      'sent',
    );
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

describe('storage failures', () => {
  const outage = () => new Error('connection terminated SENTINEL');
  const storageLogs = () => lines.filter((l) => l.includes('storage unavailable'));

  it('a directory outage during act is transient, logged by name only, and a retry succeeds', async () => {
    const c = await runtime.connect(scope);
    vi.spyOn(directory, 'load').mockRejectedValueOnce(outage());
    const r = await c.act({ action: 'hide', target: ref });
    expect(r).toMatchObject({
      status: 'failed',
      error: { kind: 'transient', code: 'storage_unavailable' },
    });
    expect(act).not.toHaveBeenCalled();
    expect(storageLogs()).toHaveLength(1);
    expect(storageLogs()[0]).toContain('"errorName":"Error"');
    expect(lines.join('\n')).not.toContain('SENTINEL');
    expect(lines.join('\n')).not.toContain('non-ConnectorError');
    expect((await c.act({ action: 'hide', target: ref })).status).toBe('applied');
  });

  it('a vault read outage on a read is transient', async () => {
    const c = await runtime.connect(scope);
    vi.spyOn(vault, 'readTokens').mockRejectedValueOnce(outage());
    await expect(c.listComments({ sourceExternalId: 's1', cursor: null })).rejects.toMatchObject({
      kind: 'transient',
      code: 'storage_unavailable',
    });
    expect(listComments).not.toHaveBeenCalled();
  });

  it('a vault write outage after a refresh is transient', async () => {
    act.mockRejectedValueOnce(new ConnectorError('auth_expired', 'token_rejected'));
    vault.failNextWrite('access');
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toMatchObject({
      status: 'failed',
      error: { kind: 'transient', code: 'storage_unavailable' },
    });
  });

  it('a failure to flag reauthorization is transient', async () => {
    act.mockRejectedValue(new ConnectorError('auth_expired', 'token_rejected'));
    vi.spyOn(directory, 'markReauthRequired').mockRejectedValueOnce(outage());
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toMatchObject({
      status: 'failed',
      error: { kind: 'transient', code: 'storage_unavailable' },
    });
  });

  it('connect() reports a directory outage as transient', async () => {
    vi.spyOn(directory, 'load').mockRejectedValueOnce(outage());
    await expect(runtime.connect(scope)).rejects.toMatchObject({
      kind: 'transient',
      code: 'storage_unavailable',
    });
  });

  it('a connector error is still replaced as permanent connector_failure', async () => {
    refreshTokens.mockRejectedValueOnce(new Error('platform said SENTINEL'));
    act.mockRejectedValueOnce(new ConnectorError('auth_expired', 'token_rejected'));
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toMatchObject({
      status: 'failed',
      error: { kind: 'permanent', code: 'connector_failure' },
    });
  });
});

describe('reportQuota', () => {
  it('is best-effort: a budget store failure never reaches the connector', async () => {
    vi.spyOn(budget, 'applyQuotaReport').mockRejectedValueOnce(new Error('redis down SENTINEL'));
    listComments.mockImplementationOnce(async (ctx) => {
      await ctx.reportQuota({ remaining: 0, resetAt: new Date(Date.now() + 60_000) });
      return { items: [comment], nextCursor: null };
    });
    const c = await runtime.connect(scope);
    const page = await c.listComments({ sourceExternalId: 's1', cursor: null });
    expect(page.items).toHaveLength(1);
    const logged = lines.filter((l) => l.includes('quota report'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"errorName":"Error"');
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });
});

describe('list options', () => {
  it('listComments forwards includeReplies and runs at the requested priority', async () => {
    const acquire = vi.spyOn(budget, 'acquire').mockResolvedValue({ granted: true });
    const c = await runtime.connect(scope);
    await c.listComments({ sourceExternalId: 's1', cursor: null });
    expect(acquire.mock.calls.at(-1)?.[3]).toBe('bulk');
    expect(listComments.mock.calls.at(-1)?.[1]).not.toHaveProperty('includeReplies');
    await c.listComments(
      { sourceExternalId: 's1', cursor: null, includeReplies: true },
      { priority: 'background' },
    );
    expect(acquire.mock.calls.at(-1)?.[3]).toBe('background');
    expect(listComments.mock.calls.at(-1)?.[1]).toMatchObject({ includeReplies: true });
    await c.listReplies({ parent: ref, cursor: null }, { priority: 'background' });
    expect(acquire.mock.calls.at(-1)?.[3]).toBe('background');
  });

  it('meta_ads is a platform', () => {
    expect(isPlatform('meta_ads')).toBe(true);
  });

  it('tiktok_ads is a platform', () => {
    expect(isPlatform('tiktok_ads')).toBe(true);
  });
});

describe('missing scopes', () => {
  it('auth_expired with missingScopes marks oauth_scope_missing without refreshing', async () => {
    const mark = vi.spyOn(directory, 'markReauthRequired');
    act.mockRejectedValue(
      new ConnectorError('auth_expired', 'scope_missing', { missingScopes: ['comment.list'] }),
    );
    const c = await runtime.connect(scope);
    expect(await c.act({ action: 'hide', target: ref })).toMatchObject({
      status: 'failed',
      error: { kind: 'auth_expired' },
    });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(act).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(scope, 'oauth_scope_missing', {
      missingScopes: ['comment.list'],
    });
  });
});

describe('ConnectionClient.listConnectionComments', () => {
  const req = {
    since: new Date('2026-10-01T00:00:00Z'),
    until: new Date('2026-10-02T00:00:00Z'),
    page: 1,
    pageSize: 20,
  };
  const source = { externalId: 's1', kind: 'video' as const, permalink: null, active: true };
  let listConnectionComments: Mock<NonNullable<Connector['listConnectionComments']>>;
  let connRuntime: ConnectorRuntime;

  beforeEach(async () => {
    listConnectionComments = vi.fn(async () => ({
      items: [comment],
      sources: [source],
      hasMore: false,
    }));
    const registry = new ConnectorRegistry();
    registry.register({
      ...baseConnector,
      capabilities: { ...baseConnector.capabilities, connectionComments: true },
      listConnectionComments,
    });
    connRuntime = new ConnectorRuntime({ ...runtimeDeps, registry });
  });

  it('runs at the requested priority and returns the page', async () => {
    const acquire = vi.spyOn(budget, 'acquire').mockResolvedValue({ granted: true });
    const c = await connRuntime.connect(scope);
    expect(await c.listConnectionComments(req, { priority: 'background' })).toEqual({
      items: [comment],
      sources: [source],
      hasMore: false,
    });
    expect(acquire.mock.calls.at(-1)?.[3]).toBe('background');
    expect(listConnectionComments.mock.calls.at(-1)?.[1]).toEqual(req);
  });

  it('rejects items whose source is not in sources', async () => {
    listConnectionComments.mockResolvedValueOnce({
      items: [{ ...comment, sourceExternalId: 'other' }],
      sources: [source],
      hasMore: false,
    });
    const c = await connRuntime.connect(scope);
    await expect(c.listConnectionComments(req)).rejects.toMatchObject({
      code: 'invalid_connector_output',
    });
  });

  it('is unsupported when the connector does not declare it', async () => {
    const c = await runtime.connect(scope);
    await expect(c.listConnectionComments(req)).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'list_connection_comments',
    });
  });
});
