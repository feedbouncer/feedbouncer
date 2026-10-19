import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  IDEMPOTENCY_KEY,
  IdempotencyError,
  requestFingerprint,
  type PgIdempotency,
  type RouteSpec,
  type StoredResponse,
} from '@feedbouncer/public-api';
import { ApiError, errorBody } from '../http/errors.js';
import type { ApiKeyRequest } from './api-key.guard.js';

/** One API key's request is retried under the same request key; another key's never is. */
export const requestKey = (apiKeyId: string, idempotencyKey: string | undefined): string =>
  `api:${apiKeyId}:${
    idempotencyKey === undefined
      ? randomUUID()
      : createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
  }`;

/**
 * Runs `work` once per Idempotency-Key and API key, storing its response (client errors included)
 * for replay. Sets the status and replay header on `reply` and returns the body to send.
 */
export async function runIdempotent(
  idempotency: PgIdempotency,
  req: ApiKeyRequest,
  reply: FastifyReply,
  spec: RouteSpec,
  params: Record<string, string>,
  body: unknown,
  work: (idempotencyKey: string | undefined) => Promise<StoredResponse>,
): Promise<unknown> {
  const header = req.headers['idempotency-key'];
  if (header !== undefined && (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)))
    throw new ApiError(400, 'invalid_idempotency_key');

  let result: Awaited<ReturnType<PgIdempotency['run']>>;
  try {
    result = await idempotency.run(
      req.apiKey,
      header,
      requestFingerprint(spec.id, params, body),
      async (): Promise<StoredResponse> => {
        try {
          return await work(header);
        } catch (err) {
          if (err instanceof ApiError && err.status < 500)
            return { status: err.status, body: errorBody(err) };
          throw err;
        }
      },
    );
  } catch (err) {
    if (err instanceof IdempotencyError) throw new ApiError(err.status, err.code);
    throw err;
  }
  void reply.status(result.status);
  if (result.replayed) void reply.header('idempotent-replayed', 'true');
  return result.body;
}
