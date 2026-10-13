import { describe, expect, it } from 'vitest';
import { createSafeHttp } from '@feedbouncer/connectors';
import { GRAPH_HOST } from './graph.js';
import { FakeGraph } from './testing/index.js';
import { subscribePageFields, unsubscribePageFields } from './subscriptions.js';
import { pageCall } from './testing/calls.js';

const APP = '123456';
function setup() {
  const graph = new FakeGraph({ appSecret: 's'.repeat(32), appId: APP });
  const { userId } = graph.addUser();
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE', 'MESSAGING'] });
  return { graph, pageId, pageToken, call: pageCall(graph, pageToken) };
}

describe('page subscriptions merge fields', () => {
  it('adds without dropping existing fields', async () => {
    const { graph, pageId, call } = setup();
    await subscribePageFields(call, pageId, APP, ['feed']);
    await subscribePageFields(call, 'me', APP, ['comments']);
    expect([...graph.subscribedFields(pageId)].sort()).toEqual(['comments', 'feed']);
  });

  it('is idempotent', async () => {
    const { graph, pageId, call } = setup();
    await subscribePageFields(call, pageId, APP, ['feed']);
    await subscribePageFields(call, pageId, APP, ['feed']);
    expect(graph.subscribedFields(pageId)).toEqual(['feed']);
  });

  it('merges fields and only deletes when empty', async () => {
    const { graph, pageId, call } = setup();
    await subscribePageFields(call, pageId, APP, ['feed', 'comments']);
    expect(await unsubscribePageFields(call, pageId, APP, ['comments'])).toEqual({
      fields: ['feed'],
      deleted: false,
    });
    expect(graph.subscribed(pageId)).toBe(true);
    expect(await unsubscribePageFields(call, pageId, APP, ['feed'])).toEqual({
      fields: [],
      deleted: true,
    });
    expect(graph.subscribed(pageId)).toBe(false);
  });

  it('unsubscribing when not subscribed is a no-op', async () => {
    const { pageId, call } = setup();
    expect(await unsubscribePageFields(call, pageId, APP, ['feed'])).toEqual({
      fields: [],
      deleted: false,
    });
  });

  it('ignores other apps on the page', async () => {
    const { graph, pageId, call } = setup();
    graph.setOtherAppSubscription(pageId, '999999', ['feed', 'messages']);
    await subscribePageFields(call, pageId, APP, ['comments']);
    expect(graph.subscribedFields(pageId)).toEqual(['comments']);
  });

  it('rejects hostile field names before any network call', async () => {
    const { pageId, call, graph } = setup();
    const before = graph.calls().length;
    await expect(
      subscribePageFields(call, pageId, APP, ['feed&access_token=x']),
    ).rejects.toMatchObject({
      code: 'invalid_field',
    });
    expect(graph.calls().length).toBe(before);
  });
});

/**
 * A GraphCall over the fake whose fetch lets a test run `after` once a request
 * of this app reaches the fake, simulating another writer on the same Page.
 */
function interleavedCall(
  graph: FakeGraph,
  token: string,
  after: (method: string, path: string) => void,
) {
  const base = pageCall(graph, token);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await graph.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    after((init?.method ?? 'GET').toUpperCase(), url.pathname);
    return res;
  };
  return { ...base, http: createSafeHttp({ allowedHosts: [GRAPH_HOST], fetch }) };
}

describe('page subscriptions under a concurrent writer', () => {
  it('re-adds its field when another connection replaced the list with a stale read', async () => {
    const { graph, pageId, pageToken } = setup();
    let raced = false;
    const call = interleavedCall(graph, pageToken, (method, path) => {
      // The other connection read [] before our POST and now writes its own list.
      if (!raced && method === 'POST' && path.endsWith('/subscribed_apps')) {
        raced = true;
        graph.setSubscription(pageId, APP, ['comments']);
      }
    });
    await subscribePageFields(call, pageId, APP, ['feed']);
    expect([...graph.subscribedFields(pageId)].sort()).toEqual(['comments', 'feed']);
  });

  it('removes its field again when another connection wrote it back', async () => {
    const { graph, pageId, pageToken } = setup();
    graph.setSubscription(pageId, APP, ['feed']);
    let raced = false;
    const call = interleavedCall(graph, pageToken, (method, path) => {
      if (!raced && method === 'DELETE' && path.endsWith('/subscribed_apps')) {
        raced = true;
        graph.setSubscription(pageId, APP, ['comments', 'feed']);
      }
    });
    expect(await unsubscribePageFields(call, pageId, APP, ['feed'])).toEqual({
      fields: ['comments'],
      deleted: false,
    });
    expect(graph.subscribedFields(pageId)).toEqual(['comments']);
  });

  it('gives up with a transient error when the list never settles', async () => {
    const { graph, pageId, pageToken } = setup();
    const call = interleavedCall(graph, pageToken, (method, path) => {
      if (method === 'POST' && path.endsWith('/subscribed_apps')) {
        graph.setSubscription(pageId, APP, ['comments']);
      }
    });
    await expect(subscribePageFields(call, pageId, APP, ['feed'])).rejects.toMatchObject({
      kind: 'transient',
      code: 'subscription_not_converged',
    });
    expect(graph.calls().filter((c) => c.method === 'POST').length).toBe(3);
  });
});
