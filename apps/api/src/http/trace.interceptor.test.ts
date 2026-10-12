import { describe, expect, it } from 'vitest';
import { lastValueFrom, throwError, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { TraceInterceptor } from './trace.interceptor.js';

const ctx = (statusCode: () => number) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', method: 'GET', routeOptions: { url: '/x' } }),
      getResponse: () => ({
        get statusCode() {
          return statusCode();
        },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('TraceInterceptor', () => {
  it('delivers the original error even when span bookkeeping throws', async () => {
    const err = {
      getStatus() {
        throw new Error('getter exploded');
      },
    };
    const next: CallHandler = { handle: () => throwError(() => err) };
    const out = new TraceInterceptor().intercept(
      ctx(() => 200),
      next,
    );
    await expect(lastValueFrom(out)).rejects.toBe(err);
  });

  it('completes the response even when reading the status throws', async () => {
    const next: CallHandler = { handle: () => of('ok') };
    const out = new TraceInterceptor().intercept(
      ctx(() => {
        throw new Error('no status');
      }),
      next,
    );
    await expect(lastValueFrom(out)).resolves.toBe('ok');
  });
});
