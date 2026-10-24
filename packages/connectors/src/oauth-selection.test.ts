import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import type { Connector, GrantableAccount } from './connector.js';
import { createMemoryStack } from './testing/runtime.js';

const SCOPES = ['read', 'manage'];
function multiConnector(opts: {
  granted: string[];
  accounts: () => GrantableAccount[];
  accountIdPattern?: RegExp;
}): Connector {
  return {
    platform: 'facebook',
    capabilities: {
      actions: ['hide'],
      listSources: false,
      recentSources: false,
      ingestion: 'polling',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      rateLimit: {
        points: 100,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 5_000,
      },
      apiHosts: ['api.example.test'],
      authorizationHosts: ['auth.example.test'],
      defaultScopes: SCOPES,
      requiredScopes: SCOPES,
      accountSelection: 'multiple',
      ...(opts.accountIdPattern ? { accountIdPattern: opts.accountIdPattern } : {}),
      maxPageSize: 50,
    },
    buildAuthorizationUrl: ({ state }) => new URL(`https://auth.example.test/a?state=${state}`),
    exchangeCode: async () => ({
      tokens: {
        accessToken: new Secret('USER-TOKEN-SENTINEL'),
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scopes: opts.granted,
      },
      account: { externalAccountId: 'user-1', displayName: 'U' },
    }),
    refreshTokens: async () => {
      throw new Error('unused');
    },
    listAccounts: async (token) => {
      expect(token.reveal()).toBe('USER-TOKEN-SENTINEL');
      return opts.accounts();
    },
    listComments: async () => ({ items: [], nextCursor: null }),
    getComment: async () => null,
    act: async () => ({ status: 'not_found' }),
  };
}
const page = (id: string, eligible = true): GrantableAccount => ({
  externalAccountId: id,
  displayName: `Page ${id}`,
  eligible,
  ineligibleReason: eligible ? null : 'insufficient_page_role',
  limitations: [],
  accessToken: new Secret(`PAGE-TOKEN-${id}`),
});

let now = Date.parse('2026-10-13T10:00:00Z');
const clock = { now: () => now };

async function setup(granted = SCOPES, accounts = () => [page('101'), page('102', false)]) {
  const stack = await createMemoryStack(multiConnector({ granted, accounts }), {
    webhookSecret: null,
    redirectUri: 'https://app.test/cb',
    clock,
  });
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
  const state = authorizationUrl.searchParams.get('state')!;
  return { stack, state };
}
const scopeOf = (
  stack: { actor: { organizationId: string; brandId: string } },
  connectionId: string,
) => ({ organizationId: stack.actor.organizationId, brandId: stack.actor.brandId, connectionId });

describe('required scopes', () => {
  it('returns missing_permissions and stores nothing when a scope was declined', async () => {
    const { stack, state } = await setup(['read']);
    const upsert = vi.spyOn(stack.directory, 'upsertPending');
    const save = vi.spyOn(stack.grants!, 'save');
    const r = await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' });
    expect(r).toEqual({ ok: false, reason: 'missing_permissions', missing: ['manage'] });
    expect(upsert).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(stack.lines.join('\n')).not.toContain('USER-TOKEN-SENTINEL');
  });
});

describe('accountIdPattern', () => {
  const pattern = /^[A-Za-z0-9_-]{1,64}$/;
  const setupWith = async (ids: string[]) => {
    const stack = await createMemoryStack(
      multiConnector({
        granted: SCOPES,
        accounts: () => ids.map((i) => page(i)),
        accountIdPattern: pattern,
      }),
      { webhookSecret: null, redirectUri: 'https://app.test/cb', clock },
    );
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const state = authorizationUrl.searchParams.get('state')!;
    const r = await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' });
    return { stack, grantId: (r as { grantId: string }).grantId };
  };

  it('listAccounts ids are validated with accountIdPattern', async () => {
    const ok = await setupWith(['-000abc']);
    expect(
      await ok.stack.oauth.listGrantAccounts(ok.stack.actor, 'facebook', ok.grantId),
    ).toMatchObject({
      ok: true,
      accounts: [{ externalAccountId: '-000abc' }],
    });
    const bad = await setupWith(['a/b']);
    expect(
      await bad.stack.oauth.listGrantAccounts(bad.stack.actor, 'facebook', bad.grantId),
    ).toEqual({
      ok: false,
      reason: 'platform_error',
    });
  });
});

describe('account selection', () => {
  it('stores a grant, lists accounts without tokens, connects only eligible ones', async () => {
    const { stack, state } = await setup();
    const r = await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' });
    expect(r).toMatchObject({ ok: true, kind: 'account_selection' });
    const grantId = (r as { grantId: string }).grantId;

    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'facebook', grantId);
    expect(listed).toEqual({
      ok: true,
      accounts: [
        {
          externalAccountId: '101',
          displayName: 'Page 101',
          eligible: true,
          ineligibleReason: null,
          limitations: [],
          connection: null,
        },
        {
          externalAccountId: '102',
          displayName: 'Page 102',
          eligible: false,
          ineligibleReason: 'insufficient_page_role',
          limitations: [],
          connection: null,
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain('PAGE-TOKEN');

    const done = await stack.oauth.connectAccounts(stack.actor, 'facebook', grantId, [
      '101',
      '102',
      '999',
    ]);
    expect(done.ok && done.results.map((x) => [x.externalAccountId, x.status])).toEqual([
      ['101', 'connected'],
      ['102', 'not_eligible'],
      ['999', 'not_found'],
    ]);
    const id = done.ok ? done.results[0]!.connectionId! : '';
    const scope = scopeOf(stack, id);
    expect((await stack.directory.load(scope))?.status).toBe('active');
    expect((await stack.vault.readTokens(scope)).access?.value.reveal()).toBe('PAGE-TOKEN-101');
    // single-use
    expect(await stack.oauth.connectAccounts(stack.actor, 'facebook', grantId, ['101'])).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(stack.lines.join('\n')).not.toMatch(/TOKEN-SENTINEL|PAGE-TOKEN/);
  });

  it('reconnecting the same page refreshes the token without a duplicate connection', async () => {
    let token = 'PAGE-TOKEN-A';
    const accounts = () => [{ ...page('101'), accessToken: new Secret(token) }];
    const { stack, state } = await setup(SCOPES, accounts);
    const g1 = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    const first = await stack.oauth.connectAccounts(stack.actor, 'facebook', g1.grantId, ['101']);
    token = 'PAGE-TOKEN-B';
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const g2 = (await stack.oauth.complete(stack.actor, 'facebook', {
      state: authorizationUrl.searchParams.get('state')!,
      code: 'c',
    })) as { grantId: string };
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'facebook', g2.grantId);
    expect(listed.ok && listed.accounts[0]!.connection).toBe('this_brand');
    const second = await stack.oauth.connectAccounts(stack.actor, 'facebook', g2.grantId, ['101']);
    expect(second.ok && second.results[0]).toMatchObject({
      status: 'reconnected',
      connectionId: first.ok && first.results[0]!.connectionId,
    });
    const scope = scopeOf(stack, second.ok ? second.results[0]!.connectionId! : '');
    expect((await stack.vault.readTokens(scope)).access?.value.reveal()).toBe('PAGE-TOKEN-B');
  });

  it('rejects empty, oversized and malformed id lists without consuming the grant', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    for (const ids of [[], Array.from({ length: 51 }, (_, i) => `${i}`), ['a\nb']])
      expect(await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ids)).toEqual({
        ok: false,
        reason: 'rejected',
      });
    expect(
      (await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101'])).ok,
    ).toBe(true);
  });

  it('reports platform_error when the connector returns malformed accounts', async () => {
    const bad = () => [{ ...page('101'), accessToken: 'PAGE-TOKEN-PLAIN' as never }];
    const { stack, state } = await setup(SCOPES, bad);
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    expect(await stack.oauth.listGrantAccounts(stack.actor, 'facebook', g.grantId)).toEqual({
      ok: false,
      reason: 'platform_error',
    });
    expect(stack.lines.join('\n')).not.toContain('PAGE-TOKEN');
  });

  it('an expired grant is rejected', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    now += 1_800_001;
    expect(await stack.oauth.listGrantAccounts(stack.actor, 'facebook', g.grantId)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101'])).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});

describe('review mode on connect', () => {
  const grant = async (stack: Awaited<ReturnType<typeof setup>>['stack']) => {
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const g = await stack.oauth.complete(stack.actor, 'facebook', {
      state: authorizationUrl.searchParams.get('state')!,
      code: 'c',
    });
    return (g as { grantId: string }).grantId;
  };

  it('a first connect starts a 168h window and reports it', async () => {
    const { stack } = await setup();
    const r = await stack.oauth.connectAccounts(stack.actor, 'facebook', await grant(stack), [
      '101',
      '102',
    ]);
    expect(r.ok && r.results).toEqual([
      expect.objectContaining({
        status: 'connected',
        reviewMode: { state: 'active', endsAt: new Date(now + 168 * 3_600_000).toISOString() },
      }),
      expect.objectContaining({ status: 'not_eligible', reviewMode: null }),
    ]);
  });

  it('passes the opt-out to a first activation only', async () => {
    const { stack } = await setup();
    const first = await stack.oauth.connectAccounts(
      stack.actor,
      'facebook',
      await grant(stack),
      ['101'],
      { reviewMode: 'opted_out' },
    );
    expect(first.ok && first.results[0]!.reviewMode).toEqual({ state: 'opted_out', endsAt: null });

    const { stack: s2 } = await setup();
    const start = now;
    await s2.oauth.connectAccounts(s2.actor, 'facebook', await grant(s2), ['101']);
    const activate = vi.spyOn(s2.directory, 'activate');
    const again = await s2.oauth.connectAccounts(s2.actor, 'facebook', await grant(s2), ['101'], {
      reviewMode: 'opted_out',
    });
    expect(activate).toHaveBeenCalledWith(expect.anything(), s2.actor.userId, {
      reviewMode: 'opted_out',
    });
    expect(again.ok && again.results[0]).toMatchObject({
      status: 'reconnected',
      reviewMode: { state: 'active', endsAt: new Date(start + 168 * 3_600_000).toISOString() },
    });
  });
});

describe('a failed token write or activation does not leave the page held', () => {
  it('revokes the fresh pending row when the token write throws', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    stack.faults.failNextAccessWrite();
    await expect(
      stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101']),
    ).rejects.toThrow('simulated storage failure');
    expect(await stack.directory.findLiveByAccount('facebook', '101')).toBeNull();
    // another workspace can now connect the page
    await expect(
      stack.directory.upsertPending({
        organizationId: 'org-z',
        brandId: 'brand-z',
        platform: 'facebook',
        externalAccountId: '101',
        displayName: null,
        grantedScopes: [],
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('revokes the fresh pending row when activation is refused', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    vi.spyOn(stack.directory, 'activate').mockResolvedValueOnce({
      activated: false,
      reviewMode: { state: 'off', endsAt: null, changed: false },
    });
    const r = await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101']);
    expect(r.ok && r.results[0]!.status).toBe('connection_inactive');
    expect(await stack.directory.findLiveByAccount('facebook', '101')).toBeNull();
  });

  it('leaves an already-live connection alone when a reconnect write fails', async () => {
    const { stack, state } = await setup();
    const g1 = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    const first = await stack.oauth.connectAccounts(stack.actor, 'facebook', g1.grantId, ['101']);
    const id = first.ok ? first.results[0]!.connectionId! : '';
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const g2 = (await stack.oauth.complete(stack.actor, 'facebook', {
      state: authorizationUrl.searchParams.get('state')!,
      code: 'c',
    })) as { grantId: string };
    stack.faults.failNextAccessWrite();
    await expect(
      stack.oauth.connectAccounts(stack.actor, 'facebook', g2.grantId, ['101']),
    ).rejects.toThrow();
    expect((await stack.directory.load(scopeOf(stack, id)))?.status).toBe('active');
  });
});

describe('cross-user / cross-brand use', () => {
  it('another user cannot complete the state, and it stays usable for the owner', async () => {
    const { stack, state } = await setup();
    stack.memberships.grant!(stack.actor.organizationId, stack.actor.brandId, 'user-b', 'admin');
    const other = await stack.oauth.completeForUser('user-b', 'facebook', { state, code: 'c' });
    expect(other).toEqual({ actor: null, completion: { ok: false, reason: 'rejected' } });
    const mine = await stack.oauth.completeForUser(stack.actor.userId, 'facebook', {
      state,
      code: 'c',
    });
    expect(mine.completion).toMatchObject({ ok: true, kind: 'account_selection' });
    expect(mine.actor).toEqual(stack.actor);
  });

  it('completeForUser rejects a state for another platform, a malformed or an unknown state', async () => {
    const { stack, state } = await setup();
    for (const [platform, q] of [
      ['youtube', { state, code: 'c' }],
      ['facebook', { state: 'short', code: 'c' }],
      ['facebook', { state: ['a'], code: 'c' }],
      ['facebook', { state: 'A'.repeat(43), code: 'c' }],
    ] as const)
      expect(await stack.oauth.completeForUser(stack.actor.userId, platform, q)).toEqual({
        actor: null,
        completion: { ok: false, reason: 'rejected' },
      });
    expect(
      (await stack.oauth.completeForUser(stack.actor.userId, 'facebook', { state, code: 'c' }))
        .completion,
    ).toMatchObject({ ok: true });
  });

  it('completeForUser rejects an expired state before consuming or exchanging', async () => {
    const { stack, state } = await setup();
    const consume = vi.spyOn(stack.states, 'consume');
    now += 600_001;
    expect(
      await stack.oauth.completeForUser(stack.actor.userId, 'facebook', { state, code: 'c' }),
    ).toEqual({ actor: null, completion: { ok: false, reason: 'rejected' } });
    expect(consume).not.toHaveBeenCalled();
  });

  it('a grant id is useless under another brand and is not consumed by the attempt', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    stack.memberships.grant!(stack.actor.organizationId, 'brand-b', stack.actor.userId, 'admin');
    const elsewhere = { ...stack.actor, brandId: 'brand-b' };
    expect(await stack.oauth.listGrantAccounts(elsewhere, 'facebook', g.grantId)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await stack.oauth.connectAccounts(elsewhere, 'facebook', g.grantId, ['101'])).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(
      (await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101'])).ok,
    ).toBe(true);
  });

  it('a grant id is useless for another user of the same brand', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    stack.memberships.grant!(stack.actor.organizationId, stack.actor.brandId, 'user-b', 'admin');
    const other = { ...stack.actor, userId: 'user-b' };
    expect(await stack.oauth.listGrantAccounts(other, 'facebook', g.grantId)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await stack.oauth.connectAccounts(other, 'facebook', g.grantId, ['101'])).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(
      (await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101'])).ok,
    ).toBe(true);
  });

  it('a member (no connection.manage) is rejected', async () => {
    const { stack, state } = await setup();
    const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
      grantId: string;
    };
    stack.memberships.grant!(
      stack.actor.organizationId,
      stack.actor.brandId,
      stack.actor.userId,
      'member',
    );
    expect(await stack.oauth.listGrantAccounts(stack.actor, 'facebook', g.grantId)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101'])).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});

it('marks pages connected elsewhere and refuses to connect them', async () => {
  const { stack, state } = await setup();
  await stack.directory.upsertPending({
    organizationId: 'org-z',
    brandId: 'brand-z',
    platform: 'facebook',
    externalAccountId: '101',
    displayName: null,
    grantedScopes: [],
  });
  const g = (await stack.oauth.complete(stack.actor, 'facebook', { state, code: 'c' })) as {
    grantId: string;
  };
  const listed = await stack.oauth.listGrantAccounts(stack.actor, 'facebook', g.grantId);
  expect(listed.ok && listed.accounts[0]!.connection).toBe('elsewhere');
  const r = await stack.oauth.connectAccounts(stack.actor, 'facebook', g.grantId, ['101']);
  expect(r.ok && r.results[0]!.status).toBe('connected_elsewhere');
});
