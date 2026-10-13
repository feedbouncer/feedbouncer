// Instagram moderation actions, replies and the Page webhook subscription. Every
// id is checked with graphId before any request; Graph error messages are never
// read and reply text never appears in an error. Lifecycle subscriptions merge
// with the Facebook connector's fields on the same Page (see subscriptions.ts).
import {
  ConnectorError,
  type ActionRequest,
  type CallContext,
  type ConnectorLifecycle,
  type RawActionOutcome,
  type RawRespondOutcome,
  type RespondRequest,
} from '@feedbouncer/connectors';
import {
  callFor,
  GRAPH_ID,
  graphId,
  graphRequest,
  subscribePageFields,
  unsubscribePageFields,
} from '@feedbouncer/connector-facebook';
import type { InstagramConfig } from './config.js';
import { mapInstagramError, type IgOp } from './errors.js';

/** Max code points per reply kind. UNVERIFIED (V7 in the README). */
export const IG_LIMITS = { public_reply: 2200, private_reply: 1000 } as const;
/** Page webhook fields this connector needs. UNVERIFIED (V1); the fallback is ['feed'] plus retaining it. */
export const INSTAGRAM_PAGE_FIELDS = ['comments'] as const;

type Now = () => number;

const success = (body: unknown) => (body as { success?: unknown } | null)?.success === true;

/** Maps a Graph failure through the Instagram table; only ConnectorErrors are refined. */
function refine(e: unknown, op: IgOp): { notEligible: string } | never {
  if (!(e instanceof ConnectorError)) throw e;
  const mapped = mapInstagramError(e, op);
  if ('throw' in mapped) throw mapped.throw;
  return mapped;
}

export function act(
  cfg: InstagramConfig,
  nowMs: Now,
): (ctx: CallContext, req: ActionRequest) => Promise<RawActionOutcome> {
  return async (ctx, req) => {
    if (req.action !== 'hide' && req.action !== 'unhide' && req.action !== 'delete') {
      throw new ConnectorError('unsupported', 'action_not_supported');
    }
    const id = graphId(req.target.externalId);
    const c = callFor(cfg.meta, nowMs, ctx);
    try {
      const r =
        req.action === 'delete'
          ? await graphRequest(c, { method: 'DELETE', path: [id] })
          : await graphRequest(c, {
              method: 'POST',
              path: [id],
              form: { hide: String(req.action === 'hide') },
            });
      if (!success(r.body)) throw new ConnectorError('transient', 'action_not_confirmed');
      return { status: 'applied', platformActionId: null };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'not_found') return { status: 'not_found' };
      if (!(e instanceof ConnectorError)) throw e;
      const mapped = mapInstagramError(e, 'moderate');
      throw 'throw' in mapped ? mapped.throw : e;
    }
  };
}

export function respond(
  cfg: InstagramConfig,
  nowMs: Now,
): (ctx: CallContext, req: RespondRequest) => Promise<RawRespondOutcome> {
  return async (ctx, req) => {
    const kind = req.kind;
    if (kind !== 'public_reply' && kind !== 'private_reply') {
      throw new ConnectorError('unsupported', 'response_not_supported');
    }
    const target = graphId(req.target.externalId);
    const account = graphId(ctx.externalAccountId);
    // Code points, not UTF-16 units. A backstop: the API refuses over-long text itself.
    if ([...req.text].length > IG_LIMITS[kind]) {
      return { status: 'not_eligible', code: 'reply_too_long' };
    }
    const c = callFor(cfg.meta, nowMs, ctx);
    try {
      if (kind === 'public_reply') {
        const r = await graphRequest(c, {
          method: 'POST',
          path: [target, 'replies'],
          form: { message: req.text },
        });
        const id = (r.body as { id?: unknown } | null)?.id;
        return {
          status: 'sent',
          platformRef: typeof id === 'string' && GRAPH_ID.test(id) ? id : null,
        };
      }
      await graphRequest(c, {
        method: 'POST',
        path: [account, 'messages'],
        json: { recipient: { comment_id: target }, message: { text: req.text } },
      });
      // The message id is opaque and never stored.
      return { status: 'sent', platformRef: null };
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === 'not_found') return { status: 'not_found' };
      const mapped = refine(e, kind);
      return { status: 'not_eligible', code: mapped.notEligible };
    }
  };
}

export function lifecycle(cfg: InstagramConfig, nowMs: Now): ConnectorLifecycle {
  return {
    async onConnected(ctx) {
      await subscribePageFields(
        callFor(cfg.meta, nowMs, ctx),
        'me',
        cfg.meta.appId,
        INSTAGRAM_PAGE_FIELDS,
      );
    },
    async onDisconnected(ctx) {
      try {
        await unsubscribePageFields(
          callFor(cfg.meta, nowMs, ctx),
          'me',
          cfg.meta.appId,
          INSTAGRAM_PAGE_FIELDS,
        );
      } catch (err) {
        // Access already gone (token revoked, role removed, Page deleted): nothing to unsubscribe.
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
