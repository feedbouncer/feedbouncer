import { NodeApiError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';

export interface FeedBouncerErrorInfo {
  httpCode: number | null;
  code: string | null;
  message: string;
  description: string;
  retryAfterSeconds?: number;
}

export interface FailureInput {
  status: number | null;
  body: unknown;
  credentialName: string;
  resourceLabel?: string;
  id?: string;
  networkCode?: string;
  /** Hostname (never the full URL) for connection failures. */
  host?: string;
  /** The server's OpenAPI document lacks the operation that returned a plain 404. */
  unsupported?: boolean;
  retryAfterSeconds?: number;
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
]);
const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Server text is untrusted: make sure nothing key-shaped survives into an error. */
function scrub(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, '[redacted]').replace(/(?:fbk|whsec)_\S+/g, '[redacted]');
}

export function apiErrorEnvelope(body: unknown): { code: string; message: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string') return null;
  return { code, message: typeof message === 'string' ? message : '' };
}

export function describeFailure(input: FailureInput): FeedBouncerErrorInfo {
  const { status, body, credentialName, networkCode } = input;
  const envelope = apiErrorEnvelope(body);
  const code = envelope?.code ?? null;
  const info = (message: string, description: string): FeedBouncerErrorInfo => ({
    httpCode: status,
    code,
    message,
    description,
    ...(input.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: input.retryAfterSeconds }),
  });
  const unexpected = () =>
    info(
      `FeedBouncer returned an unexpected response (HTTP ${status}).`,
      'Try again later. If it persists, check the FeedBouncer server logs.',
    );

  if (status === null) {
    if (networkCode && TLS_CODES.has(networkCode)) {
      return info(
        "FeedBouncer's TLS certificate was not accepted.",
        'For a self-signed certificate turn on Ignore SSL Issues in the credential.',
      );
    }
    return info(
      `Could not reach FeedBouncer at ${input.host ?? 'the configured address'}.`,
      'Check the address and that the server is running.',
    );
  }
  if (status >= 300 && status < 400) {
    return info(
      'FeedBouncer redirected the request.',
      "Set the credential's address to the final FeedBouncer address (redirects are not followed so your API key is not sent elsewhere).",
    );
  }
  if (status >= 500) return unexpected();
  if (status === 401) {
    return info(
      `FeedBouncer rejected the API key in credential "${credentialName}".`,
      'The key may be revoked or mistyped. Create a new key in FeedBouncer under Settings → API keys and update the credential.',
    );
  }
  if (status === 403 && code === 'insufficient_scope') {
    return info(
      `The API key in credential "${credentialName}" is read-only.`,
      'This operation needs a Read and write key. Create one in FeedBouncer under Settings → API keys.',
    );
  }
  if (status === 404 && !envelope && input.unsupported) {
    return info(
      'This FeedBouncer server does not support this operation yet.',
      'Update FeedBouncer. This node needs the API operations listed under "Supported versions" in its README.',
    );
  }
  if (status === 404 && envelope) {
    const label = input.resourceLabel ?? 'item';
    if (input.id === undefined) {
      return info('FeedBouncer could not find what was requested.', 'Check the node settings and that the credential points to the right workspace.');
    }
    return info(
      `No ${label} with ID ${input.id} in this FeedBouncer workspace.`,
      `Check the ID, or list ${label}s to find current IDs.`,
    );
  }
  if (status === 429) {
    return info(
      'FeedBouncer rate limit reached.',
      `Retry after ${input.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS} seconds, or space requests out with the node's batching settings.`,
    );
  }
  if (envelope) {
    return info(scrub(envelope.message).slice(0, MAX_MESSAGE_LENGTH), `FeedBouncer error code: ${scrub(envelope.code)}.`);
  }
  return unexpected();
}

/** Built from plain strings only, never from a request or response object. */
export function toNodeApiError(node: INode, info: FeedBouncerErrorInfo, itemIndex?: number): NodeApiError {
  const httpCode = info.httpCode === null ? undefined : String(info.httpCode);
  const error = new NodeApiError(
    node,
    { message: info.message, description: info.description, ...(httpCode && { httpCode }) },
    { message: info.message, description: info.description, httpCode, itemIndex },
  );
  if (info.code) error.context = { ...error.context, code: info.code };
  return error;
}
