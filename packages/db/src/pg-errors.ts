export const OWNER_REQUIRED_CONSTRAINT = 'membership_owner_required';

function fields(err: unknown): { code?: unknown; constraint?: unknown } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: unknown; constraint?: unknown })
    : {};
}
export function isUniqueViolation(err: unknown, constraintOrIndex: string): boolean {
  const f = fields(err);
  return f.code === '23505' && f.constraint === constraintOrIndex;
}
export function isOwnerRequiredViolation(err: unknown): boolean {
  const f = fields(err);
  return f.code === '23514' && f.constraint === OWNER_REQUIRED_CONSTRAINT;
}
