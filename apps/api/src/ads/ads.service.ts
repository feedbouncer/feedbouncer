import { Inject, Injectable } from '@nestjs/common';
import * as z from 'zod';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';

export interface AdView {
  adId: string;
  adAccountId: string;
  effectiveStatus: string;
  active: boolean;
  inactiveSince: string | null;
  facebook: { resolution: string; postId: string | null };
  instagram: { resolution: string; mediaId: string | null };
  lastDiscoveredAt: string;
  lastPolledAt: string | null;
  postUnavailable: boolean;
}

export interface AdsPage {
  ads: AdView[];
  nextCursor: string | null;
  hints: { pagesNotConnected: number; instagramNotConnected: number };
}

const Cursor = z.strictObject({ t: z.iso.datetime({ offset: true }), id: z.uuid() });

const encodeCursor = (t: Date, id: string): string =>
  Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString('base64url');

function decodeCursor(raw: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'invalid_cursor');
  }
}

interface AdRow {
  id: string;
  external_id: string;
  ad_account_external_id: string;
  effective_status: string;
  active: boolean;
  inactive_since: Date | null;
  facebook_source_external_id: string | null;
  instagram_source_external_id: string | null;
  facebook_resolution: string;
  instagram_resolution: string;
  last_discovered_at: Date;
  last_polled_at: Date | null;
  post_unavailable: boolean;
}

@Injectable()
export class AdsService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async list(
    org: OrgContext,
    brandId: unknown,
    q: { connectionId?: string; cursor?: string; limit: number },
  ): Promise<AdsPage> {
    const { pool } = this.deps;
    const scope = await requireBrand(pool, org, brandId);
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const params = [scope.organizationId, scope.brandId, q.connectionId ?? null];
    const rows = await pool.query<AdRow>(
      `SELECT ma.id, ma.external_id, ma.ad_account_external_id, ma.effective_status, ma.active,
              ma.inactive_since, ma.facebook_source_external_id, ma.instagram_source_external_id,
              ma.facebook_resolution, ma.instagram_resolution, ma.last_discovered_at,
              poll.last_polled_at, COALESCE(poll.unavailable, false) AS post_unavailable
         FROM meta_ad ma
         LEFT JOIN LATERAL (
           SELECT max(sp.last_polled_at) AS last_polled_at,
                  bool_or(sp.unavailable_since IS NOT NULL) AS unavailable
             FROM meta_ad_source mas
             JOIN source_poll sp ON sp.source_id = mas.source_id
                                AND sp.organization_id = mas.organization_id
                                AND sp.brand_id = mas.brand_id
            WHERE mas.ad_id = ma.id AND mas.organization_id = ma.organization_id
              AND mas.brand_id = ma.brand_id) poll ON true
        WHERE ma.organization_id = $1 AND ma.brand_id = $2
          AND ($3::uuid IS NULL OR ma.ads_connection_id = $3)
          AND ($4::timestamptz IS NULL OR (ma.last_discovered_at, ma.id) < ($4::timestamptz, $5::uuid))
        ORDER BY ma.last_discovered_at DESC, ma.id DESC
        LIMIT $6`,
      [...params, cursor?.t ?? null, cursor?.id ?? null, q.limit + 1],
    );
    const hints = await pool.query<{ pages: string; instagram: string }>(
      `SELECT count(*) FILTER (WHERE facebook_resolution = 'page_not_connected') AS pages,
              count(*) FILTER (WHERE instagram_resolution = 'instagram_account_not_connected')
                AS instagram
         FROM meta_ad
        WHERE organization_id = $1 AND brand_id = $2 AND active
          AND ($3::uuid IS NULL OR ads_connection_id = $3)`,
      params,
    );
    const page = rows.rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      ads: page.map(toView),
      nextCursor:
        rows.rows.length > q.limit && last ? encodeCursor(last.last_discovered_at, last.id) : null,
      hints: {
        pagesNotConnected: Number(hints.rows[0]?.pages ?? 0),
        instagramNotConnected: Number(hints.rows[0]?.instagram ?? 0),
      },
    };
  }
}

const toView = (r: AdRow): AdView => ({
  adId: r.external_id,
  adAccountId: r.ad_account_external_id,
  effectiveStatus: r.effective_status,
  active: r.active,
  inactiveSince: r.inactive_since?.toISOString() ?? null,
  facebook: { resolution: r.facebook_resolution, postId: r.facebook_source_external_id },
  instagram: { resolution: r.instagram_resolution, mediaId: r.instagram_source_external_id },
  lastDiscoveredAt: r.last_discovered_at.toISOString(),
  lastPolledAt: r.last_polled_at?.toISOString() ?? null,
  postUnavailable: r.post_unavailable,
});
