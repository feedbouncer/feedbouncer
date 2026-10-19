import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { actionError, idempotencyKey, runTool, text, type ToolDeps } from './common.js';

const input = z.object({
  commentId: z.uuid().describe('ID of the comment to reply to (from list_inbox).'),
  text: z.string().min(1).max(8000).describe('Reply text, posted publicly as the brand.'),
  idempotencyKey,
});

/** Same comment and text give the same key, so a retried call cannot post twice. */
export const defaultReplyKey = (commentId: string, body: string): string =>
  `mcp-reply-${createHash('sha256').update(`${commentId}\n${body}`).digest('hex').slice(0, 40)}`;

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
        const { body } = await deps.api.reply(args.commentId, args.text, key);
        let action = body.action;
        const deadline = Date.now() + deps.replyWaitMs;
        while (action.status === 'pending' && Date.now() < deadline) {
          await sleep(Math.min(deps.pollIntervalMs, Math.max(0, deadline - Date.now())));
          action = await deps.api.getAction(action.id);
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
        result.content.push(...text('Nothing was posted.'));
        return { result, outcome: code };
      }),
  );
}
