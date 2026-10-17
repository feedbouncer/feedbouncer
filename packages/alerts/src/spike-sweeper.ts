// Evaluates due brands for a negative-comment spike every few minutes. Logs ids and counts only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import { NEGATIVE_COMMENT_SQL } from '@feedbouncer/actions';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import {
  BASELINE_DAYS,
  ROLLUP_REFRESH_HOURS,
  SPIKE_EVAL_EVERY_MINUTES,
  SPIKE_WINDOW_MINUTES,
} from './constants.js';
import { createAlertEvent } from './events.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { evaluateSpike, nextSpikeState, type Sensitivity, type SpikeVerdict } from './spike.js';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const floorHour = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);

const CLAIM_SQL = `
  WITH due AS (
    SELECT s.organization_id, s.brand_id
      FROM alert_brand_state s
      JOIN brand b ON b.organization_id = s.organization_id AND b.id = s.brand_id
     WHERE s.next_eval_at <= $1 AND b.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM alert_route r
           JOIN alert_channel ch ON ch.organization_id = r.organization_id AND ch.id = r.channel_id
          WHERE r.organization_id = s.organization_id AND r.brand_id = s.brand_id
            AND r.alert_type = 'negative_spike' AND r.enabled AND ch.status = 'active')
     ORDER BY s.next_eval_at
     LIMIT $3
       FOR UPDATE OF s SKIP LOCKED)
  UPDATE alert_brand_state s SET next_eval_at = $2
    FROM due
   WHERE s.organization_id = due.organization_id AND s.brand_id = due.brand_id
  RETURNING s.organization_id, s.brand_id`;

const LIVE_SCOPE = `c.organization_id = $1 AND c.brand_id = $2 AND c.ingest_origin = 'live' AND NOT c.is_own_account
  AND c.posted_at >= $3 AND c.posted_at < $4`;

const ROLLUP_SQL = `
  INSERT INTO alert_negative_hourly (organization_id, brand_id, hour, negatives, total)
  SELECT $1, $2, date_trunc('hour', c.posted_at),
         count(*) FILTER (WHERE ${NEGATIVE_COMMENT_SQL}), count(*)
    FROM comment c
   WHERE ${LIVE_SCOPE}
   GROUP BY 3
  ON CONFLICT (brand_id, hour) DO UPDATE SET negatives = EXCLUDED.negatives, total = EXCLUDED.total
   WHERE alert_negative_hourly.organization_id = EXCLUDED.organization_id`;

export const WINDOW_SQL = `
  SELECT count(*) FILTER (WHERE ${NEGATIVE_COMMENT_SQL}) AS n, count(*) AS t
    FROM comment c
   WHERE ${LIVE_SCOPE}`;

const NEWEST_SQL = `
  SELECT c.id FROM comment c
   WHERE ${LIVE_SCOPE} AND ${NEGATIVE_COMMENT_SQL}
   ORDER BY c.posted_at DESC, c.id DESC
   LIMIT 3`;

const CONNECTIONS_SQL = `
  SELECT c.connection_id, count(*) OVER () AS connections
    FROM comment c
   WHERE ${LIVE_SCOPE} AND ${NEGATIVE_COMMENT_SQL}
   GROUP BY c.connection_id
   ORDER BY count(*) DESC, c.connection_id
   LIMIT 5`;

interface StateRow {
  first_live_at: Date | null;
  rollup_seeded_at: Date | null;
  last_evaluated_at: Date | null;
  episode_id: string | null;
  cooldown_until: Date | null;
  trigger_count: number | null;
  escalated: boolean;
  sensitivity: Sensitivity | null;
  min_negative_count: number | null;
  cooldown_minutes: number | null;
}

type Outcome = 'none' | 'fired' | 'escalated';

export class SpikeSweeper {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly batch: number;
  private readonly evaluate: typeof evaluateSpike;

  constructor(
    private readonly d: {
      pool: pg.Pool;
      log: Logger;
      capPerHour: number;
      now?: () => Date;
      newId?: () => string;
      batch?: number;
      evaluate?: typeof evaluateSpike;
    },
  ) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? randomUUID;
    this.batch = d.batch ?? 50;
    this.evaluate = d.evaluate ?? evaluateSpike;
  }

  async tick(): Promise<{ evaluated: number; fired: number; escalated: number }> {
    const now = this.now();
    const claimed = await this.d.pool.query<{ organization_id: string; brand_id: string }>(
      CLAIM_SQL,
      [now, new Date(now.getTime() + SPIKE_EVAL_EVERY_MINUTES * MIN_MS), this.batch],
    );
    const result = { evaluated: 0, fired: 0, escalated: 0 };
    for (const { organization_id: orgId, brand_id: brandId } of claimed.rows) {
      try {
        const outcome = await withTransaction(this.d.pool, (c) =>
          this.evaluateBrand(c, orgId, brandId, now),
        );
        result.evaluated++;
        if (outcome === 'fired') result.fired++;
        if (outcome === 'escalated') result.escalated++;
      } catch (e) {
        this.d.log.error('alerts.spike_failed', { brandId, ...errorFields(e) });
      }
    }
    this.d.log.info('alerts.spike_tick', result);
    return result;
  }

  private async evaluateBrand(
    c: pg.PoolClient,
    orgId: string,
    brandId: string,
    now: Date,
  ): Promise<Outcome> {
    // date_trunc and the rollup's whole-hour check follow the session zone; hours are UTC hours.
    await c.query("SET LOCAL TimeZone = 'UTC'");
    const s = (
      await c.query<StateRow>(
        `SELECT s.first_live_at, s.rollup_seeded_at, s.last_evaluated_at, s.episode_id, s.cooldown_until, s.trigger_count, s.escalated,
                st.sensitivity, st.min_negative_count, st.cooldown_minutes
           FROM alert_brand_state s
           LEFT JOIN alert_brand_settings st ON st.organization_id = s.organization_id AND st.brand_id = s.brand_id
          WHERE s.organization_id = $1 AND s.brand_id = $2
            FOR UPDATE OF s`,
        [orgId, brandId],
      )
    ).rows[0];
    if (!s) return 'none';
    const sensitivity = s.sensitivity ?? DEFAULT_SETTINGS.sensitivity;
    const minCount = s.min_negative_count ?? DEFAULT_SETTINGS.minNegativeCount;
    const cooldownMinutes = s.cooldown_minutes ?? DEFAULT_SETTINGS.cooldownMinutes;
    const t = now.getTime();

    const firstLiveAt =
      s.first_live_at ??
      (
        await c.query<{ at: Date | null }>(
          `SELECT min(ingested_at) AS at FROM comment
            WHERE organization_id = $1 AND brand_id = $2 AND ingest_origin = 'live'
              AND NOT is_own_account`,
          [orgId, brandId],
        )
      ).rows[0]!.at;

    // Refresh from the last evaluation so hours skipped during a gap are rolled up too.
    const seedFrom = floorHour(t - BASELINE_DAYS * DAY_MS - HOUR_MS);
    const rollupFrom =
      s.rollup_seeded_at && s.last_evaluated_at
        ? new Date(
            Math.max(
              seedFrom.getTime(),
              floorHour(s.last_evaluated_at.getTime()).getTime() - ROLLUP_REFRESH_HOURS * HOUR_MS,
            ),
          )
        : seedFrom;
    await c.query(ROLLUP_SQL, [orgId, brandId, rollupFrom, now]);

    const windowStart = new Date(t - SPIKE_WINDOW_MINUTES * MIN_MS);
    const scope = [orgId, brandId, windowStart, now];
    const w = (await c.query<{ n: string; t: string }>(WINDOW_SQL, scope)).rows[0]!;
    const windowNegatives = Number(w.n);

    const baseStart = floorHour(Math.max(t - BASELINE_DAYS * DAY_MS, firstLiveAt?.getTime() ?? 0));
    const baseEnd = floorHour(windowStart.getTime());
    const b = (
      await c.query<{ n: string; t: string }>(
        `SELECT coalesce(sum(negatives), 0) AS n, coalesce(sum(total), 0) AS t FROM alert_negative_hourly
          WHERE organization_id = $1 AND brand_id = $2 AND hour >= $3 AND hour < $4`,
        [orgId, brandId, baseStart, baseEnd],
      )
    ).rows[0]!;

    const verdict = this.evaluate({
      sensitivity,
      minCount,
      windowNegatives,
      windowTotal: Number(w.t),
      baselineNegatives: Number(b.n),
      baselineTotal: Number(b.t),
      baselineHours: Math.max(0, (baseEnd.getTime() - baseStart.getTime()) / HOUR_MS),
      firstLiveAt,
      now,
    });
    const next = nextSpikeState(
      {
        episodeId: s.episode_id,
        cooldownUntil: s.cooldown_until,
        triggerCount: s.trigger_count,
        escalated: s.escalated,
      },
      verdict,
      windowNegatives,
      now,
      cooldownMinutes,
      this.newId,
    );

    let outcome: Outcome = 'none';
    if (next.emit && verdict.fire) {
      const newest = await c.query<{ id: string }>(NEWEST_SQL, scope);
      const connections = await c.query<{ connection_id: string; connections: string }>(
        CONNECTIONS_SQL,
        scope,
      );
      const episodeId = next.state.episodeId!;
      const escalation = next.emit === 'spike_escalation';
      const created = await createAlertEvent(
        c,
        {
          organizationId: orgId,
          brandId,
          type: next.emit,
          key: escalation ? `spike_escalation:${episodeId}` : `spike:${brandId}:${episodeId}`,
          windowStart,
          windowEnd: now,
          payload: {
            kind: 'spike',
            negatives: windowNegatives,
            total: Number(w.t),
            expectedPerHour: verdict.expectedPerHour,
            trigger: verdict.trigger,
            sensitivity,
            minCount,
            ...(escalation ? { triggerCount: next.state.triggerCount! } : {}),
            commentIds: newest.rows.map((r) => r.id),
            connectionIds: connections.rows.map((r) => r.connection_id),
            connectionCount: Number(connections.rows[0]?.connections ?? 0),
          },
        },
        { capPerHour: this.d.capPerHour, routeType: 'negative_spike', now },
      );
      if (created.status === 'created') outcome = escalation ? 'escalated' : 'fired';
    }

    await c.query(
      `UPDATE alert_brand_state
          SET first_live_at = $3, rollup_seeded_at = coalesce(rollup_seeded_at, $4), episode_id = $5,
              cooldown_until = $6, trigger_count = $7, escalated = $8, last_verdict = $9, last_evaluated_at = $4
        WHERE organization_id = $1 AND brand_id = $2`,
      [
        orgId,
        brandId,
        firstLiveAt,
        now,
        next.state.episodeId,
        next.state.cooldownUntil,
        next.state.triggerCount,
        next.state.escalated,
        lastVerdict(verdict, next.emit),
      ],
    );
    return outcome;
  }
}

function lastVerdict(v: SpikeVerdict, emit: 'negative_spike' | 'spike_escalation' | null): string {
  if (!v.fire) return v.reason;
  if (emit === 'negative_spike') return 'fired';
  if (emit === 'spike_escalation') return 'escalated';
  return 'cooldown';
}
