// Moderation actions, replies and the Page webhook subscription. Every id is
// checked with graphId before any request; Graph error messages are never read.
// The reply target is taken as given: the caller resolves a nested reply to its
// top-level comment (Facebook supports one nesting level).
import {
  ConnectorError,
  externalIdSchema,
  type ActionRequest,
  type CallContext,
  type ConnectorLifecycle,
  type RawActionOutcome,
  type RawRespondOutcome,
  type RespondRequest,
} from '@feedbouncer/connectors';
import type { FacebookConfig } from './config.js';
import { callFor } from './comments.js';
import { GRAPH_ID, graphErrorCodes, graphId, graphRequest } from './graph.js';
import { subscribePageFields, unsubscribePageFields } from './subscriptions.js';

type Now = () => number;

/**
 * Graph errors on `POST /{page}/messages` that mean "this comment cannot get a
 * private reply". UNVERIFIED against a live Meta app (see README, behaviour (d)).
 */
export const PRIVATE_REPLY_INELIGIBLE: ReadonlyArray<{
  readonly code: number;
  readonly subcode: number | null;
  readonly reason: string;
}> = [
  { code: 10900, subcode: null, reason: 'private_reply_already_sent' },
  { code: 10, subcode: 2018278, reason: 'private_reply_window_closed' },
  { code: 551, subcode: null, reason: 'author_unavailable' },
  { code: 100, subcode: 2018001, reason: 'author_unavailable' },
];

const BAN_ERRORS: Readonly<Record<number, string>> = {
  3801: 'ban_limit_reached',
  3802: 'reblock_too_soon',
  100: 'author_not_bannable',
  210: 'author_not_bannable',
};
/** Graph 100/33: the object (comment or Page) no longer exists. */
const OBJECT_MISSING_SUBCODE = 33;

const success = (body: unknown) => (body as { success?: unknown } | null)?.success === true;

async function resolveAuthor(
  cfg: FacebookConfig,
  now: Now,
  ctx: CallContext,
  req: ActionRequest,
): Promise<string> {
  let author: unknown = req.authorExternalId;
  if (author === undefined) {
    const r = await graphRequest(callFor(cfg, now, ctx), {
      method: 'GET',
      path: [graphId(req.target.externalId)],
      query: { fields: 'from{id}' },
    });
    author = (r.body as { from?: { id?: unknown } } | null)?.from?.id;
    if (author === undefined || author === null) {
      throw new ConnectorError('permanent', 'author_unavailable');
    }
  }
  const id = graphId(author);
  if (id === ctx.externalAccountId) throw new ConnectorError('permanent', 'author_is_page');
  return id;
}

export async function act(
  cfg: FacebookConfig,
  now: Now,
  ctx: CallContext,
  req: ActionRequest,
): Promise<RawActionOutcome> {
  const c = callFor(cfg, now, ctx);
  const page = graphId(ctx.externalAccountId);
  try {
    switch (req.action) {
      case 'hide':
      case 'unhide': {
        const r = await graphRequest(c, {
          method: 'POST',
          path: [graphId(req.target.externalId)],
          form: { is_hidden: String(req.action === 'hide') },
        });
        if (!success(r.body)) throw new ConnectorError('transient', 'action_not_confirmed');
        return { status: 'applied', platformActionId: null };
      }
      case 'delete': {
        const r = await graphRequest(c, {
          method: 'DELETE',
          path: [graphId(req.target.externalId)],
        });
        if (!success(r.body)) throw new ConnectorError('transient', 'action_not_confirmed');
        return { status: 'applied', platformActionId: null };
      }
      case 'ban_author': {
        const author = await resolveAuthor(cfg, now, ctx, req);
        let body: unknown;
        try {
          body = (
            await graphRequest(c, {
              method: 'POST',
              path: [page, 'blocked'],
              form: { user: author },
            })
          ).body;
        } catch (err) {
          const codes = err instanceof ConnectorError ? graphErrorCodes(err) : null;
          const mapped =
            codes?.code != null && codes.subcode !== OBJECT_MISSING_SUBCODE
              ? BAN_ERRORS[codes.code]
              : undefined;
          if (mapped) throw new ConnectorError('permanent', mapped);
          throw err;
        }
        if ((body as Record<string, unknown> | null)?.[author] !== true) {
          throw new ConnectorError('transient', 'action_not_confirmed');
        }
        return { status: 'applied', platformActionId: author };
      }
      case 'unban_author': {
        const author = await resolveAuthor(cfg, now, ctx, req);
        const r = await graphRequest(c, {
          method: 'DELETE',
          path: [page, 'blocked'],
          query: { user: author },
        });
        if (!success(r.body)) throw new ConnectorError('transient', 'action_not_confirmed');
        return { status: 'applied', platformActionId: author };
      }
      default:
        throw new ConnectorError('unsupported', 'action_not_supported');
    }
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'not_found') return { status: 'not_found' };
    throw err;
  }
}

export async function respond(
  cfg: FacebookConfig,
  now: Now,
  ctx: CallContext,
  req: RespondRequest,
): Promise<RawRespondOutcome> {
  const c = callFor(cfg, now, ctx);
  try {
    if (req.kind === 'public_reply') {
      const r = await graphRequest(c, {
        method: 'POST',
        path: [graphId(req.target.externalId), 'comments'],
        form: { message: req.text },
      });
      const id = (r.body as { id?: unknown } | null)?.id;
      return {
        status: 'sent',
        platformRef: typeof id === 'string' && GRAPH_ID.test(id) ? id : null,
      };
    }
    const r = await graphRequest(c, {
      method: 'POST',
      path: [graphId(ctx.externalAccountId), 'messages'],
      json: {
        recipient: { comment_id: graphId(req.target.externalId) },
        message: { text: req.text },
      },
    });
    const mid = (r.body as { message_id?: unknown } | null)?.message_id;
    return {
      status: 'sent',
      platformRef: typeof mid === 'string' && externalIdSchema.safeParse(mid).success ? mid : null,
    };
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'not_found') return { status: 'not_found' };
    if (err instanceof ConnectorError && req.kind === 'private_reply') {
      const codes = graphErrorCodes(err);
      const hit = PRIVATE_REPLY_INELIGIBLE.find(
        (x) => x.code === codes?.code && (x.subcode === null || x.subcode === codes.subcode),
      );
      if (hit) return { status: 'not_eligible', code: hit.reason };
    }
    throw err;
  }
}

export function lifecycle(cfg: FacebookConfig, now: Now): ConnectorLifecycle {
  return {
    async onConnected(ctx) {
      await subscribePageFields(callFor(cfg, now, ctx), ctx.externalAccountId, cfg.appId, ['feed']);
    },
    async onDisconnected(ctx) {
      try {
        await unsubscribePageFields(callFor(cfg, now, ctx), ctx.externalAccountId, cfg.appId, [
          'feed',
        ]);
      } catch (err) {
        // Access already gone (token revoked, role removed, Page deleted): nothing left to unsubscribe.
        if (
          err instanceof ConnectorError &&
          (err.kind === 'auth_expired' ||
            err.kind === 'not_found' ||
            err.code === 'permission_denied')
        ) {
          return;
        }
        throw err;
      }
    },
  };
}
