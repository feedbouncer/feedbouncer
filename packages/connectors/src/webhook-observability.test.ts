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
import { MemorySyncRecorder, type WebhookDeliveryEvent } from './index.js';

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

async function pushStack() {
  const h = await createInMemoryHarness('push');
  const deliveries: WebhookDeliveryEvent[] = [];
  const sync = new MemorySyncRecorder();
  const stack = assembleStack(h.connector, h.stack, h.stack.redirectUri, {
    clock: h.stack.clock,
    webhookObserver: { onDelivery: (e) => deliveries.push(e) },
    sync,
  });
  const account = await h.driver.createAccount();
  const src = await h.driver.seedSource(account);
  const [cid] = await h.driver.seedComments(account, src, 1);
  return { h, stack, account, src, cid: cid!, deliveries, sync };
}

it('an accepted delivery is a root SERVER span; a redelivery is a duplicate and not re-counted', async () => {
  const { h, stack, account, src, cid, deliveries } = await pushStack();
  const signed = await h.driver.signedDelivery(account, cid, src);
  let delivered = 0;
  const req = {
    platform: h.connector.platform,
    connectionId: null,
    headers: signed.headers,
    rawBody: signed.rawBody,
  };
  expect(
    await stack.webhooks.handle(req, async () => {
      delivered++;
    }),
  ).toMatchObject({ status: 'accepted' });
  expect(
    await stack.webhooks.handle(req, async () => {
      delivered++;
    }),
  ).toEqual({ status: 'duplicate' });
  expect(delivered).toBe(1);
  expect(deliveries.map((d) => [d.outcome, d.eventCount])).toEqual([
    ['accepted', 1],
    ['duplicate', 0],
  ]);
  const spans = exporter.getFinishedSpans().filter((s) => s.name === 'webhook.receive');
  expect(spans).toHaveLength(2);
  for (const s of spans) {
    expect(s.kind).toBe(1 /* SERVER */);
    expect(s.parentSpanContext).toBeUndefined();
  }
  expect(spans.map((s) => s.attributes['feedbouncer.webhook.outcome'])).toEqual([
    'accepted',
    'duplicate',
  ]);
  const dup = stack.lines
    .map((l) => JSON.parse(l))
    .find((o) => o.msg === 'duplicate webhook delivery skipped');
  expect(dup.trace_id).toBe(spans[1]!.spanContext().traceId);
});

it('labels unknown platforms as unknown', async () => {
  const { stack, deliveries } = await pushStack();
  await stack.webhooks.handle(
    { platform: 'evil"label{x}', connectionId: null, headers: {}, rawBody: Buffer.from('{}') },
    async () => {},
  );
  expect(deliveries.at(-1)).toMatchObject({ platform: 'unknown', outcome: 'rejected' });
});

it('clamps future occurredAt to zero delay and counts the skew', async () => {
  const { h, stack, account, src, cid, deliveries } = await pushStack();
  // The reference connector's toleranceSec is 300 and parse() derives occurredAt from the signed ts.
  const future = Math.floor(stack.clock.now() / 1000) + 60;
  const signed = await h.driver.signedDelivery(account, cid, src, { tsSec: future });
  const out = await stack.webhooks.handle(
    {
      platform: h.connector.platform,
      connectionId: null,
      headers: signed.headers,
      rawBody: signed.rawBody,
    },
    async () => {},
  );
  expect(out.status).toBe('accepted');
  const d = deliveries.at(-1)!;
  expect(d.eventDelaysMs).toEqual([0]);
  expect(d.negativeSkews).toBe(1);
  expect(stack.lines.some((l) => l.includes('telemetry.negative_lag'))).toBe(true);
});

it('an app-secret delivery records no sync, even with a caller-chosen connection id', async () => {
  const { h, stack, account, src, cid, sync } = await pushStack();
  const signed = await h.driver.signedDelivery(account, cid, src);
  const out = await stack.webhooks.handle(
    {
      platform: h.connector.platform,
      connectionId: '00000000-0000-4000-8000-000000000000',
      headers: signed.headers,
      rawBody: signed.rawBody,
    },
    async () => {},
  );
  expect(out.status).toBe('accepted');
  await new Promise((r) => setImmediate(r));
  expect(sync.events).toEqual([]);
});
