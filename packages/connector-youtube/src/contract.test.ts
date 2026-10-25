import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectorRuntime, createSafeHttp, type Connector } from '@feedbouncer/connectors';
import { createMemoryStack, type Stack } from '@feedbouncer/connectors/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { createYouTubeConnector } from './connector.js';
import { CHANNEL, CLIENT, NOW, memoryMeter } from './test-world.js';
import { FakeYouTube } from './testing/index.js';

// The generic conformance suite assumes one account per authorization, so (like Facebook and
// TikTok) this connector runs its own contract over FakeYouTube: channel selection, replay,
// secret hygiene, metered reads and batch writes through the runtime, and teardown.
const REDIRECT = 'https://app.test/api/v1/oauth/youtube/callback';
const VIEWER = 'UC' + 'v'.repeat(22);
let fake: FakeYouTube;
let stack: Stack;
let connector: Connector;
let project: ReturnType<typeof memoryMeter>;
let channelQuota: ReturnType<typeof memoryMeter>;

beforeEach(async () => {
  fake = new FakeYouTube({ ...CLIENT, channel: { id: CHANNEL, title: 'Mine' }, clock: () => NOW });
  project = memoryMeter();
  channelQuota = memoryMeter();
  connector = createYouTubeConnector(
    {
      clientId: CLIENT.clientId,
      clientSecret: new Secret(CLIENT.clientSecret),
      projectQuota: project.meter,
    },
    { clock: { now: () => NOW } },
  );
  stack = await createMemoryStack(connector, {
    webhookSecret: null,
    redirectUri: REDIRECT,
    clock: { now: () => NOW },
    fetch: fake.fetch,
  });
});

async function start() {
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'youtube');
  return new URL(authorizationUrl).searchParams.get('state')!;
}

async function connect() {
  const code = fake.authorize();
  const state = await start();
  const done = await stack.oauth.complete(stack.actor, 'youtube', { code, state });
  if (!done.ok || done.kind !== 'account_selection') throw new Error('grant failed');
  const r = await stack.oauth.connectAccounts(stack.actor, 'youtube', done.grantId, [CHANNEL]);
  const connectionId = r.ok ? r.results[0]!.connectionId! : '';
  const scope = {
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    connectionId,
  };
  return { code, state, r, scope };
}

/** A runtime like the stack's, but with a quota meter on every CallContext. */
function meteredRuntime() {
  return new ConnectorRuntime({
    registry: stack.registry,
    directory: stack.directory,
    vault: stack.vault,
    tokens: stack.tokens,
    budget: stack.budget,
    clock: stack.clock,
    log: stack.log,
    http: (c) => createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: fake.fetch }),
    quotaMeters: (platform) => (platform === 'youtube' ? channelQuota.meter : undefined),
  });
}

const apiCalls = () => fake.calls.filter((c) => !c.method.startsWith('oauth.'));

describe('YouTube connector contract', () => {
  it('registers with batched, budgeted moderation capabilities', () => {
    expect(stack.registry.require('youtube').capabilities).toMatchObject({
      actions: ['hide', 'unhide', 'delete', 'ban_author'],
      ingestion: 'polling',
      accountSelection: 'multiple',
      batchActions: { maxTargets: 50 },
      actionDispatch: 'budgeted',
      maxPageSize: 100,
      requiredScopes: ['youtube.force-ssl'],
    });
  });

  it('connects the authorised channel on the project meter and never logs a secret', async () => {
    const { code, state, r } = await connect();
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: CHANNEL, status: 'connected' }],
    });
    expect(project.reserved.every((x) => x.purpose === 'connect')).toBe(true);
    expect(project.reserved.length).toBeGreaterThan(0);
    const logs = stack.lines.join('\n');
    for (const secret of [CLIENT.clientSecret, code, state]) expect(logs).not.toContain(secret);
  });

  it('replaying an authorization code is refused', async () => {
    const { code } = await connect();
    const again = await stack.oauth.complete(stack.actor, 'youtube', {
      code,
      state: await start(),
    });
    expect(again).toMatchObject({ ok: false, reason: 'platform_error' });
  });

  it('a runtime without a quota meter makes no Data API call', async () => {
    const { scope } = await connect();
    const client = await stack.runtime.connect(scope);
    const before = apiCalls().length;
    await expect(
      client.listComments({ sourceExternalId: 'Ugz000000000001', cursor: null }),
    ).rejects.toMatchObject({ code: 'quota_meter_required' });
    expect(apiCalls()).toHaveLength(before);
  });

  it('reads, probes and moderates in batches through the metered runtime', async () => {
    const { scope } = await connect();
    const videoId = fake.addVideo();
    const top = fake.addComment({ videoId, authorChannelId: VIEWER, text: 'top' });
    const reply = fake.addComment({ parentId: top, authorChannelId: VIEWER, text: 'reply' });
    const client = await meteredRuntime().connect(scope);

    const replies = await client.listComments({ sourceExternalId: top, cursor: null });
    expect(replies.items.map((c) => c.externalId)).toEqual([reply]);
    expect(await client.getComment({ sourceExternalId: videoId, externalId: top })).toMatchObject({
      body: 'top',
      platformState: 'visible',
    });

    const targets = [
      { sourceExternalId: videoId, externalId: top },
      { sourceExternalId: videoId, externalId: reply },
    ];
    expect(await client.actBatch({ action: 'hide', targets })).toEqual({ status: 'applied' });
    expect((await client.probeComments(targets)).map((p) => p.state)).toEqual(['held', 'held']);
    expect(await client.actBatch({ action: 'ban_author', targets })).toEqual({
      status: 'applied',
    });
    expect((await client.probeComments(targets)).map((p) => p.state)).toEqual(['gone', 'gone']);
    expect(fake.isBanned(VIEWER)).toBe(true);

    expect(channelQuota.reserved.map((r) => r.units)).toEqual([1, 1, 50, 1, 50, 1]);
    expect(channelQuota.settled.every((s) => s.ok)).toBe(true);
  });

  it('disconnect revokes the grant at Google', async () => {
    const { scope } = await connect();
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('done');
    expect(fake.calls.filter((c) => c.method === 'oauth.revoke')).toHaveLength(1);
  });
});
