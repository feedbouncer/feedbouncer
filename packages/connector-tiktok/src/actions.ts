import {
  ConnectorError,
  type ActionRequest,
  type CallContext,
  type RawActionOutcome,
  type RawRespondOutcome,
  type RespondRequest,
} from '@feedbouncer/connectors';
import {
  callOf,
  gone,
  onPermissionDenied,
  opaqueId,
  scopeMissing,
  tiktokRequest,
} from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';

const REPLY_SCHEMA = z.object({ comment_id: z.unknown().optional() });
const manage = () => scopeMissing('comment.list.manage');

function body(ctx: CallContext, target: ActionRequest['target']) {
  return {
    business_id: ctx.externalAccountId,
    video_id: opaqueId(target.sourceExternalId),
    comment_id: opaqueId(target.externalId),
  };
}

export async function act(ctx: CallContext, req: ActionRequest): Promise<RawActionOutcome> {
  const { action } = req;
  if (action !== 'hide' && action !== 'unhide' && action !== 'delete') {
    throw new ConnectorError('unsupported', 'action_unsupported');
  }
  const fields = body(ctx, req.target);
  const res = await gone(() =>
    onPermissionDenied(
      () =>
        tiktokRequest(callOf(ctx), {
          endpoint: action === 'delete' ? 'businessCommentDelete' : 'businessCommentHide',
          method: 'POST',
          body: action === 'delete' ? fields : { ...fields, action: action.toUpperCase() },
          schema: z.unknown(),
        }),
      manage,
    ),
  );
  return res === null
    ? { status: 'not_found' }
    : { status: 'applied', platformActionId: res.requestId ?? 'tiktok' };
}

export async function respond(ctx: CallContext, req: RespondRequest): Promise<RawRespondOutcome> {
  if (req.kind !== 'public_reply') throw new ConnectorError('unsupported', 'response_unsupported');
  const res = await gone(() =>
    onPermissionDenied(
      () =>
        tiktokRequest(callOf(ctx), {
          endpoint: 'businessReplyCreate',
          method: 'POST',
          body: { ...body(ctx, req.target), text: req.text },
          schema: REPLY_SCHEMA,
        }),
      manage,
    ),
  );
  if (res === null) return { status: 'not_found' };
  const ref = res.data.comment_id;
  return { status: 'sent', platformRef: typeof ref === 'string' ? ref : null };
}
