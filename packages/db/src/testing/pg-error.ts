import { expect } from 'vitest';

export async function expectPgError(
  p: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
    },
    (e: unknown) => e as { code?: string; constraint?: string },
  );
  expect(err.code).toBe(code);
  if (constraint) expect(err.constraint).toBe(constraint);
}
