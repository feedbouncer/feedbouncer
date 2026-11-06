export function statusRule<const T extends readonly string[]>(values: T) {
  const is = (v: unknown): v is T[number] => (values as readonly unknown[]).includes(v);
  const of = (raw: unknown): { status: T[number]; recognized: boolean } =>
    is(raw) ? { status: raw, recognized: true } : { status: 'suspended', recognized: false };
  return { is, of, isActive: (raw: unknown): boolean => of(raw).status === 'active' };
}
