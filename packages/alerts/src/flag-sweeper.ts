// Collects review items opened by moderators or rules and sends them as batched digests. Logs ids and counts only.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import { FLAG_BATCH_SECONDS, FLAG_DIGEST_MAX, FLAG_LOOKBACK_HOURS } from './constants.js';
import { createAlertEvent } from './events.js';

const COLLECT_SQL = `
  INSERT INTO alert_flag_item (organization_id, brand_id, review_item_id, comment_id, flagged_at, state)
  SELECT ri.organization_id, ri.brand_id, ri.id, ri.comment_id, ri.created_at, 'pending'
    FROM review_item ri
    JOIN comment c ON c.organization_id = ri.organization_id AND c.brand_id = ri.brand_id AND c.id = ri.comment_id
    JOIN brand b ON b.organization_id = ri.organization_id AND b.id = ri.brand_id
   WHERE ri.status = 'open'
     AND ri.created_at > $1::timestamptz - make_interval(hours => ${FLAG_LOOKBACK_HOURS})
     AND c.ingest_origin = 'live'
     AND b.archived_at IS NULL
     AND ri.created_at >= (
       SELECT min(ar.enabled_at)
         FROM alert_route ar
         JOIN alert_channel ch ON ch.organization_id = ar.organization_id AND ch.id = ar.channel_id
        WHERE ar.organization_id = ri.organization_id AND ar.brand_id = ri.brand_id
          AND ar.alert_type = 'flagged_item' AND ar.enabled AND ch.status = 'active')
  ON CONFLICT (review_item_id) DO NOTHING`;

const DUE_BRANDS_SQL = `
  SELECT DISTINCT organization_id, brand_id FROM alert_flag_item
   WHERE state = 'pending' AND flagged_at <= $1
   LIMIT 100`;

const PENDING_SQL = `
  SELECT f.review_item_id, f.flagged_at, ri.status
    FROM alert_flag_item f
    JOIN review_item ri
      ON ri.organization_id = f.organization_id AND ri.brand_id = f.brand_id AND ri.id = f.review_item_id
   WHERE f.organization_id = $1 AND f.brand_id = $2 AND f.state = 'pending'
   ORDER BY f.flagged_at, f.review_item_id
   LIMIT ${FLAG_DIGEST_MAX}
     FOR UPDATE OF f SKIP LOCKED`;

const MARK_SQL = `
  UPDATE alert_flag_item SET state = $4, alert_event_id = $5
   WHERE organization_id = $1 AND brand_id = $2 AND review_item_id = ANY($3::uuid[])`;

interface PendingRow {
  review_item_id: string;
  flagged_at: Date;
  status: string;
}

interface BatchResult {
  locked: number;
  skipped: number;
  digest: boolean;
}

export class FlagSweeper {
  private readonly now: () => Date;

  constructor(
    private readonly d: { pool: pg.Pool; log: Logger; capPerHour: number; now?: () => Date },
  ) {
    this.now = d.now ?? (() => new Date());
  }

  async tick(): Promise<{ collected: number; digests: number; skipped: number }> {
    const now = this.now();
    const collected = (await this.d.pool.query(COLLECT_SQL, [now])).rowCount ?? 0;
    const result = { collected, digests: 0, skipped: 0 };
    const due = await this.d.pool.query<{ organization_id: string; brand_id: string }>(
      DUE_BRANDS_SQL,
      [new Date(now.getTime() - FLAG_BATCH_SECONDS * 1000)],
    );
    for (const { organization_id: orgId, brand_id: brandId } of due.rows) {
      try {
        // A brand with more than one digest's worth of due items is drained within the tick.
        let batch: BatchResult;
        do {
          batch = await withTransaction(this.d.pool, (c) =>
            this.closeBatch(c, orgId, brandId, now),
          );
          result.skipped += batch.skipped;
          if (batch.digest) result.digests++;
        } while (batch.locked === FLAG_DIGEST_MAX);
      } catch (e) {
        this.d.log.error('alerts.flag_failed', { brandId, ...errorFields(e) });
      }
    }
    this.d.log.info('alerts.flag_tick', result);
    return result;
  }

  private async closeBatch(
    c: pg.PoolClient,
    orgId: string,
    brandId: string,
    now: Date,
  ): Promise<BatchResult> {
    const rows = (await c.query<PendingRow>(PENDING_SQL, [orgId, brandId])).rows;
    const cutoff = now.getTime() - FLAG_BATCH_SECONDS * 1000;
    if (rows.length === 0 || rows[0]!.flagged_at.getTime() > cutoff) {
      return { locked: 0, skipped: 0, digest: false };
    }
    const resolved = rows.filter((r) => r.status !== 'open');
    const open = rows.filter((r) => r.status === 'open');
    if (resolved.length > 0) {
      await c.query(MARK_SQL, [
        orgId,
        brandId,
        resolved.map((r) => r.review_item_id),
        'skipped',
        null,
      ]);
    }
    if (open.length === 0) return { locked: rows.length, skipped: resolved.length, digest: false };

    const ids = open.map((r) => r.review_item_id).sort();
    const created = await createAlertEvent(
      c,
      {
        organizationId: orgId,
        brandId,
        type: 'flagged_digest',
        key: `flags:${brandId}:${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 32)}`,
        windowStart: open[0]!.flagged_at,
        windowEnd: open[open.length - 1]!.flagged_at,
        payload: { kind: 'flags', reviewItemIds: ids, count: ids.length },
      },
      { capPerHour: this.d.capPerHour, routeType: 'flagged_item', now },
    );
    await c.query(MARK_SQL, [orgId, brandId, ids, 'included', created.eventId]);
    return {
      locked: rows.length,
      skipped: resolved.length,
      digest: created.status === 'created',
    };
  }
}
