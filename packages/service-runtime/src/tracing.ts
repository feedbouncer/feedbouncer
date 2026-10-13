import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from '@opentelemetry/api';
import { errorClassOf, errorCodeOf } from './error-class.js';
import { isSecretField, redact } from './redaction.js';

export { SpanKind };
export type { Context, Span };
export const TRACER_NAME = 'feedbouncer';
export const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/;
const ATTR_KEY = /^(?:feedbouncer|http|messaging)\.[a-z0-9_.]{1,80}$/;
const MAX_ATTR_CHARS = 256;

export type AttrInput = Readonly<Record<string, string | number | boolean | null | undefined>>;

export function safeAttributes(input: AttrInput): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || !ATTR_KEY.test(k) || isSecretField(k)) continue;
    out[k] = typeof v === 'string' ? redact(v).slice(0, MAX_ATTR_CHARS) : v;
  }
  return out;
}
export function setSpanAttributes(span: Span, a: AttrInput): void {
  span.setAttributes(safeAttributes(a));
}
export function markSpanError(span: Span, err: unknown): void {
  const code = errorCodeOf(err);
  setSpanAttributes(span, {
    'feedbouncer.error.code': code,
    'feedbouncer.error.class': errorClassOf(err),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: code });
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: AttrInput;
  parent?: Context | null;
  root?: boolean;
  links?: Link[];
  isControlFlow?: (err: unknown) => boolean;
}

export async function withSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = opts.root ? ROOT_CONTEXT : (opts.parent ?? context.active());
  const span = trace.getTracer(TRACER_NAME).startSpan(
    name,
    {
      kind: opts.kind ?? SpanKind.INTERNAL,
      attributes: safeAttributes(opts.attributes ?? {}),
      links: opts.links ?? [],
    },
    parent,
  );
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (err) {
      try {
        if (!opts.isControlFlow?.(err)) markSpanError(span, err);
      } catch {
        // Span bookkeeping must never replace the original error.
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

export function currentTraceIds(): { trace_id: string; span_id: string } | null {
  const sc = trace.getSpanContext(context.active());
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : null;
}
export function injectTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const tp = carrier['traceparent'];
  return tp !== undefined && TRACEPARENT.test(tp) ? tp : null;
}
export function contextFromTraceparent(tp: string | null | undefined): Context | null {
  if (typeof tp !== 'string' || !TRACEPARENT.test(tp)) return null;
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent: tp });
  const sc = trace.getSpanContext(ctx);
  return sc && trace.isSpanContextValid(sc) ? ctx : null;
}
