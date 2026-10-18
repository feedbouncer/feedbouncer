import { expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MemorySyncRecorder } from '@feedbouncer/connectors';
import { assembleStack, createInMemoryHarness } from '@feedbouncer/connectors/testing';
import { createLogger, errorFields, withSpan } from '@feedbouncer/service-runtime';
import {
  createMetrics,
  deriveConnectionHealth,
  initTracing,
  loadHealthPolicy,
  loadTelemetryConfig,
  promConnectorObserver,
  promWebhookObserver,
  registerConnectorHealthMetrics,
  type ConnectionFacts,
} from './index.js';
import { resetTracingForTests } from './testing/index.js';

it('known secrets, auth headers and comment bodies never reach logs, spans, metrics or health', async () => {
  const exporter = new InMemorySpanExporter();
  resetTracingForTests();
  const logLines: string[] = [];
  const log = createLogger('worker', 'debug', (l) => logLines.push(l));
  initTracing(loadTelemetryConfig({}, 'worker'), log, {
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const metrics = createMetrics('worker');
    const sync = new MemorySyncRecorder();
    const h = await createInMemoryHarness('push');
    const common = {
      clock: h.stack.clock,
      observer: promConnectorObserver(metrics),
      webhookObserver: promWebhookObserver(metrics),
      sync,
    };
    const stack = assembleStack(h.connector, h.stack, h.stack.redirectUri, common);
    const account = await h.driver.createAccount();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, h.connector.platform);
    const done = await stack.oauth.complete(
      stack.actor,
      h.connector.platform,
      await h.driver.consent(authorizationUrl, account),
    );
    if (!done.ok) throw new Error(done.reason);
    if (done.kind !== 'connected') throw new Error(done.kind);
    const scope = {
      organizationId: stack.actor.organizationId,
      brandId: stack.actor.brandId,
      connectionId: done.connectionId,
    };
    const client = await stack.runtime.connect(scope);
    const src = await h.driver.seedSource(account);
    const ids = await h.driver.seedComments(account, src, 4);
    const target = (i: number) => ({ sourceExternalId: src, externalId: ids[i]! });
    const page = await client.listComments({ sourceExternalId: src, cursor: null });
    await client.getComment(target(0));

    // A connector whose own errors embed the live access token, the refresh token and the webhook
    // secret (every secret the platform has minted). Armed through the same ports and observers.
    const thrown: string[] = [];
    const leakyStack = assembleStack(
      {
        ...h.connector,
        act: async (ctx) => {
          const minted = (await h.driver.issuedSecrets()).map((s) => `secret=${s}`);
          const msg = `POST https://api.reference.test/x?access_token=${ctx.accessToken.reveal()} ${minted.join(' ')} Authorization: Bearer SENTINEL-BEARER`;
          thrown.push(msg);
          throw new Error(msg);
        },
        listComments: async (ctx) => {
          const msg = `bad token ${ctx.accessToken.reveal()} refresh_token=SENTINEL-REFRESH-1`;
          thrown.push(msg);
          throw Object.assign(new Error(msg), { name: 'Oops' });
        },
      },
      h.stack,
      h.stack.redirectUri,
      common,
    );
    await h.driver.expireAccessTokens(); // the leaky calls run after a forced refresh
    const leaky = await leakyStack.runtime.connect(scope);
    const leakedAct = await leaky.act({ action: 'hide', target: target(1) });
    expect(leakedAct.status).toBe('failed');
    await expect(leaky.listComments({ sourceExternalId: src, cursor: null })).rejects.toBeDefined();
    expect(thrown).toHaveLength(2);

    // A normal action succeeds, then the platform throttles the next one.
    expect((await client.act({ action: 'hide', target: target(2) })).status).toBe('applied');
    await h.driver.throttleNext(5);
    const throttled = await client.act({ action: 'hide', target: target(3) });
    expect(throttled).toMatchObject({ status: 'failed', error: { kind: 'rate_limited' } });
    await expect(
      client.listComments({ sourceExternalId: src, cursor: null }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });

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
    // The job failure path: the failure's message embeds tokens and is logged inside a job span.
    const jobError = new Error(
      'failed token=SENTINEL-TOKEN-1 Authorization: Bearer SENTINEL-BEARER ' + thrown[0]!,
    );
    await withSpan('job.run', {}, async () => {
      log.error('boom', errorFields(jobError));
    });

    // Health derived from what the sync recorder saw, served through the gauges and as a response.
    const failures = sync.events.filter((e) => e.kind === 'failure');
    expect(failures.length).toBeGreaterThan(0);
    const facts: ConnectionFacts = {
      connectionId: scope.connectionId,
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      platform: h.connector.platform,
      status: 'active',
      statusReason: null,
      lastSuccessAt: new Date(),
      lastFailureAt: new Date(),
      lastErrorCode: failures.at(-1)!.code ?? null,
      consecutiveFailures: failures.length,
      oldestQueuedAt: null,
      accessTokenExpiresAt: null,
      hasAccessToken: true,
      refreshTokenExpiresAt: null,
      hasRefreshToken: true,
      failedImports: 0,
    };
    const health = deriveConnectionHealth(facts, loadHealthPolicy({}), new Date());
    registerConnectorHealthMetrics(
      metrics,
      { forBrand: async () => [health], all: async () => ({ rows: [health], truncated: false }) },
      { maxSeries: 10, cacheMs: 0, log },
    );

    const secrets = [
      ...(await h.driver.issuedSecrets()),
      ...page.items.map((c) => c.body).filter((b) => b.length >= 8),
      signed.headers['x-ref-signature']!.replace(/^sha256=/, ''),
      'SENTINEL-TOKEN-1',
      'SENTINEL-BEARER',
      'SENTINEL-REFRESH-1',
    ];
    expect(secrets.length).toBeGreaterThan(6);
    // The sentinels really were in the thrown errors, i.e. they reached the code under test ...
    for (const s of (await h.driver.issuedSecrets()).slice(0, 3)) {
      expect(thrown.join('\n')).toContain(s);
    }
    // ... and the one place a message is logged shows them masked.
    const boom = logLines.find((l) => l.includes('"msg":"boom"'))!;
    expect(boom).toContain('[redacted]');

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['moderation.apply', 'connector.act', 'job.run']));
    expect(spans.some((s) => s.status.code === 2)).toBe(true);
    const haystack = [
      ...logLines,
      ...stack.lines,
      ...leakyStack.lines,
      ...spans.map((s) =>
        JSON.stringify({
          n: s.name,
          a: s.attributes,
          e: s.events,
          st: s.status,
          l: s.links,
        }),
      ),
      await metrics.registry.metrics(),
      JSON.stringify(health),
    ].join('\n');
    for (const s of secrets) expect(haystack, `leaked: ${s.slice(0, 6)}...`).not.toContain(s);
  } finally {
    resetTracingForTests();
  }
});
