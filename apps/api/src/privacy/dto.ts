import { z } from 'zod';
import { SubjectList, type PrivacyRequestView } from '@feedbouncer/privacy';

export const CreatePrivacyRequestBody = z
  .strictObject({
    kind: z.enum(['export', 'erasure']),
    dryRun: z.boolean().default(false),
    subjects: SubjectList,
    reference: z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,64}$/)
      .optional(),
    keepRuleEntries: z.strictObject({ reason: z.string().min(1).max(500) }).optional(),
  })
  // A reason and a dry run only mean something for an erasure.
  .refine((b) => b.kind === 'erasure' || (b.keepRuleEntries === undefined && !b.dryRun));
export type CreatePrivacyRequestBody = z.infer<typeof CreatePrivacyRequestBody>;

export const ListPrivacyRequestsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.uuid().optional(),
});

export interface PrivacyRequestDto {
  id: string;
  kind: 'export' | 'erasure';
  mode: 'dry_run' | 'execute';
  status: 'queued' | 'running' | 'done' | 'failed';
  requestedVia: 'api' | 'cli';
  actorUserId: string | null;
  reference: string | null;
  found: boolean | null;
  counts: Record<string, number>;
  coverage: string | null;
  errorCode: string | null;
  exportAvailable: boolean;
  exportBytes: number | null;
  exportExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The identifiers are not readable after creation, and the subject count and file hash stay internal. */
export function toPrivacyRequestDto(r: PrivacyRequestView, now = new Date()): PrivacyRequestDto {
  return {
    id: r.id,
    kind: r.kind,
    mode: r.mode,
    status: r.status,
    requestedVia: r.requestedVia,
    actorUserId: r.actorUserId,
    reference: r.reference,
    found: r.found,
    counts: r.counts,
    coverage: r.coverage,
    errorCode: r.errorCode,
    exportAvailable: isDownloadable(r, now),
    exportBytes: r.exportBytes,
    exportExpiresAt: iso(r.exportExpiresAt),
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

export const isDownloadable = (r: PrivacyRequestView, now: Date): boolean =>
  r.kind === 'export' &&
  r.status === 'done' &&
  r.exportExpiresAt !== null &&
  r.exportExpiresAt > now;
