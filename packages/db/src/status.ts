/**
 * A status column's accepted values. Anything unrecognized reads as `fallback`,
 * so callers fail closed by passing their least-privileged status.
 */
export function statusRule<const T extends readonly string[], F extends T[number]>(
  values: T,
  fallback: F,
) {
  const is = (v: unknown): v is T[number] => (values as readonly unknown[]).includes(v);
  const of = (raw: unknown): { status: T[number]; recognized: boolean } =>
    is(raw) ? { status: raw, recognized: true } : { status: fallback, recognized: false };
  return { is, of, isActive: (raw: unknown): boolean => of(raw).status === 'active' };
}
