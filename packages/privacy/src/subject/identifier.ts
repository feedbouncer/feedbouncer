import { PLATFORMS, type Platform } from '@feedbouncer/connectors';
import { z } from 'zod';

const NO_CONTROL = /^[^\p{Cc}]+$/u;

/** One way a person is known on a platform. Matched exactly: never LIKE, never display names. */
export interface SubjectIdentifierT {
  platform: Platform;
  externalId?: string | undefined;
  handle?: string | undefined;
  connectionId?: string | undefined;
}

export const SubjectIdentifier: z.ZodType<SubjectIdentifierT> = z
  .strictObject({
    platform: z.enum(PLATFORMS),
    externalId: z.string().min(1).max(255).regex(NO_CONTROL).optional(),
    handle: z.string().min(1).max(100).regex(NO_CONTROL).optional(),
    connectionId: z.uuid().optional(),
  })
  .refine((s) => s.externalId !== undefined || s.handle !== undefined);

/** A subject request carries 1 to 20 identifiers. */
export const SubjectList = z.array(SubjectIdentifier).min(1).max(20);
