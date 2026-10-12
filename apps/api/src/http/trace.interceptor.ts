import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Observable, type Subscription } from 'rxjs';
import {
  SpanKind,
  currentTraceIds,
  markSpanError,
  setSpanAttributes,
  withLogContext,
  withSpan,
} from '@feedbouncer/service-runtime';
import type { TracedRequest } from './traced-request.js';

const statusOf = (e: unknown): number => {
  const s =
    typeof (e as { getStatus?: unknown })?.getStatus === 'function'
      ? (e as { getStatus(): number }).getStatus()
      : (e as { status?: unknown })?.status;
  return typeof s === 'number' ? s : 500;
};

/**
 * One server span per handled request, always a new root: inbound traceparent
 * headers are untrusted public input and are never extracted. Attributes are
 * the method and the route pattern only (no URL, query string or body).
 * Requests rejected by a guard never reach an interceptor; the request log and
 * HTTP metrics still cover them.
 */
@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<TracedRequest>();
    const route = req.routeOptions.url ?? 'unmatched';
    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      void withLogContext(
        { request_id: String(req.id), ...(req.org ? { tenant_id: req.org.organizationId } : {}) },
        () =>
          withSpan(
            `HTTP ${req.method} ${route}`,
            {
              kind: SpanKind.SERVER,
              root: true,
              attributes: { 'http.request.method': req.method, 'http.route': route },
            },
            async (span) => {
              req.fbTrace = currentTraceIds() ?? undefined;
              inner = next.handle().subscribe({
                next: (v) => subscriber.next(v),
                error: (e: unknown) => {
                  try {
                    const status = statusOf(e);
                    setSpanAttributes(span, { 'http.response.status_code': status });
                    if (status >= 500) markSpanError(span, e);
                  } catch {
                    // Span bookkeeping must never stop the error reaching the client.
                  }
                  subscriber.error(e);
                  finish();
                },
                complete: () => {
                  try {
                    setSpanAttributes(span, {
                      'http.response.status_code': http.getResponse<{ statusCode: number }>()
                        .statusCode,
                    });
                  } catch {
                    // Span bookkeeping must never stop the response completing.
                  }
                  subscriber.complete();
                  finish();
                },
              });
              await finished;
            },
          ),
      ).catch((e: unknown) => subscriber.error(e));
      // A client that disconnects unsubscribes: end the span instead of leaking it.
      return () => {
        inner?.unsubscribe();
        finish();
      };
    });
  }
}
