import { afterAll, beforeAll, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import {
  ConnectorError,
  ConnectorRegistry,
  MemoryDeliveryLedger,
  StaticWebhookSecrets,
  WebhookGate,
  systemClock,
} from '@feedbouncer/connectors';
import {
  InMemoryPlatform,
  createInMemoryHarness,
  createReferenceConnector,
} from '@feedbouncer/connectors/testing';
import { createJobsHarness, type JobsHarness } from '@feedbouncer/jobs/testing';
import { createLogger, Secret } from '@feedbouncer/service-runtime';
import {
  createMetrics,
  initTracing,
  loadTelemetryConfig,
  promJobSink,
  promWebhookObserver,
} from './index.js';
import { resetTracingForTests } from './testing/index.js';

const exporter = new InMemorySpanExporter();
let h: JobsHarness;
const metrics = createMetrics('worker');

beforeAll(async () => {
  resetTracingForTests();
  initTracing(
    loadTelemetryConfig({}, 'worker'),
    createLogger('t', 'error', () => {}),
    {
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    },
  );
  h = await createJobsHarness({ sink: promJobSink(metrics) });
});
afterAll(async () => {
  await h.cleanup();
  resetTracingForTests();
});

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

it('webhook -> enqueue -> run (retry) -> moderation.apply share one trace; duplicates do not double count', async () => {
  // 1. A signed-webhook platform for the intake side (app-level secret, so connectionId is null).
  const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
  const webhookSecret = 'e2e-webhook-secret-0123456789';
  const platform = new InMemoryPlatform({
    clock: systemClock,
    rotateRefreshTokens: false,
    accessTokenTtlMs: 3_600_000,
    webhookSecret,
    redirectUri,
  });
  const intakeConnector = createReferenceConnector(platform, { flavor: 'push', redirectUri });
  const registry = new ConnectorRegistry();
  registry.register(intakeConnector);
  const gate = new WebhookGate({
    registry,
    secrets: new StaticWebhookSecrets(
      new Map([[intakeConnector.platform, new Secret(webhookSecret)]]),
    ),
    ledger: new MemoryDeliveryLedger(),
    clock: systemClock,
    log: h.log,
    observer: promWebhookObserver(metrics),
  });
  // 2. An acting connector for the moderation step (in-memory stack, connected via OAuth).
  const act = await createInMemoryHarness('poll');
  const actAccount = await act.driver.createAccount();
  const { authorizationUrl } = await act.stack.oauth.start(act.stack.actor, act.connector.platform);
  const done = await act.stack.oauth.complete(
    act.stack.actor,
    act.connector.platform,
    await act.driver.consent(authorizationUrl, actAccount),
  );
  if (!done.ok) throw new Error(done.reason);
  const actScope = {
    organizationId: act.stack.actor.organizationId,
    brandId: act.stack.actor.brandId,
    connectionId: done.connectionId,
  };
  const actSrc = await act.driver.seedSource(actAccount);
  const [actComment] = await act.driver.seedComments(actAccount, actSrc, 1);
  // 3. A test job: fails once (transient), then hides the comment through ConnectionClient.act.
  let runs = 0;
  h.jobs.register({
    type: 'e2e_moderate',
    platforms: 'all',
    timeoutMs: 10_000,
    payload: z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/) }),
    externalRef: (p) => p.ref,
    handle: async () => {
      runs++;
      if (runs === 1) throw new ConnectorError('transient', 'upstream_5xx');
      const client = await act.stack.runtime.connect(actScope);
      const r = await client.act({
        action: 'hide',
        target: { sourceExternalId: actSrc, externalId: actComment! },
      });
      return { status: r.status };
    },
  });
  // 4. Deliver a signed webhook; the deliver callback enqueues one job per event.
  const account = platform.createAccount();
  const src = platform.seedSource(account);
  const [cid] = platform.seedComments(account, src, 1);
  const signed = platform.signedDelivery(account, cid!, src);
  const req = {
    platform: intakeConnector.platform,
    connectionId: null,
    headers: signed.headers,
    rawBody: signed.rawBody,
  };
  const ledgerIds: string[] = [];
  const deliver = async (d: { events: readonly { ref: { externalId: string } }[] }) => {
    for (const ev of d.events) {
      const res = await h.producer.enqueue({
        scope: h.scope(0, 'youtube'),
        platform: 'youtube',
        type: 'e2e_moderate',
        payload: { ref: ev.ref.externalId },
      });
      ledgerIds.push(res.ledgerId);
    }
  };
  expect((await gate.handle(req, deliver)).status).toBe('accepted');
  expect((await gate.handle(req, deliver)).status).toBe('duplicate');
  expect(ledgerIds).toHaveLength(1);
  // The same comment also arrives by "poll": the producer dedupes it.
  const dup = await h.producer.enqueue({
    scope: h.scope(0, 'youtube'),
    platform: 'youtube',
    type: 'e2e_moderate',
    payload: { ref: cid! },
  });
  expect(dup.ledgerId).toBe(ledgerIds[0]);
  expect(dup.status).toBe('deduplicated');

  const workers = await h.workers();
  try {
    await h.waitFor(ledgerIds[0]!, ['completed'], 20_000);
    // Telemetry is emitted around the ledger transition, so wait for each signal explicitly
    // instead of relying on close() to drain the in-flight job.
    await until('attempt-2 job.run span, job.completed line and completed metric', async () => {
      const ended = exporter
        .getFinishedSpans()
        .some(
          (s) =>
            s.name === 'job.run' &&
            s.attributes['feedbouncer.job.attempt'] === 2 &&
            s.attributes['feedbouncer.job.outcome'] === 'completed',
        );
      const logged = h.lines.some((l) => {
        const o = JSON.parse(l) as Record<string, unknown>;
        return o.msg === 'job.completed' && o.job_id === ledgerIds[0];
      });
      const counted = /feedbouncer_jobs_total\{[^}]*outcome="completed"[^}]*\} 1\n/.test(
        await metrics.registry.metrics(),
      );
      return ended && logged && counted;
    });
  } finally {
    await workers.close();
  }
  expect(runs).toBe(2);

  const spans = exporter.getFinishedSpans();
  const receive = spans.find(
    (s) =>
      s.name === 'webhook.receive' && s.attributes['feedbouncer.webhook.outcome'] === 'accepted',
  )!;
  expect(receive).toBeDefined();
  const traceId = receive.spanContext().traceId;
  const inTraceSpans = spans.filter((s) => s.spanContext().traceId === traceId);
  const inTrace = inTraceSpans.map((s) => s.name);
  expect(inTrace).toEqual(
    expect.arrayContaining([
      'webhook.receive',
      'job.enqueue',
      'job.run',
      'moderation.apply',
      'connector.act',
    ]),
  );

  // Parent/child ids across the queue boundary.
  const enqueue = inTraceSpans.find((s) => s.name === 'job.enqueue')!;
  expect(enqueue.parentSpanContext?.spanId).toBe(receive.spanContext().spanId);
  const runSpans = inTraceSpans.filter((s) => s.name === 'job.run');
  expect(runSpans.map((s) => s.attributes['feedbouncer.job.attempt']).sort()).toEqual([1, 2]);
  // The retry is a sibling attempt: both hang off the enqueue span.
  for (const r of runSpans) {
    expect(r.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId);
  }
  const lastRun = runSpans.find((s) => s.attributes['feedbouncer.job.attempt'] === 2)!;
  const moderation = inTraceSpans.find((s) => s.name === 'moderation.apply')!;
  expect(moderation.attributes['feedbouncer.action.status']).toBe('applied');
  // moderation.apply sits under the second attempt (directly or through connector.act).
  const byId = new Map(inTraceSpans.map((s) => [s.spanContext().spanId, s]));
  let cur = moderation;
  const ancestry: string[] = [];
  while (cur.parentSpanContext && byId.has(cur.parentSpanContext.spanId)) {
    cur = byId.get(cur.parentSpanContext.spanId)!;
    ancestry.push(cur.spanContext().spanId);
  }
  expect(ancestry).toContain(lastRun.spanContext().spanId);
  // The persisted context is our own producer's, not the inbound request's.
  const { rows } = await h.pool.query<{ trace_context: string }>(
    'SELECT trace_context FROM job_ledger WHERE id = $1',
    [ledgerIds[0]],
  );
  expect(rows[0]!.trace_context.split('-')[1]).toBe(traceId);
  expect(rows[0]!.trace_context.split('-')[2]).toBe(enqueue.spanContext().spanId);

  // Log lines carry the same trace id.
  const lines = h.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const completed = lines.filter((o) => o.job_id === ledgerIds[0] && o.msg === 'job.completed');
  expect(completed).toHaveLength(1);
  expect(completed[0]!.trace_id).toBe(traceId);
  expect(completed[0]!.span_id).toBe(lastRun.spanContext().spanId);
  expect(lines.some((o) => o.msg === 'duplicate webhook delivery skipped')).toBe(true);
  expect(lines.some((o) => o.msg === 'job.deduplicated' && o.job_id === ledgerIds[0])).toBe(true);

  // Every job lifecycle line for this ledger row (including the retry) is in the trace.
  const jobLines = lines.filter(
    (o) =>
      o.job_id === ledgerIds[0] &&
      String(o.msg).startsWith('job.') &&
      o.msg !== 'job.enqueued' &&
      o.msg !== 'job.deduplicated',
  );
  expect(jobLines.length).toBeGreaterThanOrEqual(2);
  expect(jobLines.every((o) => o.trace_id === traceId)).toBe(true);

  const text = await metrics.registry.metrics();
  expect(text).toMatch(/feedbouncer_webhook_events_total\{[^}]*\} 1\n/);
  expect(text).toMatch(/feedbouncer_webhook_deliveries_total\{[^}]*outcome="duplicate"[^}]*\} 1/);
  expect(text).toMatch(/feedbouncer_jobs_total\{[^}]*outcome="enqueued"[^}]*\} 1\n/);
  expect(text).toMatch(/feedbouncer_jobs_total\{[^}]*outcome="completed"[^}]*\} 1\n/);
});
