import { z } from 'zod';

export const SCAN_QUEUE = 'scan';

/** Redis carries only the scan id: the token stays sealed in Postgres. */
export const scanJobPayload = z.strictObject({ v: z.literal(1), scanId: z.uuid() });
export type ScanJobPayload = z.infer<typeof scanJobPayload>;

/** The slice of a BullMQ queue the scan producers use. */
export interface ScanQueue {
  add(name: string, data: ScanJobPayload, opts: object): Promise<unknown>;
}

/** Queues a scan under its own id, so queuing it twice is a no-op. */
export async function enqueueScan(queue: ScanQueue, scanId: string): Promise<void> {
  await queue.add(
    'scan',
    { v: 1, scanId },
    {
      jobId: `scan-${scanId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/** Scan blobs are sealed under an organization id no tenant can have. */
export const SCAN_ENVELOPE_ORG = 'scan-tool';

export const scanTokenCtx = (scanId: string) => ({
  organizationId: SCAN_ENVELOPE_ORG,
  connectionId: scanId,
  kind: 'scan_user_token' as const,
});
