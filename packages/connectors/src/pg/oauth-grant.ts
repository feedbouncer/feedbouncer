// Multi-account OAuth grants. The user token is sealed under envelope kind
// oauth_grant_token (its refresh token, if any, under oauth_grant_refresh_token),
// bound to the grant row id, so a blob copied between rows will not open.
// Single-use: consume() is one atomic DELETE ... RETURNING.
import type pg from 'pg';
import { CredentialUnreadableError, open, seal, type KeyProvider } from '@feedbouncer/secrets';
import { UUID } from '@feedbouncer/service-runtime';
import type { OAuthGrantStore, PendingGrant, StateBinding } from '../ports.js';
import type { Platform } from '../types.js';
import { noNul } from './sanitize.js';

const ctx = (
  organizationId: string,
  id: string,
  kind: 'oauth_grant_token' | 'oauth_grant_refresh_token' = 'oauth_grant_token',
) => ({ organizationId, connectionId: id, kind });
type Row = {
  id: string;
  reconnect_connection_id: string | null;
  encrypted_user_token: Buffer;
  user_access_expires_at: Date | null;
  encrypted_refresh_token: Buffer | null;
  refresh_expires_at: Date | null;
  granted_scopes: string[];
  expires_at: Date;
};
const COLS = `id, reconnect_connection_id, encrypted_user_token, user_access_expires_at,
              encrypted_refresh_token, refresh_expires_at, granted_scopes, expires_at`;
const WHERE = `id = $1 AND organization_id = $2 AND brand_id = $3 AND platform = $4
               AND initiated_by_user_id = $5 AND expires_at > now()`;

export class PgOAuthGrantStore implements OAuthGrantStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
  ) {}

  async save(g: PendingGrant): Promise<void> {
    const { blob } = await seal(this.keys, g.userToken, ctx(g.organizationId, g.id));
    const refresh = g.refreshToken
      ? (
          await seal(
            this.keys,
            g.refreshToken,
            ctx(g.organizationId, g.id, 'oauth_grant_refresh_token'),
          )
        ).blob
      : null;
    // Abandoned grants are removed on the way in, so no scheduler is needed.
    await this.pool.query('DELETE FROM oauth_grant WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO oauth_grant (id, organization_id, brand_id, platform, initiated_by_user_id, reconnect_connection_id,
                                encrypted_user_token, user_access_expires_at, encrypted_refresh_token,
                                refresh_expires_at, granted_scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12)`,
      [
        g.id,
        g.organizationId,
        g.brandId,
        g.platform,
        g.initiatedByUserId,
        g.reconnectConnectionId,
        blob,
        g.userTokenExpiresAt ?? null,
        refresh,
        refresh ? (g.refreshTokenExpiresAt ?? null) : null,
        g.grantedScopes.map(noNul),
        g.expiresAt,
      ],
    );
  }

  load(id: string, b: StateBinding): Promise<PendingGrant | null> {
    return this.#one(`SELECT ${COLS} FROM oauth_grant WHERE ${WHERE}`, id, b);
  }

  consume(id: string, b: StateBinding): Promise<PendingGrant | null> {
    return this.#one(`DELETE FROM oauth_grant WHERE ${WHERE} RETURNING ${COLS}`, id, b);
  }

  async #one(sql: string, id: string, b: StateBinding): Promise<PendingGrant | null> {
    if (!UUID.test(id)) return null;
    const r = await this.pool.query<Row>(sql, [
      id,
      b.organizationId,
      b.brandId,
      b.platform,
      b.initiatedByUserId,
    ]);
    const row = r.rows[0];
    if (!row) return null;
    try {
      return {
        id: row.id,
        organizationId: b.organizationId,
        brandId: b.brandId,
        platform: b.platform as Platform,
        initiatedByUserId: b.initiatedByUserId,
        reconnectConnectionId: row.reconnect_connection_id,
        userToken: await open(this.keys, row.encrypted_user_token, ctx(b.organizationId, row.id)),
        userTokenExpiresAt: row.user_access_expires_at,
        refreshToken: row.encrypted_refresh_token
          ? await open(
              this.keys,
              row.encrypted_refresh_token,
              ctx(b.organizationId, row.id, 'oauth_grant_refresh_token'),
            )
          : null,
        refreshTokenExpiresAt: row.refresh_expires_at,
        grantedScopes: row.granted_scopes,
        expiresAt: row.expires_at,
      };
    } catch (err) {
      if (err instanceof CredentialUnreadableError) return null; // key removed mid-flow: fail closed
      throw err;
    }
  }
}
