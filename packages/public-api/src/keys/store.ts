import { randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { isUniqueViolation, recordAuditEvent, withTransaction } from '@feedbouncer/db';
import type { Secret } from '@feedbouncer/service-runtime';
import { generateApiKey, parseApiKey, type ApiKeyScope } from './token.js';

export const MAX_ACTIVE_KEYS = 10;

const ACTIVE_NAME_INDEX = 'api_key_active_name_key';
const LAST_USED_INTERVAL = '60 seconds';
const DUMMY_HASH = randomBytes(32);

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`An organization can have at most ${MAX_ACTIVE_KEYS} active API keys`);
    this.name = 'ApiKeyLimitError';
  }
}

export class ApiKeyNameTakenError extends Error {
  constructor() {
    super('An active API key with this name already exists');
    this.name = 'ApiKeyNameTakenError';
  }
}

export interface ApiKeyRow {
  id: string;
  organizationId: string;
  name: string;
  publicId: string;
  scope: ApiKeyScope;
  createdAt: Date;
  createdByUserId: string | null;
  createdByName: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyContext {
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly scope: ApiKeyScope;
}

const SELECT = `SELECT k.id, k.organization_id, k.name, k.public_id, k.scope, k.created_at,
    k.created_by_user_id, coalesce(u.display_name, u.email) AS created_by_name,
    k.last_used_at, k.revoked_at
  FROM api_key k LEFT JOIN app_user u ON u.id = k.created_by_user_id`;

interface Row {
  id: string;
  organization_id: string;
  name: string;
  public_id: string;
  scope: ApiKeyScope;
  created_at: Date;
  created_by_user_id: string | null;
  created_by_name: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toKey = (r: Row): ApiKeyRow => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  publicId: r.public_id,
  scope: r.scope,
  createdAt: r.created_at,
  createdByUserId: r.created_by_user_id,
  createdByName: r.created_by_name,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export class PgApiKeys {
  constructor(private readonly pool: pg.Pool) {}

  async create(
    org: string,
    actorUserId: string,
    input: { name: string; scope: ApiKeyScope },
  ): Promise<{ key: ApiKeyRow; token: Secret }> {
    const { publicId, token, secretSha256 } = generateApiKey();
    try {
      const key = await withTransaction(this.pool, async (tx) => {
        await tx.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [org]);
        const active = await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM api_key WHERE organization_id = $1 AND revoked_at IS NULL',
          [org],
        );
        if (active.rows[0]!.n >= MAX_ACTIVE_KEYS) throw new ApiKeyLimitError();
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO api_key (organization_id, name, public_id, secret_sha256, scope, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [org, input.name, publicId, secretSha256, input.scope, actorUserId],
        );
        const id = rows[0]!.id;
        await recordAuditEvent(tx, {
          organizationId: org,
          actorType: 'user',
          actorUserId,
          action: 'api_key.created',
          subjectType: 'api_key',
          subjectId: id,
          details: { publicId, scope: input.scope },
        });
        const created = await tx.query<Row>(`${SELECT} WHERE k.id = $1`, [id]);
        return toKey(created.rows[0]!);
      });
      return { key, token };
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_NAME_INDEX)) throw new ApiKeyNameTakenError();
      throw err;
    }
  }

  async list(org: string): Promise<ApiKeyRow[]> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT} WHERE k.organization_id = $1
       ORDER BY (k.revoked_at IS NOT NULL), k.created_at DESC, k.id DESC`,
      [org],
    );
    return rows.map(toKey);
  }

  async get(org: string, keyId: string): Promise<ApiKeyRow | null> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT} WHERE k.organization_id = $1 AND k.id = $2`,
      [org, keyId],
    );
    return rows[0] ? toKey(rows[0]) : null;
  }

  async revoke(org: string, actorUserId: string, keyId: string): Promise<ApiKeyRow | null> {
    return withTransaction(this.pool, async (tx) => {
      const revoked = await tx.query<{ public_id: string }>(
        `UPDATE api_key SET revoked_at = now(), revoked_by_user_id = $3
          WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING public_id`,
        [org, keyId, actorUserId],
      );
      if (revoked.rows[0]) {
        await recordAuditEvent(tx, {
          organizationId: org,
          actorType: 'user',
          actorUserId,
          action: 'api_key.revoked',
          subjectType: 'api_key',
          subjectId: keyId,
          details: { publicId: revoked.rows[0].public_id },
        });
      }
      const { rows } = await tx.query<Row>(`${SELECT} WHERE k.organization_id = $1 AND k.id = $2`, [
        org,
        keyId,
      ]);
      return rows[0] ? toKey(rows[0]) : null;
    });
  }

  async authenticate(raw: string): Promise<ApiKeyContext | null> {
    const parsed = parseApiKey(raw);
    if (!parsed) return null;
    const { rows } = await this.pool.query<{
      id: string;
      organization_id: string;
      scope: ApiKeyScope;
      secret_sha256: Buffer;
      revoked_at: Date | null;
    }>(
      `SELECT k.id, k.organization_id, k.scope, k.secret_sha256, k.revoked_at
         FROM api_key k JOIN organization o ON o.id = k.organization_id
        WHERE k.public_id = $1`,
      [parsed.publicId],
    );
    const row = rows[0];
    const matches = timingSafeEqual(row?.secret_sha256 ?? DUMMY_HASH, parsed.secretSha256);
    if (!row || !matches || row.revoked_at) return null;
    await this.pool.query(
      `UPDATE api_key SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '${LAST_USED_INTERVAL}')`,
      [row.id],
    );
    return { organizationId: row.organization_id, apiKeyId: row.id, scope: row.scope };
  }
}
