// Writes and the pre-write probe. One setModerationStatus call (50 units) moderates up to 50
// comments sharing one status; one comments.list?id= call (1 unit) probes up to 50.
import {
  ConnectorError,
  type ActionRequest,
  type BatchActionOutcome,
  type BatchActionRequest,
  type CallContext,
  type CommentProbe,
  type CommentRef,
  type ModerationAction,
  type RawActionOutcome,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import { YouTubeApiError, youtubeCall } from './api.js';
import { MAX_BATCH } from './costs.js';
import { assertId } from './ids.js';
import { authorChannelId, COMMENT, LIST } from './threads.js';

export const YOUTUBE_ACTIONS = ['hide', 'unhide', 'delete', 'ban_author'] as const;

/** hide = "Hold for review", delete = "Reject", ban_author = "Reject and ban". */
const STATUS: Readonly<Partial<Record<ModerationAction, Readonly<Record<string, string>>>>> = {
  hide: { moderationStatus: 'heldForReview' },
  unhide: { moderationStatus: 'published' },
  delete: { moderationStatus: 'rejected' },
  ban_author: { moderationStatus: 'rejected', banAuthor: 'true' },
};

/** Validated, de-duplicated comment ids; refuses more than 50 before anything is sent. */
function batchIds(refs: readonly CommentRef[]): string[] {
  if (refs.length > MAX_BATCH) throw new ConnectorError('permanent', 'batch_too_large');
  return [...new Set(refs.map((r) => assertId('comment', r.externalId)))];
}

export async function actBatch(
  ctx: CallContext,
  req: BatchActionRequest,
): Promise<BatchActionOutcome> {
  const status = Object.hasOwn(STATUS, req.action) ? STATUS[req.action] : undefined;
  if (status === undefined) throw new ConnectorError('unsupported', 'unsupported');
  const ids = batchIds(req.targets);
  if (ids.length === 0) throw new ConnectorError('permanent', 'invalid_action_request');
  try {
    await youtubeCall(
      ctx,
      'comments.setModerationStatus',
      { id: ids.join(','), ...status },
      z.unknown(),
    );
    return { status: 'applied' };
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'not_found') return { status: 'not_found' };
    // A published or rejected comment cannot go back to heldForReview.
    if (req.action === 'hide' && err instanceof YouTubeApiError && err.status === 400) {
      throw new ConnectorError('permanent', 'hold_not_allowed');
    }
    throw err;
  }
}

export async function act(ctx: CallContext, req: ActionRequest): Promise<RawActionOutcome> {
  const out = await actBatch(ctx, { action: req.action, targets: [req.target] });
  return out.status === 'applied' ? { status: 'applied', platformActionId: null } : out;
}

function probeState(status: string | undefined): CommentProbe['state'] {
  if (status === 'heldForReview' || status === 'likelySpam') return 'held';
  if (status === 'rejected') return 'gone';
  return 'visible';
}

/** Current state of each ref, in order. A comment Google did not return is `gone`. */
export async function probeComments(
  ctx: CallContext,
  refs: readonly CommentRef[],
): Promise<readonly CommentProbe[]> {
  const ids = batchIds(refs);
  if (ids.length === 0) return [];
  const res = await youtubeCall(
    ctx,
    'comments.list',
    { id: ids.join(','), part: 'snippet', textFormat: 'plainText' },
    LIST,
  );
  const found = new Map<string, CommentProbe>();
  for (const item of res?.items ?? []) {
    const c = COMMENT.safeParse(item);
    if (!c.success || typeof c.data.id !== 'string' || !ids.includes(c.data.id)) continue;
    const updated = new Date(c.data.snippet.updatedAt ?? c.data.snippet.publishedAt);
    found.set(c.data.id, {
      externalId: c.data.id,
      state: probeState(c.data.snippet.moderationStatus),
      updatedAt: Number.isNaN(updated.getTime()) ? null : updated,
      authorExternalId: authorChannelId(c.data),
    });
  }
  return refs.map(
    (r) =>
      found.get(r.externalId) ?? {
        externalId: r.externalId,
        state: 'gone',
        updatedAt: null,
        authorExternalId: null,
      },
  );
}
