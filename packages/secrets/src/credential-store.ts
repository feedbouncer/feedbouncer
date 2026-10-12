// Tenant-scoped access to encrypted credentials. Every query filters by the
// caller's organization, brand AND connection. Values are decrypted per call
// and never cached: use withCredentials around the outbound platform call.
import type pg from 'pg';
import type { Secret } from '@feedbouncer/service-runtime';
import {
  CREDENTIAL_KINDS,
  open,
  seal,
  type CredentialKind,
  type EnvelopeContext,
} from './envelope.js';
import { ConnectionNotFoundError, type CredentialUnreadableError } from './errors.js';
import type { KeyProvider } from './key-provider.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface ConnectionScope {
  readonly organizationId: string;
  readonly brandId: string;
  readonly connectionId: string;
}

export interface StoredCredential {
  readonly kind: CredentialKind;
  readonly value: Secret;
  readonly expiresAt: Date | null;
}

function assertKind(kind: string): asserts kind is CredentialKind {
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind))
    throw new TypeError('Unknown credential kind');
}

const ctxOf = (s: ConnectionScope, kind: CredentialKind): EnvelopeContext => ({
  organizationId: s.organizationId,
  connectionId: s.connectionId,
  kind,
});

const PUT_SQL = `
INSERT INTO connection_secret (organization_id, brand_id, connection_id, kind, key_id, encrypted_value, expires_at)
SELECT c.organization_id, c.brand_id, c.id, $4::text, $5::text, $6::bytea, $7::timestamptz
  FROM connection c
 WHERE c.id = $3 AND c.organization_id = $1 AND c.brand_id = $2
ON CONFLICT (connection_id, kind) DO UPDATE
   SET key_id = EXCLUDED.key_id, encrypted_value = EXCLUDED.encrypted_value, expires_at = EXCLUDED.expires_at
RETURNING id`;

const SELECT_SQL = `
SELECT kind, encrypted_value, expires_at FROM connection_secret
 WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND kind = ANY($4::text[])`;

interface Row {
  kind: string;
  encrypted_value: Buffer;
  expires_at: Date | null;
}

export class CredentialStore {
  constructor(
    private readonly db: Queryable,
    private readonly keys: KeyProvider,
  ) {}

  async put(
    scope: ConnectionScope,
    kind: CredentialKind,
    value: Secret,
    expiresAt: Date | null = null,
  ): Promise<void> {
    assertKind(kind);
    const { keyId, blob } = await seal(this.keys, value, ctxOf(scope, kind));
    const r = await this.db.query(PUT_SQL, [
      scope.organizationId,
      scope.brandId,
      scope.connectionId,
      kind,
      keyId,
      blob,
      expiresAt,
    ]);
    if (r.rowCount !== 1) throw new ConnectionNotFoundError();
  }

  async get(scope: ConnectionScope, kind: CredentialKind): Promise<StoredCredential | null> {
    const map = await this.load(scope, [kind]);
    return map.get(kind) ?? null;
  }

  async withCredentials<T>(
    scope: ConnectionScope,
    kinds: readonly CredentialKind[],
    fn: (creds: ReadonlyMap<CredentialKind, StoredCredential>) => Promise<T>,
  ): Promise<T> {
    return fn(await this.load(scope, kinds));
  }

  async delete(scope: ConnectionScope, kind?: CredentialKind): Promise<number> {
    if (kind !== undefined) assertKind(kind);
    const r = await this.db.query(
      `DELETE FROM connection_secret WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND ($4::text IS NULL OR kind = $4)`,
      [scope.organizationId, scope.brandId, scope.connectionId, kind ?? null],
    );
    return r.rowCount ?? 0;
  }

  private async load(
    scope: ConnectionScope,
    kinds: readonly CredentialKind[],
  ): Promise<Map<CredentialKind, StoredCredential>> {
    kinds.forEach(assertKind);
    const r = await this.db.query<Row>(SELECT_SQL, [
      scope.organizationId,
      scope.brandId,
      scope.connectionId,
      [...kinds],
    ]);
    const out = new Map<CredentialKind, StoredCredential>();
    for (const row of r.rows) {
      assertKind(row.kind);
      out.set(row.kind, {
        kind: row.kind,
        value: await open(this.keys, row.encrypted_value, ctxOf(scope, row.kind)),
        expiresAt: row.expires_at,
      });
    }
    return out;
  }
}

/**
 * Flags the connection for reconnect and audits it, atomically and at most once.
 * The audit event records the status the connection had (previousStatus) so a
 * later recheck can restore exactly that status.
 */
export async function markReconnectRequired(
  db: Queryable,
  scope: ConnectionScope,
  err: CredentialUnreadableError,
): Promise<boolean> {
  const r = await db.query(
    `WITH prev AS (
       SELECT id, status FROM connection
        WHERE id = $3 AND organization_id = $1 AND brand_id = $2
          AND status IN ('active', 'paused', 'error')
          FOR UPDATE),
     flagged AS (
       UPDATE connection c SET status = 'reconnect_required', status_reason = $4
         FROM prev
        WHERE c.id = prev.id AND c.status IN ('active', 'paused', 'error')
       RETURNING c.id, c.organization_id, c.brand_id, prev.status AS previous_status)
     INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, details)
     SELECT organization_id, brand_id, 'system', 'connection.reconnect_required', 'connection', id,
            jsonb_build_object('reason', $5::text, 'keyId', $6::text, 'previousStatus', previous_status)
       FROM flagged
     RETURNING id`,
    [
      scope.organizationId,
      scope.brandId,
      scope.connectionId,
      `credential_${err.reason}`,
      err.reason,
      err.keyId,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}
