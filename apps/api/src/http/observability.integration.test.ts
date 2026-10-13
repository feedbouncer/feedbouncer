import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initTracing, loadTelemetryConfig } from '@feedbouncer/observability';
import { resetTracingForTests } from '@feedbouncer/observability/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let exporter: InMemorySpanExporter;
let api: TestApi;
let A: OrgFixture;

beforeEach(async () => {
  exporter = new InMemorySpanExporter();
  resetTracingForTests();
  initTracing(
    loadTelemetryConfig({}, 'api'),
    createLogger('t', 'error', () => {}),
    {
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    },
  );
  api = await startTestApi();
  A = await orgWithRoles(api, 'obs');
});
afterEach(async () => {
  await api.close();
  resetTracingForTests();
});

const parsedLines = () => api.logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
const ROUTE = '/api/v1/orgs/:orgId/brands/:brandId';

describe('API observability', () => {
  it('request logs carry request_id, trace_id and tenant_id; HTTP metrics use route patterns', async () => {
    await api.req('GET', `/api/v1/orgs/${A.orgId}/brands/${A.brandId}`, { cookie: A.owner.cookie });
    const line = parsedLines().find((o) => o.msg === 'request' && o.route === ROUTE);
    const span = exporter.getFinishedSpans().find((s) => s.name === `HTTP GET ${ROUTE}`)!;
    expect(span).toBeDefined();
    expect(line).toMatchObject({ trace_id: span.spanContext().traceId, tenant_id: A.orgId });
    expect(line!.request_id).toBeTruthy();
    expect(span.parentSpanContext).toBeUndefined();
    const text = await api.deps.metrics.registry.metrics();
    expect(text).toMatch(
      /feedbouncer_http_requests_total\{[^}]*route="\/api\/v1\/orgs\/:orgId\/brands\/:brandId"[^}]*status_class="2xx"/,
    );
    expect(text).not.toContain(A.orgId);
    expect(text).not.toContain(A.brandId);
  });

  it('ignores an inbound traceparent header', async () => {
    const inbound = 'a'.repeat(32);
    await api.req('GET', '/api/v1/me', {
      cookie: A.owner.cookie,
      headers: { traceparent: `00-${inbound}-${'b'.repeat(16)}-01` },
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'HTTP GET /api/v1/me')!;
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).not.toBe(inbound);
    expect(span.parentSpanContext).toBeUndefined();
    const line = parsedLines().find((o) => o.msg === 'request' && o.route === '/api/v1/me');
    expect(line!.trace_id).toBe(span.spanContext().traceId);
  });

  it('never puts query strings, bodies or hostile request ids in logs, spans or metric labels', async () => {
    const hostile = 'evil"}\n{"level":"error","msg":"forged';
    await api.req(
      'GET',
      `/api/v1/orgs/${A.orgId}/brands/${A.brandId}?token=sentinel-query-secret`,
      {
        cookie: A.owner.cookie,
        headers: { 'x-request-id': hostile },
      },
    );
    await api.req('PATCH', `/api/v1/orgs/${A.orgId}/brands/${A.brandId}`, {
      cookie: A.owner.cookie,
      body: { name: 'sentinel-body-name' },
    });
    const logs = api.logLines.join('\n');
    const spans = JSON.stringify(
      exporter.getFinishedSpans().map((s) => ({ n: s.name, a: s.attributes })),
    );
    const metrics = await api.deps.metrics.registry.metrics();
    for (const out of [logs, spans, metrics]) {
      expect(out).not.toContain('sentinel-query-secret');
      expect(out).not.toContain('sentinel-body-name');
      expect(out).not.toContain('forged');
    }
    // Every line is still one valid JSON object, and no forged line appeared.
    expect(parsedLines().every((o) => o.level !== 'error')).toBe(true);
    for (const o of parsedLines().filter((x) => x.msg === 'request')) {
      expect(
        o.request_id === undefined || /^[A-Za-z0-9._:-]{1,128}$/.test(String(o.request_id)),
      ).toBe(true);
    }
  });

  it('counts unmatched routes under a single label, not the raw path', async () => {
    await api.req('GET', '/api/v1/definitely/not/a/route/sentinel-path');
    const text = await api.deps.metrics.registry.metrics();
    expect(text).not.toContain('sentinel-path');
    expect(text).toMatch(
      /feedbouncer_http_requests_total\{[^}]*route="unmatched"[^}]*status_class="4xx"/,
    );
  });
});
