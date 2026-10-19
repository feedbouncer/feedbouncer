import type { CallToolResult } from '@modelcontextprotocol/server';
import { redact } from '@feedbouncer/service-runtime';
import { ApiCallError } from './api-client.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

const INVALID_REQUEST_REASONS: Readonly<Record<string, string>> = {
  to_before_from: '`to` must be after `from`.',
  to_in_future: '`to` must not be in the future.',
};

/** API error messages are fixed texts that never quote request values. */
function invalidRequest(e: ApiCallError, reason: string | undefined): string {
  if (reason !== undefined) {
    return Object.hasOwn(INVALID_REQUEST_REASONS, reason)
      ? `Invalid request: ${INVALID_REQUEST_REASONS[reason]}`
      : `Invalid request (${reason}).`;
  }
  return e.message === e.code ? 'Invalid request.' : `Invalid request: ${e.message}`;
}

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
      return "This API key is read-only. Create a write key on the organization's API keys page.";
    case 'text_too_long':
      return `Reply is longer than the platform allows (max ${num(d.max) ?? 'unknown'}).`;
    case 'reply_not_allowed':
      return str(d.reason) ?? 'A reply is not allowed on this comment.';
    case 'connection_inactive':
      return 'Reconnect the account in FeedBouncer.';
    case 'rule_rejected':
      return `Rule rejected (${str(d.reason) ?? 'unknown reason'}): ${e.message}`;
    case 'unauthenticated':
      return 'The API key was rejected.';
    case 'already_deleted':
    case 'comment_gone':
      return 'The comment was deleted on the platform.';
    case 'invalid_request':
      return invalidRequest(e, str(d.reason));
    case 'pending_limit_reached': {
      const max = num(d.max);
      return `Too many pending rule changes for this brand${max === undefined ? '' : ` (max ${max})`}; ask a person to approve or reject some.`;
    }
    case 'rule_limit_reached': {
      const max = num(d.max);
      return `This brand already has the maximum number of rules${max === undefined ? '' : ` (${max})`}; archive a rule before adding another.`;
    }
    case 'idempotency_key_reused':
      return 'That idempotency key was already used with different input; use a new key.';
    case 'reply_to_hidden_comment':
      return `${str(d.platform) ?? 'This platform'} does not allow replies to hidden comments. Unhide the comment first.`;
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
