/** Shape of a stored error code; the connection_sync CHECK constraint mirrors it. */
export const ERROR_CODE = /^[a-z][a-z0-9_]{0,62}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ERROR_CLASSES = [
  'retryable',
  'rate_limited',
  'non_retryable',
  'needs_reconnection',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

const prop = (err: unknown, key: string): unknown =>
  typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined;

export function errorCodeOf(err: unknown): string {
  const c = prop(err, 'code');
  return typeof c === 'string' && ERROR_CODE.test(c) ? c : 'unexpected_error';
}
export function errorClassOf(err: unknown): ErrorClass | null {
  const c = prop(err, 'errorClass');
  return (ERROR_CLASSES as readonly unknown[]).includes(c) ? (c as ErrorClass) : null;
}
