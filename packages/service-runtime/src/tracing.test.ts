import { afterEach, beforeEach, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createLogger } from './logger.js';
import {
  contextFromTraceparent,
  currentTraceIds,
  injectTraceparent,
  safeAttributes,
  SpanKind,
  TRACEPARENT,
  withSpan,
} from './tracing.js';

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

it('is a no-op without a provider', async () => {
  trace.disable();
  expect(await withSpan('x', {}, async () => currentTraceIds())).toBeNull();
  expect(injectTraceparent()).toBeNull();
});

it('round-trips a traceparent and parents a child to it', async () => {
  const tp = await withSpan('producer', { kind: SpanKind.PRODUCER }, async () =>
    injectTraceparent(),
  );
  expect(tp).toMatch(TRACEPARENT);
  const parent = contextFromTraceparent(tp);
  await withSpan('consumer', { kind: SpanKind.CONSUMER, parent }, async () => undefined);
  const [p, c] = exporter.getFinishedSpans();
  expect(c!.spanContext().traceId).toBe(p!.spanContext().traceId);
  expect(c!.parentSpanContext?.spanId).toBe(p!.spanContext().spanId);
});

it('rejects malformed or all-zero traceparents', () => {
  for (const bad of [
    null,
    '',
    'garbage',
    `00-${'0'.repeat(32)}-${'a'.repeat(16)}-01`,
    `00-${'a'.repeat(32)}-${'a'.repeat(16)}-01\n`,
  ]) {
    expect(contextFromTraceparent(bad)).toBeNull();
  }
});

it('logs carry trace_id and span_id inside a span', async () => {
  const lines: string[] = [];
  const log = createLogger('worker', 'info', (l) => lines.push(l));
  await withSpan('s', {}, async () => log.info('inside'));
  const o = JSON.parse(lines[0]!);
  const span = exporter.getFinishedSpans()[0]!;
  expect(o.trace_id).toBe(span.spanContext().traceId);
  expect(o.span_id).toBe(span.spanContext().spanId);
});

it('safeAttributes drops unknown and secret keys and redacts values', () => {
  expect(
    safeAttributes({
      'feedbouncer.platform': 'youtube',
      'feedbouncer.access_token': 'tok',
      'comment.body': 'hello',
      'feedbouncer.note': 'url https://u:p@h/x',
      'feedbouncer.n': 3,
      'feedbouncer.none': null,
    }),
  ).toEqual({
    'feedbouncer.platform': 'youtube',
    'feedbouncer.note': 'url https://[redacted]@h/x',
    'feedbouncer.n': 3,
  });
});

it('error spans carry code and class, never the message', async () => {
  const err = Object.assign(new Error('secret-ish text'), {
    code: 'upstream_5xx',
    errorClass: 'retryable',
  });
  await expect(
    withSpan('s', {}, async () => {
      throw err;
    }),
  ).rejects.toBe(err);
  const s = exporter.getFinishedSpans()[0]!;
  expect(s.status).toEqual({ code: 2, message: 'upstream_5xx' });
  expect(s.attributes).toMatchObject({
    'feedbouncer.error.code': 'upstream_5xx',
    'feedbouncer.error.class': 'retryable',
  });
  expect(s.events).toEqual([]);
  expect(JSON.stringify(s.attributes)).not.toContain('secret-ish');
});

it('control-flow errors do not mark the span', async () => {
  class Flow extends Error {}
  await expect(
    withSpan('s', { isControlFlow: (e) => e instanceof Flow }, async () => {
      throw new Flow();
    }),
  ).rejects.toBeInstanceOf(Flow);
  expect(exporter.getFinishedSpans()[0]!.status.code).toBe(0);
});

it('a span id logged by the caller cannot override the active span', async () => {
  const lines: string[] = [];
  const log = createLogger('worker', 'info', (l) => lines.push(l));
  await withSpan('s', {}, async () => log.info('x', { trace_id: 'spoof', span_id: 'spoof' }));
  const o = JSON.parse(lines[0]!);
  const span = exporter.getFinishedSpans()[0]!;
  expect(o.trace_id).toBe(span.spanContext().traceId);
  expect(o.span_id).toBe(span.spanContext().spanId);
});

it('a throwing error getter never replaces the original error', async () => {
  const err = new Error('boom');
  Object.defineProperty(err, 'code', {
    get() {
      throw new Error('getter exploded');
    },
  });
  await expect(
    withSpan('s', {}, async () => {
      throw err;
    }),
  ).rejects.toBe(err);
  expect(exporter.getFinishedSpans()).toHaveLength(1);
});
