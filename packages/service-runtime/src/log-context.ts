import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_FIELDS = [
  'tenant_id',
  'brand_id',
  'connector_id',
  'connector_type',
  'job_id',
  'request_id',
] as const;
export type CorrelationField = (typeof CORRELATION_FIELDS)[number];
export type LogContext = Partial<Readonly<Record<CorrelationField, string>>>;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const store = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: Partial<Record<CorrelationField, string>> = { ...(store.getStore() ?? {}) };
  for (const k of CORRELATION_FIELDS) {
    const v = ctx[k];
    if (typeof v === 'string' && SAFE_ID.test(v)) merged[k] = v;
  }
  return store.run(merged, fn);
}
export function currentLogContext(): LogContext {
  return store.getStore() ?? {};
}
