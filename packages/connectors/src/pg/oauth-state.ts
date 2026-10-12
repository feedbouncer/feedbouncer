// OAuth authorization state in Postgres. Only SHA-256(state) is stored; the
// PKCE verifier is sealed with the envelope under kind oauth_pkce_verifier,
// bound to the oauth_state row id (so a blob copied between rows will not open).
import type pg from 'pg';
import { CredentialUnreadableError, open, seal, type KeyProvider } from '@feedbouncer/secrets';
import type { OAuthStateStore, PendingAuthorization, StateBinding } from '../ports.js';
import type { Platform } from '../types.js';
import { noNul } from './sanitize.js';

const ctx = (p: { organizationId: string; id: string }) => ({
  organizationId: p.organizationId,
  connectionId: p.id,
  kind: 'oauth_pkce_verifier' as const,
});

export class PgOAuthStateStore implements OAuthStateStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
  ) {}

  async save(stateHash: Buffer, p: PendingAuthorization): Promise<void> {
    const { blob } = await seal(this.keys, p.codeVerifier, ctx(p));
    await this.pool.query(
      `INSERT INTO oauth_state (id, organization_id, brand_id, platform, initiated_by_user_id, reconnect_connection_id,
                                state_hash, encrypted_pkce_verifier, redirect_uri, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11)`,
      [
        p.id,
        p.organizationId,
        p.brandId,
        p.platform,
        p.initiatedByUserId,
        p.reconnectConnectionId,
        stateHash,
        blob,
        p.redirectUri,
        p.scopes.map(noNul),
        p.expiresAt,
      ],
    );
  }

  /** One atomic DELETE ... RETURNING: a mismatched binding matches no row, so nothing is consumed. */
  async consume(stateHash: Buffer, b: StateBinding): Promise<PendingAuthorization | null> {
    const r = await this.pool.query<{
      id: string;
      redirect_uri: string;
      scopes: string[];
      reconnect_connection_id: string | null;
      encrypted_pkce_verifier: Buffer;
      expires_at: Date;
    }>(
      `DELETE FROM oauth_state
        WHERE state_hash = $1 AND organization_id = $2 AND brand_id = $3 AND platform = $4
          AND initiated_by_user_id = $5
       RETURNING id, redirect_uri, scopes, reconnect_connection_id, encrypted_pkce_verifier, expires_at`,
      [stateHash, b.organizationId, b.brandId, b.platform, b.initiatedByUserId],
    );
    const row = r.rows[0];
    if (!row) return null;
    try {
      const codeVerifier = await open(
        this.keys,
        row.encrypted_pkce_verifier,
        ctx({ organizationId: b.organizationId, id: row.id }),
      );
      return {
        id: row.id,
        organizationId: b.organizationId,
        brandId: b.brandId,
        platform: b.platform as Platform,
        initiatedByUserId: b.initiatedByUserId,
        redirectUri: row.redirect_uri,
        scopes: row.scopes,
        reconnectConnectionId: row.reconnect_connection_id,
        codeVerifier,
        expiresAt: row.expires_at,
      };
    } catch (err) {
      if (err instanceof CredentialUnreadableError) return null; // key removed mid-flow: fail closed
      throw err;
    }
  }

  async sweepExpired(): Promise<number> {
    const r = await this.pool.query('DELETE FROM oauth_state WHERE expires_at < now()');
    return r.rowCount ?? 0;
  }
}
