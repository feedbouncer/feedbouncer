// Ads discovered through a meta_ads connection, the Page/IG sources they show,
// and per-source polling state. An ad's post is a source under the Facebook or
// Instagram connection of the SAME organization and brand; nothing here crosses
// tenants except `connectionsWithDueSources`, which returns ids only.
// Pollability is computed at query time (no stored flag): the source's
// connection is active, and some linked ad of an active meta_ads connection is
// active or retired within the grace period.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { AdLookup } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { PgCommentStore } from '../store.js';

export type FacebookResolution =
  | 'linked'
  | 'no_post'
  | 'dynamic_creative_unsupported'
  | 'post_deleted'
  | 'invalid_platform_id'
  | 'page_not_connected';
export type InstagramResolution =
  | 'linked'
  | 'not_instagram'
  | 'post_deleted'
  | 'instagram_media_pending'
  | 'invalid_platform_id'
  | 'instagram_account_not_connected';

export interface DiscoveredAdRow {
  externalId: string;
  name: string | null;
  adAccountExternalId: string;
  effectiveStatus: string;
  active: boolean;
  facebook: {
    sourceExternalId: string | null;
    resolution: FacebookResolution;
    connection: ConnectionScope | null;
  };
  instagram: {
    sourceExternalId: string | null;
    accountExternalId: string | null;
    resolution: InstagramResolution;
    connection: ConnectionScope | null;
  };
}

/** Keyed by the connection's external account id (Page id / IG user id). */
export interface BrandMetaConnections {
  facebook: Map<string, ConnectionScope>;
  instagram: Map<string, ConnectionScope>;
}

export interface DueSource {
  sourceId: string;
  sourceExternalId: string;
  highWaterAt: Date | null;
  resumeCursor: string | null;
  resumeBoundary: Date | null;
  /** Newest top-level comment seen by the passes so far, carried across resumed jobs. */
  resumeNewestAt: Date | null;
  lastFullScanAt: Date | null;
}

export type PollProgress =
  | { kind: 'resume'; cursor: string; boundary: Date | null; newestAt: Date | null; at: Date }
  | {
      kind: 'done';
      highWaterAt: Date | null;
      lastCommentAt: Date | null;
      fullScan: boolean;
      at: Date;
      nextPollAt: Date;
    }
  | { kind: 'unavailable'; code: string; at: Date; retryAt: Date }
  /** Not polled now (throttle, transient failure): keeps any resume cursor, due again at `retryAt`. */
  | { kind: 'defer'; retryAt: Date };

const outOfScope = () => new Error('ad tracking: connection is not in the given scope');
const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

/** Over `source_poll sp` and its source's connection `c`; `$at` and `$grace` are parameter refs. */
const DUE_SQL = (at: string, grace: string) => `
  c.status = 'active'
  AND sp.next_poll_at <= ${at}
  AND EXISTS (
    SELECT 1 FROM meta_ad_source mas
    JOIN meta_ad ma ON ma.id = mas.ad_id AND ma.organization_id = mas.organization_id
                   AND ma.brand_id = mas.brand_id
    JOIN connection ac ON ac.id = ma.ads_connection_id AND ac.organization_id = ma.organization_id
                      AND ac.brand_id = ma.brand_id
    WHERE mas.organization_id = sp.organization_id AND mas.brand_id = sp.brand_id
      AND mas.source_id = sp.source_id
      AND mas.unlinked_at IS NULL
      AND ac.status = 'active'
      AND (ma.active OR ma.inactive_since > ${at} - make_interval(days => ${grace})))`;

const POLL_FROM_SQL = `
  FROM source_poll sp
  JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
               AND s.brand_id = sp.brand_id AND s.connection_id = sp.connection_id
  JOIN connection c ON c.id = sp.connection_id AND c.organization_id = sp.organization_id
                   AND c.brand_id = sp.brand_id`;

export class PgAdTracking {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: PgCommentStore,
  ) {}

  async brandMetaConnections(adsScope: ConnectionScope): Promise<BrandMetaConnections> {
    const r = await this.pool.query<{
      organization_id: string;
      brand_id: string;
      id: string;
      platform: 'facebook' | 'instagram';
      external_account_id: string;
    }>(
      `SELECT organization_id, brand_id, id, platform, external_account_id FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND platform IN ('facebook', 'instagram')
          AND status <> 'revoked'`,
      [adsScope.organizationId, adsScope.brandId],
    );
    const out: BrandMetaConnections = { facebook: new Map(), instagram: new Map() };
    for (const c of r.rows)
      out[c.platform].set(c.external_account_id, {
        organizationId: c.organization_id,
        brandId: c.brand_id,
        connectionId: c.id,
      });
    return out;
  }

  /** All ads of one listing page in a single transaction. */
  async recordAds(
    adsScope: ConnectionScope,
    ads: readonly DiscoveredAdRow[],
    at: Date,
  ): Promise<void> {
    if (ads.length === 0) return;
    await withTransaction(this.pool, async (tx) => {
      for (const ad of ads) await this.#recordAd(tx, adsScope, ad, at);
    });
  }

  async #recordAd(
    tx: pg.PoolClient,
    adsScope: ConnectionScope,
    ad: DiscoveredAdRow,
    at: Date,
  ): Promise<void> {
    const placements = [
      { platform: 'facebook', ...ad.facebook },
      { platform: 'instagram', ...ad.instagram },
    ] as const;
    const up = await tx.query<{ id: string }>(
      `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id,
                              ad_account_external_id, name, effective_status, active,
                              inactive_since, facebook_source_external_id,
                              instagram_source_external_id, instagram_account_external_id,
                              facebook_resolution, instagram_resolution, first_discovered_at,
                              last_discovered_at)
         SELECT $1, $2, $3, $4, $5, $14, $6, $7, CASE WHEN $7 THEN NULL ELSE $8::timestamptz END,
                $9, $10, $11, $12, $13, $8, $8
           FROM connection
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = 'meta_ads'
         ON CONFLICT (ads_connection_id, external_id) DO UPDATE SET
           ad_account_external_id = EXCLUDED.ad_account_external_id,
           name = COALESCE(EXCLUDED.name, meta_ad.name),
           deleted_at = NULL,
           effective_status = EXCLUDED.effective_status,
           active = EXCLUDED.active,
           inactive_since = CASE WHEN EXCLUDED.active THEN NULL
                                 ELSE COALESCE(meta_ad.inactive_since, $8) END,
           facebook_source_external_id = EXCLUDED.facebook_source_external_id,
           instagram_source_external_id = EXCLUDED.instagram_source_external_id,
           instagram_account_external_id = EXCLUDED.instagram_account_external_id,
           facebook_resolution = EXCLUDED.facebook_resolution,
           instagram_resolution = EXCLUDED.instagram_resolution,
           last_discovered_at = EXCLUDED.last_discovered_at
         WHERE meta_ad.organization_id = $1 AND meta_ad.brand_id = $2
         RETURNING id`,
      [
        ...ids(adsScope),
        ad.externalId,
        ad.adAccountExternalId,
        ad.effectiveStatus,
        ad.active,
        at,
        ad.facebook.sourceExternalId,
        ad.instagram.sourceExternalId,
        ad.instagram.accountExternalId,
        ad.facebook.resolution,
        ad.instagram.resolution,
        ad.name,
      ],
    );
    const adId = up.rows[0]?.id;
    if (!adId) throw outOfScope();
    const sourceIds: string[] = [];
    for (const p of placements) {
      if (p.connection === null || p.sourceExternalId === null) continue;
      const conn = p.connection;
      if (conn.organizationId !== adsScope.organizationId || conn.brandId !== adsScope.brandId)
        throw outOfScope();
      // The link's platform must be the source connection's platform.
      const ok = await tx.query(
        'SELECT 1 FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = $4',
        [...ids(conn), p.platform],
      );
      if (ok.rowCount !== 1) throw outOfScope();
      const sourceId = await this.store.ensureAdSource(conn, p.sourceExternalId, tx);
      sourceIds.push(sourceId);
      await tx.query(
        `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id, next_poll_at)
           VALUES ($4, $1, $2, $3, $5) ON CONFLICT (source_id) DO NOTHING`,
        [...ids(conn), sourceId, at],
      );
      await tx.query(
        `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ad_id, source_id) DO UPDATE SET unlinked_at = NULL`,
        [adsScope.organizationId, adsScope.brandId, adId, sourceId, p.platform],
      );
    }
    // The creative changed: stop polling posts the ad no longer shows. The link stays so
    // comments already collected there keep their ad.
    await tx.query(
      `UPDATE meta_ad_source SET unlinked_at = $5
          WHERE organization_id = $1 AND brand_id = $2 AND ad_id = $3 AND unlinked_at IS NULL
            AND NOT (source_id = ANY($4::uuid[]))`,
      [adsScope.organizationId, adsScope.brandId, adId, sourceIds, at],
    );
  }

  /** The unfinished listing of an ads connection, if one is in progress. */
  async listingProgress(
    adsScope: ConnectionScope,
  ): Promise<{ cursor: string; startedAt: Date } | null> {
    const r = await this.pool.query<{ cursor: string; started_at: Date }>(
      `SELECT cursor, started_at FROM meta_ad_listing
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $3`,
      ids(adsScope),
    );
    const row = r.rows[0];
    return row ? { cursor: row.cursor, startedAt: row.started_at } : null;
  }

  async saveListingProgress(
    adsScope: ConnectionScope,
    p: { cursor: string; startedAt: Date },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta_ad_listing (organization_id, brand_id, ads_connection_id, cursor, started_at)
       SELECT $1, $2, $3, $4, $5 FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = 'meta_ads'
       ON CONFLICT (ads_connection_id) DO UPDATE SET cursor = EXCLUDED.cursor,
         started_at = EXCLUDED.started_at`,
      [...ids(adsScope), p.cursor, p.startedAt],
    );
  }

  async clearListingProgress(adsScope: ConnectionScope): Promise<void> {
    await this.pool.query(
      `DELETE FROM meta_ad_listing
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $3`,
      ids(adsScope),
    );
  }

  /** Retires active ads a complete listing that began at `listedSince` did not touch. */
  async retireUnlisted(adsScope: ConnectionScope, listedSince: Date, at: Date): Promise<number> {
    const r = await this.pool.query(
      `UPDATE meta_ad SET active = false, inactive_since = COALESCE(inactive_since, $4), updated_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $3 AND active
          AND last_discovered_at < $5`,
      [...ids(adsScope), at, listedSince],
    );
    return r.rowCount ?? 0;
  }

  /** Retired ads whose status was not looked up since they were retired, oldest first. */
  async adsToCheck(
    adsScope: ConnectionScope,
    limit: number,
  ): Promise<{ id: string; externalId: string }[]> {
    const r = await this.pool.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM meta_ad
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $3
          AND NOT active AND deleted_at IS NULL
          AND (status_checked_at IS NULL OR status_checked_at < inactive_since)
        ORDER BY inactive_since, id
        LIMIT $4`,
      [...ids(adsScope), limit],
    );
    return r.rows.map((x) => ({ id: x.id, externalId: x.external_id }));
  }

  async recordAdLookup(
    adsScope: ConnectionScope,
    adId: string,
    r: AdLookup,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE meta_ad SET status_checked_at = $4, name = COALESCE($5, name),
              deleted_at = CASE WHEN $6 THEN COALESCE(deleted_at, $4) END, updated_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $7 AND id = $3`,
      [
        adsScope.organizationId,
        adsScope.brandId,
        adId,
        at,
        r.name,
        r.deleted,
        adsScope.connectionId,
      ],
    );
  }

  async dueSources(
    scope: ConnectionScope,
    at: Date,
    o: { graceDays: number; limit: number },
  ): Promise<DueSource[]> {
    const r = await this.pool.query<{
      source_id: string;
      external_id: string;
      high_water_at: Date | null;
      resume_cursor: string | null;
      resume_boundary: Date | null;
      resume_newest_at: Date | null;
      last_full_scan_at: Date | null;
    }>(
      `SELECT sp.source_id, s.external_id, sp.high_water_at, sp.resume_cursor, sp.resume_boundary,
              sp.resume_newest_at, sp.last_full_scan_at
       ${POLL_FROM_SQL}
       WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
         AND ${DUE_SQL('$4::timestamptz', '$5::int')}
       ORDER BY sp.last_comment_at DESC NULLS FIRST, sp.next_poll_at, sp.source_id
       LIMIT $6`,
      [...ids(scope), at, o.graceDays, o.limit],
    );
    return r.rows.map((x) => ({
      sourceId: x.source_id,
      sourceExternalId: x.external_id,
      highWaterAt: x.high_water_at,
      resumeCursor: x.resume_cursor,
      resumeBoundary: x.resume_boundary,
      resumeNewestAt: x.resume_newest_at,
      lastFullScanAt: x.last_full_scan_at,
    }));
  }

  async connectionsWithDueSources(
    at: Date,
    o: { graceDays: number; limit: number },
  ): Promise<{ scope: ConnectionScope; platform: 'facebook' | 'instagram' }[]> {
    const r = await this.pool.query<{
      organization_id: string;
      brand_id: string;
      connection_id: string;
      platform: 'facebook' | 'instagram';
    }>(
      `SELECT sp.organization_id, sp.brand_id, sp.connection_id, c.platform
       ${POLL_FROM_SQL}
       WHERE c.platform IN ('facebook', 'instagram') AND ${DUE_SQL('$1::timestamptz', '$2::int')}
       GROUP BY sp.organization_id, sp.brand_id, sp.connection_id, c.platform
       ORDER BY MIN(sp.next_poll_at), sp.connection_id
       LIMIT $3`,
      [at, o.graceDays, o.limit],
    );
    return r.rows.map((x) => ({
      scope: {
        organizationId: x.organization_id,
        brandId: x.brand_id,
        connectionId: x.connection_id,
      },
      platform: x.platform,
    }));
  }

  async savePollProgress(scope: ConnectionScope, sourceId: string, p: PollProgress): Promise<void> {
    const where =
      'WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND source_id = $4';
    const base = [...ids(scope), sourceId];
    switch (p.kind) {
      case 'resume':
        await this.pool.query(
          `UPDATE source_poll SET resume_cursor = $5, resume_boundary = $6, resume_newest_at = $8,
                  last_polled_at = $7, next_poll_at = $7 ${where}`,
          [...base, p.cursor, p.boundary, p.at, p.newestAt],
        );
        return;
      case 'done':
        await this.pool.query(
          `UPDATE source_poll SET resume_cursor = NULL, resume_boundary = NULL, resume_newest_at = NULL,
                  high_water_at = GREATEST(high_water_at, $5),
                  last_comment_at = GREATEST(last_comment_at, $6),
                  last_full_scan_at = CASE WHEN $7 THEN $8 ELSE last_full_scan_at END,
                  last_polled_at = $8, next_poll_at = $9,
                  unavailable_since = NULL, last_error_code = NULL ${where}`,
          [...base, p.highWaterAt, p.lastCommentAt, p.fullScan, p.at, p.nextPollAt],
        );
        return;
      case 'unavailable':
        await this.pool.query(
          `UPDATE source_poll SET unavailable_since = COALESCE(unavailable_since, $6),
                  last_error_code = $5, next_poll_at = $7, resume_cursor = NULL,
                  resume_boundary = NULL, resume_newest_at = NULL, last_polled_at = $6 ${where}`,
          [...base, p.code, p.at, p.retryAt],
        );
        return;
      case 'defer':
        await this.pool.query(`UPDATE source_poll SET next_poll_at = $5 ${where}`, [
          ...base,
          p.retryAt,
        ]);
        return;
    }
  }
}
