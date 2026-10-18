import { z } from 'zod';

export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() }).meta({ id });
}
