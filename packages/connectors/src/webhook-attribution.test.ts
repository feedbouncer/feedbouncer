import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Secret, createLogger, type Logger } from '@feedbouncer/service-runtime';
import type { Connector } from './connector.js';
import { MemoryDeliveryLedger, MemorySyncRecorder, StaticWebhookSecrets } from './memory.js';
import { ConnectorRegistry } from './registry.js';
import { createReferenceConnector } from './reference/connector.js';
import { InMemoryPlatform } from './reference/platform.js';
import { systemClock } from './clock.js';
import { WebhookGate, type InboundWebhook, type WebhookDeliveryEvent } from './webhook.js';

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

const CONN = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const SECRET = 'conn-secret-attribution';
const NOW = Date.parse('2026-10-12T10:00:00Z');

function perConnectionConnector(): Connector {
  const platform = new InMemoryPlatform({
    clock: systemClock,
    rotateRefreshTokens: false,
    accessTokenTtlMs: 3_600_000,
    webhookSecret: 'unused',
    redirectUri: 'https://app.feedbouncer.test/cb',
  });
  const c = createReferenceConnector(platform, {
    flavor: 'push',
    redirectUri: 'https://app.feedbouncer.test/cb',
  });
  return { ...c, webhook: { ...c.webhook!, secretSource: 'connection' } };
}

function delivery(secret: string, connectionId: string): InboundWebhook {
  const ts = Math.floor(NOW / 1000);
  const rawBody = Buffer.from(
    JSON.stringify({ events: [{ account: 'acct-y', source: 's1', comment: 'c1', ts }] }),
  );
  const mac = createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  return {
    platform: 'facebook',
    connectionId,
    rawBody,
    headers: { 'x-ref-signature': `sha256=${mac}`, 'x-ref-timestamp': String(ts) },
  };
}

function build(log: Logger, opts: Partial<ConstructorParameters<typeof WebhookGate>[0]> = {}) {
  const registry = new ConnectorRegistry();
  registry.register(perConnectionConnector());
  return new WebhookGate({
    registry,
    secrets: new StaticWebhookSecrets(
      new Map(),
      new Map([
        [CONN, { secret: new Secret(SECRET), externalAccountId: 'acct-y', platform: 'facebook' }],
      ]),
    ),
    ledger: new MemoryDeliveryLedger(),
    clock: { now: () => NOW },
    log,
    ...opts,
  });
}
function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger('test', 'debug', (l) => lines.push(l)) };
}
const throwingLogger = (): Logger => {
  const boom = () => {
    throw new Error('logger down');
  };
  const l = { debug: boom, info: boom, warn: boom, error: boom, child: () => l };
  return l as unknown as Logger;
};

describe('webhook attribution', () => {
  it('a rejected delivery naming a foreign connection id is attributed to nobody', async () => {
    const { lines, log } = capture();
    const out = await build(log).handle(delivery('wrong-secret', FOREIGN), async () => {});
    expect(out.status).toBe('rejected');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(FOREIGN);
    for (const s of exporter.getFinishedSpans())
      expect(JSON.stringify(s.attributes)).not.toContain(FOREIGN);
  });

  it('a rejected delivery for a real connection with a bad signature is not attributed either', async () => {
    const { lines, log } = capture();
    const out = await build(log).handle(delivery('wrong-secret', CONN), async () => {});
    expect(out.status).toBe('rejected');
    expect(lines.join('\n')).not.toContain(CONN);
  });

  it('a verified per-connection delivery carries its connection id on spans and later logs', async () => {
    const { lines, log } = capture();
    const g = build(log);
    const req = delivery(SECRET, CONN);
    expect((await g.handle(req, async () => {})).status).toBe('accepted');
    expect((await g.handle(req, async () => {})).status).toBe('duplicate');
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'webhook.receive');
    expect(spans.map((s) => s.attributes['feedbouncer.connector.id'])).toEqual([CONN, CONN]);
    const dup = lines
      .map((l) => JSON.parse(l))
      .find((o) => o.msg === 'duplicate webhook delivery skipped');
    expect(dup.connector_id).toBe(CONN);
    expect(dup.connector_type).toBe('facebook');
  });
});

describe('webhook telemetry never fails intake', () => {
  it('a throwing logger does not fail handle()', async () => {
    const g = build(throwingLogger());
    expect((await g.handle(delivery('wrong-secret', CONN), async () => {})).status).toBe(
      'rejected',
    );
    const ok = delivery(SECRET, CONN);
    expect((await g.handle(ok, async () => {})).status).toBe('accepted');
    expect((await g.handle(ok, async () => {})).status).toBe('duplicate');
  });

  it('a throwing observer does not fail handle()', async () => {
    const seen: WebhookDeliveryEvent[] = [];
    const g = build(capture().log, {
      observer: {
        onDelivery: (e) => {
          seen.push(e);
          throw new Error('observer down');
        },
      },
    });
    expect((await g.handle(delivery(SECRET, CONN), async () => {})).status).toBe('accepted');
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['rejecting', () => Promise.reject(new Error('db down'))],
    [
      'throwing',
      () => {
        throw new Error('db down');
      },
    ],
  ])('a %s sync recorder does not fail handle() and warns once', async (_n, fail) => {
    const { lines, log } = capture();
    const sync = {
      ...new MemorySyncRecorder(),
      success: fail as () => Promise<void>,
      failure: fail as () => Promise<void>,
    };
    const g = build(log, { sync });
    expect((await g.handle(delivery(SECRET, CONN), async () => {})).status).toBe('accepted');
    await new Promise((r) => setImmediate(r));
    const warns = lines
      .map((l) => JSON.parse(l))
      .filter((o) => o.level === 'warn' && String(o.msg).startsWith('telemetry.'));
    expect(warns.map((o) => o.msg)).toEqual(['telemetry.sync_record_failed']);
  });
});
