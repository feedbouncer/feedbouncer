import { describe, expect, it } from 'vitest';
import { FakeGraph } from './testing/index.js';
import { subscribePageFields, unsubscribePageFields } from './subscriptions.js';
import { pageCall } from './testing/calls.js';

const APP = '123456';
function setup() {
  const graph = new FakeGraph({ appSecret: 's'.repeat(32), appId: APP });
  const { userId } = graph.addUser();
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE', 'MESSAGING'] });
  return { graph, pageId, call: pageCall(graph, pageToken) };
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
