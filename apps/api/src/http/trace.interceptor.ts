import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { HttpException, Injectable } from '@nestjs/common';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import {
  SpanKind,
  currentTraceIds,
  setSpanAttributes,
  withLogContext,
  withSpan,
} from '@feedbouncer/service-runtime';
import { ApiError } from './errors.js';
import type { TracedRequest } from './traced-request.js';

const statusOf = (e: unknown): number => {
  if (e instanceof ApiError) return e.status;
  if (e instanceof HttpException) return e.getStatus();
  return 500;
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
              isControlFlow: (e) => statusOf(e) < 500,
            },
            async (span) => {
              req.fbTrace = currentTraceIds() ?? undefined;
              try {
                const value = await lastValueFrom(next.handle(), { defaultValue: undefined });
                setSpanAttributes(span, {
                  'http.response.status_code': http.getResponse<{ statusCode: number }>()
                    .statusCode,
                });
                return value;
              } catch (e) {
                setSpanAttributes(span, { 'http.response.status_code': statusOf(e) });
                throw e;
              }
            },
          ),
      ),
    );
  }
}
