import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { withSpan } from '@feedbouncer/service-runtime';
import { createJobsHarness } from './testing/index.js';

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

const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('job tracing', () => {
  it('a retried job is one trace: enqueue -> run#1 -> run#2, linked across the queue', async () => {
    const h = await createJobsHarness();
    const workers = await h.workers();
    try {
      const res = await withSpan('test.intake', { root: true }, () =>
        h.producer.enqueue({
          scope: h.scope(0, 'youtube'),
          platform: 'youtube',
          type: 'scripted',
          payload: { ref: 'r1', steps: ['transient', 'ok'] },
        }),
      );
      await h.waitFor(res.ledgerId, ['completed']);
      const spans = exporter.getFinishedSpans();
      const intake = spans.find((s) => s.name === 'test.intake')!;
      const enqueue = spans.find((s) => s.name === 'job.enqueue')!;
      const runs = spans
        .filter((s) => s.name === 'job.run')
        .sort(
          (a, b) =>
            Number(a.attributes['feedbouncer.job.attempt']) -
            Number(b.attributes['feedbouncer.job.attempt']),
        );
      const traceId = intake.spanContext().traceId;
      expect([enqueue, ...runs].every((s) => s.spanContext().traceId === traceId)).toBe(true);
      expect(runs.map((s) => s.attributes['feedbouncer.job.attempt'])).toEqual([1, 2]);
      expect(runs.map((s) => s.attributes['feedbouncer.job.outcome'])).toEqual([
        'retried',
        'completed',
      ]);
      for (const r of runs) {
        expect(r.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId);
      }
      const jobLines = parsed(h.lines).filter(
        (o) =>
          o.job_id === res.ledgerId &&
          String(o.msg).startsWith('job.') &&
          o.msg !== 'job.enqueued' &&
          o.msg !== 'job.deduplicated',
      );
      expect(jobLines.length).toBeGreaterThan(0);
      expect(jobLines.every((o) => o.trace_id === traceId)).toBe(true);
    } finally {
      await workers.close();
      await h.cleanup();
    }
  });

  it('a duplicate enqueue keeps the original trace and is a span event, not a new job', async () => {
    const h = await createJobsHarness();
    try {
      const enq = () =>
        h.producer.enqueue({
          scope: h.scope(0, 'youtube'),
          platform: 'youtube',
          type: 'scripted',
          payload: { ref: 'r2', steps: ['ok'] },
        });
      const first = await withSpan('test.intake', { root: true }, enq);
      const second = await withSpan('test.intake', { root: true }, enq);
      expect(second.ledgerId).toBe(first.ledgerId);
      expect(second.status).toBe('deduplicated');
      const intakes = exporter.getFinishedSpans().filter((s) => s.name === 'test.intake');
      const enqueues = exporter.getFinishedSpans().filter((s) => s.name === 'job.enqueue');
      expect(enqueues).toHaveLength(2);
      const { rows } = await h.pool.query<{ trace_context: string }>(
        'SELECT trace_context FROM job_ledger WHERE id = $1',
        [first.ledgerId],
      );
      expect(rows[0]!.trace_context.split('-')[1]).toBe(intakes[0]!.spanContext().traceId);
      const dupSpan = enqueues.find(
        (s) => s.spanContext().traceId === intakes[1]!.spanContext().traceId,
      )!;
      expect(dupSpan.events.map((e) => e.name)).toEqual(['job.deduplicated']);
      expect(enqueues.flatMap((s) => s.events)).toHaveLength(1);
      expect(h.metrics.count('enqueued', 'youtube')).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it('rows without trace context (older producers) run in a fresh trace', async () => {
    const h = await createJobsHarness();
    const res = await h.producer.enqueue({
      scope: h.scope(0, 'youtube'),
      platform: 'youtube',
      type: 'scripted',
      payload: { ref: 'r3', steps: ['ok'] },
    });
    await h.pool.query('UPDATE job_ledger SET trace_context = NULL WHERE id = $1', [res.ledgerId]);
    const workers = await h.workers();
    try {
      await h.waitFor(res.ledgerId, ['completed']);
      const run = exporter.getFinishedSpans().find((s) => s.name === 'job.run')!;
      expect(run.parentSpanContext).toBeUndefined();
      expect(parsed(h.lines).some((o) => o.msg === 'job.trace_started')).toBe(true);
    } finally {
      await workers.close();
      await h.cleanup();
    }
  });

  it('a job exhausting retries is dead-lettered once in the ledger, the log and the sink', async () => {
    const events: string[] = [];
    const h = await createJobsHarness({
      sink: { onEvent: (e) => events.push(e), onWait: () => {} },
    });
    const workers = await h.workers();
    try {
      const res = await h.producer.enqueue({
        scope: h.scope(0, 'youtube'),
        platform: 'youtube',
        type: 'scripted',
        payload: { ref: 'r4', steps: ['transient'] },
      });
      await h.waitFor(res.ledgerId, ['dead_lettered'], 20_000);
      expect(events.filter((e) => e === 'dead_lettered')).toHaveLength(1);
      expect(parsed(h.lines).filter((o) => o.msg === 'job.dead_lettered')).toHaveLength(1);
    } finally {
      await workers.close();
      await h.cleanup();
    }
  });
});
