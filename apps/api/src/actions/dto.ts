import type { LogEntry, ReviewItemView, StepType } from '@feedbouncer/actions';
import { STEP_META } from '@feedbouncer/actions';
import type { Platform } from '@feedbouncer/connectors';

export interface CapabilitiesDto {
  steps: Record<
    StepType,
    {
      meta: (typeof STEP_META)[StepType];
      platforms: {
        platform: Platform;
        connectionId: string;
        supported: boolean;
        missingScopes: string[];
        maxChars: number | null;
      }[];
    }
  >;
}

/** A step as the log shows it. Request keys and moderation action ids stay server-side. */
export interface LogEntryDto {
  id: string;
  runId: string;
  commentId: string;
  ruleId: string | null;
  ruleName: string | null;
  suggestionId: string | null;
  type: StepType;
  status: LogEntry['status'];
  reasonCode: string | null;
  dryRun: boolean;
  previewText: string | null;
  reviewItemId: string | null;
  actionStatus: LogEntry['actionStatus'];
  deferredUntil: string | null;
  deferredCode: string | null;
  undoStatus: LogEntry['undoStatus'];
  undoable: boolean;
  undoneAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const toLogEntryDto = (e: LogEntry): LogEntryDto => ({
  id: e.id,
  runId: e.runId,
  commentId: e.commentId,
  ruleId: e.ruleId,
  ruleName: e.ruleName,
  suggestionId: e.suggestionId,
  type: e.type,
  status: e.status,
  reasonCode: e.reasonCode,
  dryRun: e.dryRun,
  previewText: e.previewText,
  reviewItemId: e.reviewItemId,
  actionStatus: e.actionStatus,
  deferredUntil: e.deferredUntil?.toISOString() ?? null,
  deferredCode: e.deferredCode,
  undoStatus: e.undoStatus,
  undoable: e.undoable,
  undoneAt: e.undoneAt?.toISOString() ?? null,
  createdAt: e.createdAt.toISOString(),
  completedAt: e.completedAt?.toISOString() ?? null,
});

export interface ReviewItemDto {
  id: string;
  commentId: string;
  connectionId: string;
  platform: Platform;
  source: string;
  ruleId: string | null;
  ruleName: string | null;
  status: ReviewItemView['status'];
  resolution: ReviewItemView['resolution'];
  createdAt: string;
  resolvedAt: string | null;
  /** Comment text and author name as posted; shown as text only, never logged. */
  commentBody: string;
  authorName: string | null;
}

export const toReviewItemDto = (i: ReviewItemView): ReviewItemDto => ({
  id: i.id,
  commentId: i.commentId,
  connectionId: i.connectionId,
  platform: i.platform,
  source: i.source,
  ruleId: i.ruleId,
  ruleName: i.ruleName,
  status: i.status,
  resolution: i.resolution,
  createdAt: i.createdAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
  commentBody: i.commentBody,
  authorName: i.authorName,
});
