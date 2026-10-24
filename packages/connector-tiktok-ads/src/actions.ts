import {
  ConnectorError,
  type ActionRequest,
  type CallContext,
  type RawActionOutcome,
  type RawRespondOutcome,
  type RespondRequest,
} from '@feedbouncer/connectors';
import { opaqueId, tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import { callOf, scoped, type SkipLog } from './call.js';
import { findComment } from './comments.js';
import { AD_COMMENT_HIDE_FIELD } from './config.js';

const REPLY_SCHEMA = z.object({ comment_id: z.unknown().optional() });

/** `not_found` here means the comment is already gone on TikTok. */
async function gone<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === 'not_found') return null;
    throw e;
  }
}

export async function act(ctx: CallContext, req: ActionRequest): Promise<RawActionOutcome> {
  const { action } = req;
  if (action !== 'hide' && action !== 'unhide' && action !== 'delete') {
    throw new ConnectorError('unsupported', 'action_unsupported');
  }
  const base = {
    advertiser_id: ctx.externalAccountId,
    comment_ids: [opaqueId(req.target.externalId)],
  };
  const res = await gone(() =>
    scoped(() =>
      tiktokRequest(callOf(ctx), {
        endpoint: action === 'delete' ? 'adCommentDelete' : 'adCommentStatusUpdate',
        method: 'POST',
        body:
          action === 'delete'
            ? base
            : { ...base, [AD_COMMENT_HIDE_FIELD]: action === 'hide' ? 'HIDDEN' : 'PUBLIC' },
        schema: z.unknown(),
      }),
    ),
  );
  return res === null
    ? { status: 'not_found' }
    : { status: 'applied', platformActionId: res.requestId ?? 'tiktok' };
}

/**
 * The reply needs the ad and its video, which `ActionRequest` cannot carry beyond the ad id,
 * so the comment is looked up first (V13/V15).
 */
export async function respond(
  log: SkipLog,
  now: () => number,
  ctx: CallContext,
  req: RespondRequest,
): Promise<RawRespondOutcome> {
  if (req.kind !== 'public_reply') throw new ConnectorError('unsupported', 'response_unsupported');
  const commentId = opaqueId(req.target.externalId);
  const found = await findComment(log, now, ctx, commentId);
  // The lookup only covers recent comments, so a miss does not mean the comment is gone.
  if (found === null) throw new ConnectorError('permanent', 'comment_lookup_missed');
  const res = await gone(() =>
    scoped(() =>
      tiktokRequest(callOf(ctx), {
        endpoint: 'adCommentPost',
        method: 'POST',
        body: {
          advertiser_id: ctx.externalAccountId,
          comment_type: 'REPLY',
          comment_id: commentId,
          ad_id: found.adId,
          tiktok_item_id: found.itemId,
          text: req.text,
        },
        schema: REPLY_SCHEMA,
      }),
    ),
  );
  if (res === null) return { status: 'not_found' };
  const ref = res.data.comment_id;
  return { status: 'sent', platformRef: typeof ref === 'string' ? ref : null };
}
