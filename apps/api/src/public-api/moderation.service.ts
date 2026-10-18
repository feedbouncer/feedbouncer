import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PgTriage } from '@feedbouncer/actions';
import {
  loadPublicComment,
  toCommentResource,
  type ApiKeyContext,
  type StoredResponse,
} from '@feedbouncer/public-api';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound, type ErrorCode } from '../http/errors.js';
import { DEPS } from '../tokens.js';

type ModerationKind = 'hide' | 'unhide';

const REFUSALS: Readonly<Record<string, readonly [409 | 422, ErrorCode]>> = {
  connection_needs_reconnect: [409, 'connection_inactive'],
  connection_inactive: [409, 'connection_inactive'],
  unsupported: [422, 'unsupported_action'],
  request_key_conflict: [422, 'idempotency_key_reused'],
};

/** One API key's request is retried under the same moderation key; another key's never is. */
const requestKey = (apiKeyId: string, idempotencyKey: string | undefined): string =>
  `api:${apiKeyId}:${
    idempotencyKey === undefined
      ? randomUUID()
      : createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
  }`;

@Injectable()
export class PublicModerationService {
  readonly #triage: PgTriage;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#triage = new PgTriage(deps.pool, { log: deps.log });
  }

  /** 202 when the action was queued, 200 when its outcome was known up front. */
  async moderate(
    key: ApiKeyContext,
    kind: ModerationKind,
    commentId: string,
    idempotencyKey: string | undefined,
  ): Promise<StoredResponse> {
    const { pool } = this.deps;
    const visible = await loadPublicComment(pool, key.organizationId, commentId);
    const scope = visible && (await this.#triage.commentScope(key.organizationId, commentId));
    if (!scope) throw notFound();
    const actions = this.deps.comments?.actions;
    if (!actions) throw new ApiError(503, 'temporarily_unavailable');

    const r = await actions.request({
      scope,
      commentId,
      kind,
      actor: { type: 'api_key', apiKeyId: key.apiKeyId },
      requestKey: requestKey(key.apiKeyId, idempotencyKey),
    });
    if (r.status === 'refused') {
      if (r.code === 'not_found') throw notFound();
      const refusal = Object.hasOwn(REFUSALS, r.code) ? REFUSALS[r.code] : undefined;
      if (!refusal) throw new Error(`unexpected refusal ${r.code}`);
      throw new ApiError(...refusal);
    }
    const comment = await loadPublicComment(pool, key.organizationId, commentId);
    if (!comment) throw notFound();
    return {
      status: r.status === 'accepted' ? 202 : 200,
      body: {
        action: {
          id: r.action.id,
          kind,
          status: r.action.status,
          code: r.action.outcomeCode,
        },
        comment: toCommentResource(comment),
      },
    };
  }
}
