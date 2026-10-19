import type { CallToolResult } from '@modelcontextprotocol/server';
import { redact } from '@feedbouncer/service-runtime';
import { ApiCallError } from './api-client.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function messageFor(e: ApiCallError): string {
  const d = e.details ?? {};
  switch (e.code) {
    case 'not_found':
      return 'No comment/rule/brand with that ID in this workspace. List the inbox to get current IDs.';
    case 'unsupported_action':
      return `${str(d.platform) ?? 'This platform'} does not support this action.`;
    case 'rate_limited':
      return e.retryAfterSeconds === undefined
        ? 'Rate limited. Retry later.'
        : `Rate limited. Retry after ${e.retryAfterSeconds} seconds.`;
    case 'insufficient_scope':
      return 'This API key is read-only. Create a write key in Settings → API keys.';
    case 'text_too_long':
      return `Reply is longer than the platform allows (max ${typeof d.max === 'number' ? d.max : 'unknown'}).`;
    case 'reply_not_allowed':
      return str(d.reason) ?? 'A reply is not allowed on this comment.';
    case 'connection_inactive':
      return 'Reconnect the account in FeedBouncer.';
    case 'rule_rejected':
      return `Rule rejected (${str(d.reason) ?? 'unknown reason'}): ${e.message}`;
    case 'unauthenticated':
      return 'The API key was rejected.';
    default:
      return `FeedBouncer API error (${e.code}).`;
  }
}

export function toToolError(e: unknown): CallToolResult {
  let text: string;
  if (e instanceof ApiCallError) {
    text = messageFor(e);
  } else {
    process.stderr.write(`${redact(e instanceof Error ? (e.stack ?? e.message) : String(e))}\n`);
    text = 'Internal error';
  }
  return { isError: true, content: [{ type: 'text', text }] };
}
