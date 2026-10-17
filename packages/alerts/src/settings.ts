import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import { recordAlertAudit } from './audit.js';
import type { Sensitivity } from './spike.js';

export interface BrandAlertSettings {
  sensitivity: Sensitivity;
  minNegativeCount: number;
  cooldownMinutes: number;
  contentMode: 'excerpts' | 'counts_only';
}

export const DEFAULT_SETTINGS: BrandAlertSettings = {
  sensitivity: 'medium',
  minNegativeCount: 10,
  cooldownMinutes: 360,
  contentMode: 'excerpts',
};

export type AlertType = 'negative_spike' | 'flagged_item';

export interface AlertRoute {
  alertType: AlertType;
  channelId: string;
  enabled: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgAlertSettings {
  constructor(private readonly pool: pg.Pool) {}

  async get(
    orgId: string,
    brandId: string,
  ): Promise<{ settings: BrandAlertSettings; routes: AlertRoute[]; learning: boolean }> {
    const [s, r, st] = await Promise.all([
      this.pool.query(
        `SELECT sensitivity, min_negative_count, cooldown_minutes, content_mode
           FROM alert_brand_settings WHERE organization_id = $1 AND brand_id = $2`,
        [orgId, brandId],
      ),
      this.pool.query(
        `SELECT alert_type, channel_id, enabled FROM alert_route
          WHERE organization_id = $1 AND brand_id = $2 ORDER BY alert_type, created_at, channel_id`,
        [orgId, brandId],
      ),
      this.pool.query(
        'SELECT last_verdict FROM alert_brand_state WHERE organization_id = $1 AND brand_id = $2',
        [orgId, brandId],
      ),
    ]);
    const row = s.rows[0];
    return {
      settings: row
        ? {
            sensitivity: row.sensitivity,
            minNegativeCount: row.min_negative_count,
            cooldownMinutes: row.cooldown_minutes,
            contentMode: row.content_mode,
          }
        : { ...DEFAULT_SETTINGS },
      routes: r.rows.map((x) => ({
        alertType: x.alert_type,
        channelId: x.channel_id,
        enabled: x.enabled,
      })),
      learning: (st.rows[0]?.last_verdict ?? 'learning') === 'learning',
    };
  }

  async put(
    orgId: string,
    brandId: string,
    actorUserId: string,
    i: { settings: BrandAlertSettings; routes: AlertRoute[] },
  ): Promise<{ status: 'ok' } | { status: 'unknown_channel' | 'unknown_brand' }> {
    const routes = [...new Map(i.routes.map((r) => [`${r.alertType}/${r.channelId}`, r])).values()];
    const channelIds = [...new Set(routes.map((r) => r.channelId))];
    if (!channelIds.every((id) => UUID_RE.test(id))) return { status: 'unknown_channel' };
    return withTransaction(this.pool, async (tx) => {
      const brand = await tx.query(
        'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR SHARE',
        [orgId, brandId],
      );
      if (brand.rowCount === 0) return { status: 'unknown_brand' as const };
      const known = await tx.query(
        'SELECT count(*)::int AS n FROM alert_channel WHERE organization_id = $1 AND id = ANY($2::uuid[])',
        [orgId, channelIds],
      );
      if (known.rows[0].n !== channelIds.length) return { status: 'unknown_channel' as const };

      const s = i.settings;
      await tx.query(
        `INSERT INTO alert_brand_settings
           (organization_id, brand_id, sensitivity, min_negative_count, cooldown_minutes, content_mode, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (brand_id) DO UPDATE SET
           sensitivity = EXCLUDED.sensitivity, min_negative_count = EXCLUDED.min_negative_count,
           cooldown_minutes = EXCLUDED.cooldown_minutes, content_mode = EXCLUDED.content_mode,
           updated_by_user_id = EXCLUDED.updated_by_user_id
         WHERE alert_brand_settings.organization_id = EXCLUDED.organization_id`,
        [
          orgId,
          brandId,
          s.sensitivity,
          s.minNegativeCount,
          s.cooldownMinutes,
          s.contentMode,
          actorUserId,
        ],
      );
      await tx.query(
        `DELETE FROM alert_route r
          WHERE r.organization_id = $1 AND r.brand_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM unnest($3::text[], $4::uuid[]) AS k(alert_type, channel_id)
               WHERE k.alert_type = r.alert_type AND k.channel_id = r.channel_id)`,
        [orgId, brandId, routes.map((r) => r.alertType), routes.map((r) => r.channelId)],
      );
      for (const r of routes) {
        await tx.query(
          `INSERT INTO alert_route (organization_id, brand_id, alert_type, channel_id, enabled, enabled_at)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() END)
           ON CONFLICT (brand_id, alert_type, channel_id) DO UPDATE SET
             enabled = EXCLUDED.enabled,
             enabled_at = CASE WHEN EXCLUDED.enabled AND NOT alert_route.enabled THEN now()
                               ELSE alert_route.enabled_at END`,
          [orgId, brandId, r.alertType, r.channelId, r.enabled],
        );
      }
      if (routes.some((r) => r.enabled && r.alertType === 'negative_spike')) {
        await tx.query(
          `INSERT INTO alert_brand_state (organization_id, brand_id, next_eval_at) VALUES ($1, $2, now())
           ON CONFLICT (brand_id) DO UPDATE SET next_eval_at = now()
           WHERE alert_brand_state.organization_id = EXCLUDED.organization_id`,
          [orgId, brandId],
        );
      }
      await recordAlertAudit(tx, {
        organizationId: orgId,
        brandId,
        actorType: 'user',
        actorUserId,
        action: 'alert.settings_updated',
        subjectType: 'brand',
        subjectId: brandId,
        details: { ...s, routes: routes.length },
      });
      return { status: 'ok' as const };
    });
  }

  async removeBrand(c: pg.ClientBase, orgId: string, brandId: string): Promise<void> {
    const tables = [
      'alert_route',
      'alert_brand_settings',
      'alert_brand_state',
      'alert_negative_hourly',
    ];
    for (const table of tables) {
      await c.query(`DELETE FROM ${table} WHERE organization_id = $1 AND brand_id = $2`, [
        orgId,
        brandId,
      ]);
    }
    await c.query(
      "DELETE FROM alert_flag_item WHERE organization_id = $1 AND brand_id = $2 AND state = 'pending'",
      [orgId, brandId],
    );
    await c.query(
      `UPDATE alert_delivery d SET state = 'cancelled', lease_until = NULL
         FROM alert_event e
        WHERE e.organization_id = d.organization_id AND e.id = d.alert_event_id
          AND e.organization_id = $1 AND e.brand_id = $2
          AND d.state IN ('pending', 'retrying')`,
      [orgId, brandId],
    );
  }
}
