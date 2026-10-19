import { createHash } from 'node:crypto';
import type pg from 'pg';
import { IDEMPOTENCY_TTL_SECONDS } from './constants.js';
import type { ApiKeyContext } from './keys/store.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

const IN_PROGRESS_TAKEOVER_SECONDS = 60;
const MAX_ATTEMPTS = 3;

export class IdempotencyError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: 'idempotency_key_reused' | 'idempotency_request_in_progress',
  ) {
    super(code);
    this.name = 'IdempotencyError';
  }
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  ) ?? 'null';

export function requestFingerprint(
  routeId: string,
  params: Record<string, string>,
  body: unknown,
): Buffer {
  return createHash('sha256')
    .update(canonical([routeId, Object.entries(params).sort(), body ?? null]))
    .digest();
}

/** Response bodies are stored for replay, so they must never carry a one-time secret. */
export function stripSecrets(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(stripSecrets);
  if (body === null || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body)
      .filter(([k]) => k !== 'secret' && k !== 'token')
      .map(([k, v]) => [k, stripSecrets(v)]),
  );
}

interface Existing {
  id: string;
  state: 'in_progress' | 'completed';
  same: boolean;
  stale: boolean;
  response_status: number | null;
  response_body: unknown;
}

export class PgIdempotency {
  constructor(private readonly pool: pg.Pool) {}

  async run(
    ctx: ApiKeyContext,
    key: string | undefined,
    fingerprint: Buffer,
    fn: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    if (key === undefined) return { ...(await fn()), replayed: false };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const id = await this.#claim(ctx, key, fingerprint);
      if (id !== null) return { ...(await this.#execute(id, fn)), replayed: false };
      const existing = await this.#existing(ctx, key, fingerprint);
      if (!existing) continue;
      if (!existing.same) throw new IdempotencyError(422, 'idempotency_key_reused');
      if (existing.state === 'completed')
        return {
          status: existing.response_status!,
          body: existing.response_body,
          replayed: true,
        };
      if (existing.stale && (await this.#takeOver(existing.id)))
        return { ...(await this.#execute(existing.id, fn)), replayed: false };
      throw new IdempotencyError(409, 'idempotency_request_in_progress');
    }
    throw new IdempotencyError(409, 'idempotency_request_in_progress');
  }

  /** Expired records count as absent; the new record is null when one still stands. */
  async #claim(ctx: ApiKeyContext, key: string, fingerprint: Buffer): Promise<string | null> {
    await this.pool.query(
      `DELETE FROM api_idempotency_record
        WHERE api_key_id = $1 AND idempotency_key = $2 AND expires_at <= now()`,
      [ctx.apiKeyId, key],
    );
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO api_idempotency_record
         (organization_id, api_key_id, idempotency_key, request_sha256, state, expires_at)
       VALUES ($1, $2, $3, $4, 'in_progress', now() + make_interval(secs => $5))
       ON CONFLICT (api_key_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [ctx.organizationId, ctx.apiKeyId, key, fingerprint, IDEMPOTENCY_TTL_SECONDS],
    );
    return r.rows[0]?.id ?? null;
  }

  async #existing(ctx: ApiKeyContext, key: string, fingerprint: Buffer): Promise<Existing | null> {
    const r = await this.pool.query<Existing>(
      `SELECT id, state, request_sha256 = $3 AS same,
              updated_at < now() - make_interval(secs => $4) AS stale,
              response_status, response_body
         FROM api_idempotency_record
        WHERE api_key_id = $1 AND organization_id = $5 AND idempotency_key = $2`,
      [ctx.apiKeyId, key, fingerprint, IN_PROGRESS_TAKEOVER_SECONDS, ctx.organizationId],
    );
    return r.rows[0] ?? null;
  }

  async #takeOver(id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE api_idempotency_record SET state = 'in_progress'
        WHERE id = $1 AND state = 'in_progress'
          AND updated_at < now() - make_interval(secs => $2)`,
      [id, IN_PROGRESS_TAKEOVER_SECONDS],
    );
    return r.rowCount === 1;
  }

  async #execute(id: string, fn: () => Promise<StoredResponse>): Promise<StoredResponse> {
    let response: StoredResponse;
    try {
      response = await fn();
    } catch (err) {
      await this.pool.query('DELETE FROM api_idempotency_record WHERE id = $1', [id]);
      throw err;
    }
    await this.pool.query(
      `UPDATE api_idempotency_record
          SET state = 'completed', response_status = $2, response_body = $3::jsonb
        WHERE id = $1`,
      [id, response.status, JSON.stringify(stripSecrets(response.body))],
    );
    return response;
  }
}

/** Removes up to `batch` expired records per round until none are left; returns how many went. */
export async function purgeExpiredIdempotency(pool: pg.Pool, batch = 1000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM api_idempotency_record
        WHERE id IN (SELECT id FROM api_idempotency_record WHERE expires_at <= now() LIMIT $1)`,
      [batch],
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batch) return total;
  }
}
