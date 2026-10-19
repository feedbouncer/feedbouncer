import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PgTriage } from '@feedbouncer/actions';
import type { ModerationActionView, RequestActionResult } from '@feedbouncer/comments';
import {
  loadPublicAction,
  loadPublicComment,
  toActionResource,
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

/** Refusals that tell the caller why a reply is not allowed. */
const REPLY_REFUSALS: ReadonlySet<string> = new Set(['review_mode_active', 'moderator_override']);

function refusalError(r: Extract<RequestActionResult, { status: 'refused' }>): Error {
  if (r.code === 'not_found') return notFound();
  if (r.code === 'text_too_long' && 'max' in r)
    return new ApiError(422, 'text_too_long', undefined, { max: r.max });
  if (REPLY_REFUSALS.has(r.code))
    return new ApiError(422, 'reply_not_allowed', undefined, { reason: r.code });
  const refusal = Object.hasOwn(REFUSALS, r.code) ? REFUSALS[r.code] : undefined;
  return refusal ? new ApiError(...refusal) : new Error(`unexpected refusal ${r.code}`);
}

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
    const { status, action, comment } = await this.#request(key, commentId, kind, idempotencyKey);
    return {
      status,
      body: {
        action: { id: action.id, kind, status: action.status, code: action.outcomeCode },
        comment,
      },
    };
  }

  /** Same statuses as `moderate`; the action is read back whole for its timestamps. */
  async reply(
    key: ApiKeyContext,
    commentId: string,
    text: string,
    idempotencyKey: string | undefined,
  ): Promise<StoredResponse> {
    const { status, action, comment } = await this.#request(
      key,
      commentId,
      'public_reply',
      idempotencyKey,
      text,
    );
    const row = await loadPublicAction(this.deps.pool, key.organizationId, action.id);
    if (!row) throw notFound();
    return { status, body: { action: toActionResource(row), comment } };
  }

  async #request(
    key: ApiKeyContext,
    commentId: string,
    kind: ModerationKind | 'public_reply',
    idempotencyKey: string | undefined,
    text?: string,
  ): Promise<{
    status: 200 | 202;
    action: ModerationActionView;
    comment: ReturnType<typeof toCommentResource>;
  }> {
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
      ...(text !== undefined && { text }),
    });
    if (r.status === 'refused') throw refusalError(r);
    const comment = await loadPublicComment(pool, key.organizationId, commentId);
    if (!comment) throw notFound();
    return {
      status: r.status === 'accepted' ? 202 : 200,
      action: r.action,
      comment: toCommentResource(comment),
    };
  }
}
