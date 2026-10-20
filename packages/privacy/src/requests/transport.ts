import { z } from 'zod';

export const PRIVACY_QUEUE = 'privacy';

/** Redis carries only the request id: the identifiers stay sealed in Postgres. */
export const PrivacyJobData = z.strictObject({ v: z.literal(1), requestId: z.uuid() });
export type PrivacyJobData = z.infer<typeof PrivacyJobData>;
