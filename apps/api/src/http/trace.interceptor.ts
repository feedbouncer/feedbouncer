import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import {
  SpanKind,
  currentTraceIds,
  setSpanAttributes,
  withLogContext,
  withSpan,
} from '@feedbouncer/service-runtime';
import type { TracedRequest } from './traced-request.js';

// Span bookkeeping must never change the response or replace the original error.
type Span = Parameters<typeof setSpanAttributes>[0];
const recordStatus = (span: Span, status: () => number): void => {
  try {
    setSpanAttributes(span, { 'http.response.status_code': status() });
  } catch {
    // Dropped on purpose.
  }
};

const isClientError = (e: unknown): boolean => {
  try {
    return statusOf(e) < 500;
  } catch {
    return false;
  }
};

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
    return defer(() =>
      withLogContext(
        { request_id: String(req.id), ...(req.org ? { tenant_id: req.org.organizationId } : {}) },
        () =>
          withSpan(
            `HTTP ${req.method} ${route}`,
            {
              kind: SpanKind.SERVER,
              root: true,
              attributes: { 'http.request.method': req.method, 'http.route': route },
              isControlFlow: (e) => isClientError(e),
            },
            async (span) => {
              req.fbTrace = currentTraceIds() ?? undefined;
              try {
                const value = await lastValueFrom(next.handle(), { defaultValue: undefined });
                recordStatus(span, () => http.getResponse<{ statusCode: number }>().statusCode);
                return value;
              } catch (e) {
                recordStatus(span, () => statusOf(e));
                throw e;
              }
            },
          ),
      ),
    );
  }
}
