import { expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MemorySyncRecorder } from '@feedbouncer/connectors';
import { assembleStack, createInMemoryHarness } from '@feedbouncer/connectors/testing';
import { createLogger, errorFields, withSpan } from '@feedbouncer/service-runtime';
import {
  createMetrics,
  initTracing,
  loadTelemetryConfig,
  promConnectorObserver,
  promWebhookObserver,
} from './index.js';
import { resetTracingForTests } from './testing/index.js';

it('known secrets, auth headers and comment bodies never reach logs, spans or metrics', async () => {
  const exporter = new InMemorySpanExporter();
  resetTracingForTests();
  const logLines: string[] = [];
  const log = createLogger('worker', 'debug', (l) => logLines.push(l));
  initTracing(loadTelemetryConfig({}, 'worker'), log, {
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const metrics = createMetrics('worker');
    const h = await createInMemoryHarness('push');
    const stack = assembleStack(h.connector, h.stack, h.stack.redirectUri, {
      clock: h.stack.clock,
      observer: promConnectorObserver(metrics),
      webhookObserver: promWebhookObserver(metrics),
      sync: new MemorySyncRecorder(),
    });
    // connect, read, act, force a refresh, a throttle, and two webhook deliveries
    const account = await h.driver.createAccount();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, h.connector.platform);
    const done = await stack.oauth.complete(
      stack.actor,
      h.connector.platform,
      await h.driver.consent(authorizationUrl, account),
    );
    if (!done.ok) throw new Error(done.reason);
    const scope = {
      organizationId: stack.actor.organizationId,
      brandId: stack.actor.brandId,
      connectionId: done.connectionId,
    };
    const client = await stack.runtime.connect(scope);
    const src = await h.driver.seedSource(account);
    const ids = await h.driver.seedComments(account, src, 3);
    const page = await client.listComments({ sourceExternalId: src, cursor: null });
    await client.getComment({ sourceExternalId: src, externalId: ids[0]! });
    await h.driver.expireAccessTokens();
    await client.act({
      action: 'hide',
      target: { sourceExternalId: src, externalId: ids[1]! },
    });
    await h.driver.throttleNext(5);
    await client.listComments({ sourceExternalId: src, cursor: null }).catch(() => undefined);
    const signed = await h.driver.signedDelivery(account, ids[2]!, src);
    for (let i = 0; i < 2; i++) {
      await stack.webhooks.handle(
        {
          platform: h.connector.platform,
          connectionId: null,
          headers: signed.headers,
          rawBody: signed.rawBody,
        },
        async () => {},
      );
    }
    // an error whose message embeds a token
    await withSpan('job.run', {}, async () => {
      log.error(
        'boom',
        errorFields(
          new Error('failed token=SENTINEL-TOKEN-1 Authorization: Bearer SENTINEL-BEARER'),
        ),
      );
    });

    const secrets = [
      ...(await h.driver.issuedSecrets()),
      ...page.items.map((c) => c.body).filter((b) => b.length >= 8),
      signed.headers['x-ref-signature']!.replace(/^sha256=/, ''),
      'SENTINEL-TOKEN-1',
      'SENTINEL-BEARER',
    ];
    expect(secrets.length).toBeGreaterThan(4);
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(3);
    const haystack = [
      ...logLines,
      ...stack.lines,
      ...spans.map((s) =>
        JSON.stringify({ n: s.name, a: s.attributes, e: s.events, st: s.status, l: s.links }),
      ),
      await metrics.registry.metrics(),
    ].join('\n');
    for (const s of secrets) expect(haystack, `leaked: ${s.slice(0, 6)}...`).not.toContain(s);
  } finally {
    resetTracingForTests();
  }
});
