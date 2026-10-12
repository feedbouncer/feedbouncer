import { expect, it } from 'vitest';
import { createInMemoryHarness } from './testing/index.js';

it('a contended refresh logs one refresh and one line per waiter', async () => {
  const h = await createInMemoryHarness('poll');
  const account = await h.driver.createAccount();
  const { authorizationUrl } = await h.stack.oauth.start(h.stack.actor, h.connector.platform);
  const q = await h.driver.consent(authorizationUrl, account);
  const done = await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q);
  if (!done.ok) throw new Error(done.reason);
  const scope = {
    organizationId: h.stack.actor.organizationId,
    brandId: h.stack.actor.brandId,
    connectionId: done.connectionId,
  };
  await h.driver.expireAccessTokens();
  const client = await h.stack.runtime.connect(scope);
  const src = await h.driver.seedSource(account);
  await Promise.all(
    [1, 2, 3].map(() => client.listComments({ sourceExternalId: src, cursor: null })),
  );
  const msgs = h.stack.lines.map((l) => JSON.parse(l).msg as string);
  expect(msgs.filter((m) => m === 'access token refreshed')).toHaveLength(1);
  expect(
    msgs.filter((m) => m === 'token refresh joined' || m === 'token refresh reused'),
  ).toHaveLength(2);
  expect(await h.driver.calls('refresh')).toBe(1);
});
