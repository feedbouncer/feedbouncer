import { afterEach, beforeEach, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { assembleStack, createInMemoryHarness } from './testing/index.js';
import { MemorySyncRecorder, type ConnectorCallEvent } from './index.js';

const exporter = new InMemorySpanExporter();
beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterEach(() => {
  exporter.reset();
  trace.disable();
  context.disable();
  propagation.disable();
});

async function connected(flavor: 'push' | 'poll') {
  const h = await createInMemoryHarness(flavor);
  const calls: ConnectorCallEvent[] = [];
  const sync = new MemorySyncRecorder();
  const stack = assembleStack(h.connector, h.stack, h.stack.redirectUri, {
    clock: h.stack.clock,
    observer: { onCall: (e) => calls.push(e) },
    sync,
  });
  const account = await h.driver.createAccount();
  const { authorizationUrl } = await stack.oauth.start(stack.actor, h.connector.platform);
  const { code, state } = await h.driver.consent(authorizationUrl, account);
  const done = await stack.oauth.complete(stack.actor, h.connector.platform, { code, state });
  if (!done.ok) throw new Error(done.reason);
  const scope = {
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    connectionId: done.connectionId,
  };
  return { h, stack, account, scope, calls, sync, client: await stack.runtime.connect(scope) };
}

it('a read emits a client span, an ok observation and a sync success', async () => {
  const { h, account, client, calls, sync, scope } = await connected('poll');
  const src = await h.driver.seedSource(account);
  await h.driver.seedComments(account, src, 2);
  await client.listComments({ sourceExternalId: src, cursor: null });
  const span = exporter.getFinishedSpans().find((s) => s.name === 'connector.list_comments')!;
  expect(span.kind).toBe(2 /* CLIENT */);
  expect(span.attributes).toMatchObject({
    'feedbouncer.platform': h.connector.platform,
    'feedbouncer.connector.id': scope.connectionId,
  });
  expect(calls.at(-1)).toMatchObject({ operation: 'list_comments', outcome: 'ok' });
  expect(sync.events.at(-1)).toEqual({
    connectionId: scope.connectionId,
    kind: 'success',
  });
});

it('an idle poll (zero comments) still records a sync success', async () => {
  const { h, account, client, sync } = await connected('poll');
  const src = await h.driver.seedSource(account);
  await client.listComments({ sourceExternalId: src, cursor: null });
  expect(sync.events.filter((e) => e.kind === 'success')).toHaveLength(1);
});

it('a throttled call records a rate_limited failure and an error span', async () => {
  const { h, account, client, calls, sync } = await connected('poll');
  const src = await h.driver.seedSource(account);
  await h.driver.throttleNext(30);
  await expect(client.listComments({ sourceExternalId: src, cursor: null })).rejects.toMatchObject({
    kind: 'rate_limited',
  });
  expect(calls.at(-1)?.outcome).toBe('rate_limited');
  expect(sync.events.at(-1)).toMatchObject({ kind: 'failure', errorClass: 'rate_limited' });
  const span = exporter.getFinishedSpans().find((s) => s.name === 'connector.list_comments')!;
  expect(span.status.code).toBe(2);
});

it('act emits moderation.apply with the outcome and reversibility', async () => {
  const { h, account, client } = await connected('poll');
  const src = await h.driver.seedSource(account);
  const [id] = await h.driver.seedComments(account, src, 1);
  const r = await client.act({
    action: 'hide',
    target: { sourceExternalId: src, externalId: id! },
  });
  const span = exporter.getFinishedSpans().find((s) => s.name === 'moderation.apply')!;
  expect(span.attributes).toMatchObject({
    'feedbouncer.action': 'hide',
    'feedbouncer.action.status': r.status,
    'feedbouncer.action.reversible': r.status === 'applied' && r.undo !== null,
  });
});

it('a missing comment (not_found) is a successful read, not a sync failure', async () => {
  const { h, account, client, sync } = await connected('poll');
  const src = await h.driver.seedSource(account);
  const [id] = await h.driver.seedComments(account, src, 1);
  await h.driver.deleteComment(src, id!);
  expect(await client.getComment({ sourceExternalId: src, externalId: id! })).toBeNull();
  expect(sync.events.some((e) => e.kind === 'failure')).toBe(false);
});

it('an observer or recorder that throws never fails the call', async () => {
  const h = await createInMemoryHarness('poll');
  const stack = assembleStack(h.connector, h.stack, h.stack.redirectUri, {
    clock: h.stack.clock,
    observer: {
      onCall: () => {
        throw new Error('observer down');
      },
    },
    sync: {
      success: async () => {
        throw new Error('db down');
      },
      failure: async () => {
        throw new Error('db down');
      },
    },
  });
  const account = await h.driver.createAccount();
  const { authorizationUrl } = await stack.oauth.start(stack.actor, h.connector.platform);
  const q = await h.driver.consent(authorizationUrl, account);
  const done = await stack.oauth.complete(stack.actor, h.connector.platform, q);
  if (!done.ok) throw new Error(done.reason);
  const client = await stack.runtime.connect({
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    connectionId: done.connectionId,
  });
  const src = await h.driver.seedSource(account);
  await expect(client.listComments({ sourceExternalId: src, cursor: null })).resolves.toBeDefined();
  await new Promise((r) => setImmediate(r));
  expect(stack.lines.some((l) => l.includes('telemetry.sync_record_failed'))).toBe(true);
});
