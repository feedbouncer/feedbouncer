import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiCallError } from '../api-client.js';
import { toToolError } from '../errors.js';
import { actionError, idempotencyKey, runTool, text, type ToolDeps } from './common.js';

const input = z.object({
  commentId: z.uuid().describe('ID of the comment to reply to (from list_inbox).'),
  text: z.string().min(1).max(8000).describe('Reply text, posted publicly as the brand.'),
  idempotencyKey,
});

/** Same comment and text give the same key, so a retried call cannot post twice. */
export const defaultReplyKey = (commentId: string, body: string): string =>
  `mcp-reply-${createHash('sha256').update(`${commentId}\n${body}`).digest('hex').slice(0, 40)}`;

const NOTHING_POSTED = 'Nothing was posted.';
/**
 * The API keeps a refused or failed reply under its key for good, so a retry with the same key
 * (or, without one, the same text) returns the same refusal. A new key makes a fresh attempt.
 */
const RETRY_WITH_NEW_KEY = 'To retry after fixing this, call again with a new idempotencyKey.';

/** Refusals the API stores under the request's key. */
const STORED_REFUSALS: ReadonlySet<string> = new Set([
  'connection_inactive',
  'reply_not_allowed',
  'text_too_long',
  'unsupported_action',
]);

export function registerReply(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to comment',
      description:
        'Posts a public reply as the brand under a comment. Acts on the live social platform. Retrying with the same text never posts twice.',
      inputSchema: input,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool(deps, 'reply_to_comment', args.commentId, async () => {
        const key = args.idempotencyKey ?? defaultReplyKey(args.commentId, args.text);
        let body;
        try {
          ({ body } = await deps.api.reply(args.commentId, args.text, key));
        } catch (e) {
          if (!(e instanceof ApiCallError) || !STORED_REFUSALS.has(e.code)) throw e;
          const result = toToolError(e);
          result.content.push(...text(NOTHING_POSTED, RETRY_WITH_NEW_KEY));
          return { result, outcome: e.code };
        }
        let action = body.action;
        const deadline = Date.now() + deps.replyWaitMs;
        while (action.status === 'pending' && Date.now() < deadline) {
          await sleep(Math.min(deps.pollIntervalMs, Math.max(0, deadline - Date.now())));
          try {
            action = await deps.api.getAction(action.id);
          } catch (e) {
            const result = toToolError(e);
            const retry = args.idempotencyKey === undefined ? 'text' : 'idempotencyKey';
            result.content.push(
              ...text(
                `The reply was accepted (action ${action.id}) but its status could not be checked. Retrying with the same ${retry} is safe; it will not post twice.`,
              ),
            );
            return { result, outcome: 'status_unknown' };
          }
        }

        if (action.status === 'applied') {
          return {
            result: {
              content: text(`Reply posted (action ${action.id}).`),
              structuredContent: {
                status: 'posted',
                replyId: action.platformRef,
                actionId: action.id,
              },
            },
            outcome: 'posted',
          };
        }
        if (action.status === 'pending') {
          return {
            result: {
              content: text('Queued; calling again with the same text will not post twice.'),
              structuredContent: { status: 'queued', actionId: action.id },
            },
            outcome: 'queued',
          };
        }
        const { result, code } = actionError(action, body.comment.platform);
        result.content.push(
          ...text(
            NOTHING_POSTED,
            ...(action.status === 'failed' || action.status === 'not_eligible'
              ? [RETRY_WITH_NEW_KEY]
              : []),
          ),
        );
        return { result, outcome: code };
      }),
  );
}
