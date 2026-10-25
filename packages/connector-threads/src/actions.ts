// Writes: hide/unhide a reply and publish a public reply. Meta's messages and bodies never
// reach an error; only the codes mapped in errors.ts do.
import {
  ConnectorError,
  type ActionRequest,
  type RawActionOutcome,
  type RawRespondOutcome,
  type RespondRequest,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import { threadsRequest, type ThreadsCall, type ThreadsEndpoint } from './api.js';
import { THREADS_REPLY_QUOTA_RETRY_SEC } from './config.js';
import { MEDIA_ID } from './ids.js';

const MANAGE = z.object({ success: z.boolean() });
const CREATED = z.object({ id: z.string().regex(MEDIA_ID) });
const LIMIT = z.object({
  data: z
    .array(
      z.object({
        reply_quota_usage: z.number(),
        reply_config: z.object({ quota_total: z.number() }),
      }),
    )
    .min(1),
});

const SCOPE: Readonly<Partial<Record<ThreadsEndpoint, string>>> = {
  manageReply: 'threads_manage_replies',
  publishingLimit: 'threads_content_publish',
  createContainer: 'threads_content_publish',
  publish: 'threads_content_publish',
};

const isCode = (e: unknown, code: string): e is ConnectorError =>
  e instanceof ConnectorError && e.code === code;

/** Runs one call; a refused permission becomes missing_permission naming the endpoint's scope. */
async function step<T>(endpoint: ThreadsEndpoint, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const scope = SCOPE[endpoint];
    if (scope !== undefined && isCode(e, 'permission_denied')) {
      throw new ConnectorError('permanent', 'missing_permission', { missingScopes: [scope] });
    }
    throw e;
  }
}

const quotaExhausted = () =>
  new ConnectorError('rate_limited', 'reply_quota_exhausted', {
    retryAfterMs: THREADS_REPLY_QUOTA_RETRY_SEC * 1000,
  });

export async function act(call: ThreadsCall, req: ActionRequest): Promise<RawActionOutcome> {
  if (req.action !== 'hide' && req.action !== 'unhide') {
    throw new ConnectorError('unsupported', 'unsupported_action');
  }
  try {
    const { data } = await step('manageReply', () =>
      threadsRequest(call, {
        endpoint: 'manageReply',
        id: req.target.externalId,
        method: 'POST',
        form: { hide: String(req.action === 'hide') },
        schema: MANAGE,
      }),
    );
    if (!data.success) throw new ConnectorError('transient', 'action_not_confirmed');
    return { status: 'applied', platformActionId: null };
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === 'not_found') return { status: 'not_found' };
    throw e;
  }
}

/** Checks the quota first, then creates a reply container and publishes it. */
export async function respond(
  call: ThreadsCall & { userId: string },
  req: RespondRequest,
): Promise<RawRespondOutcome> {
  if (req.kind !== 'public_reply') throw new ConnectorError('unsupported', 'unsupported_response');
  try {
    const limit = await step('publishingLimit', () =>
      threadsRequest(call, {
        endpoint: 'publishingLimit',
        id: call.userId,
        method: 'GET',
        query: { fields: 'reply_quota_usage,reply_config' },
        schema: LIMIT,
      }),
    );
    const quota = limit.data.data[0]!;
    if (quota.reply_quota_usage >= quota.reply_config.quota_total) throw quotaExhausted();

    const container = await step('createContainer', () =>
      threadsRequest(call, {
        endpoint: 'createContainer',
        method: 'POST',
        form: { media_type: 'TEXT', text: req.text, reply_to_id: req.target.externalId },
        schema: CREATED,
      }),
    );
    const published = await step('publish', () =>
      threadsRequest(call, {
        endpoint: 'publish',
        id: call.userId,
        method: 'POST',
        form: { creation_id: container.data.id },
        schema: CREATED,
      }),
    );
    return { status: 'sent', platformRef: published.data.id };
  } catch (e) {
    if (isCode(e, 'reply_quota_exhausted')) throw quotaExhausted();
    if (e instanceof ConnectorError && e.kind === 'not_found') return { status: 'not_found' };
    throw e;
  }
}
