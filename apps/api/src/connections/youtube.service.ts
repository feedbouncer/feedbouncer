import { Inject, Injectable } from '@nestjs/common';
import {
  budgetView,
  nextPacificMidnight,
  pacificDayKey,
  type PgYouTubeBacklog,
  type PgYouTubeQuotaLedger,
  type PgYouTubeSettings,
  type YouTubeSettings,
} from '@feedbouncer/comments';
import { systemClock } from '@feedbouncer/connectors';
import { recordAuditEvent, withTransaction } from '@feedbouncer/db';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import { quotaDay, youtubeSettingsPatch } from './youtube.dto.js';

interface ResolvedYouTube {
  scope: { organizationId: string; brandId: string; connectionId: string };
  ledger: PgYouTubeQuotaLedger;
  backlog: PgYouTubeBacklog;
  settings: PgYouTubeSettings;
}

@Injectable()
export class YouTubeConnectionService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async status(org: OrgContext, brandId: unknown, connectionId: unknown) {
    const youtube = await this.#resolve(org, brandId, connectionId);
    return this.#view(youtube);
  }

  async update(org: OrgContext, brandId: unknown, connectionId: unknown, body: unknown) {
    const youtube = await this.#resolve(org, brandId, connectionId);
    const { scope, ledger } = youtube;
    const patch = parseBody(youtubeSettingsPatch(ledger.projectCapUnits), body);
    const settings = await withTransaction(this.deps.pool, async (tx) => {
      const saved = await youtube.settings.update(scope, patch, org.actorUserId, tx);
      if (patch.dailyBudgetUnits !== undefined || patch.dryRun !== undefined) {
        // A connection sleeping until Pacific midnight must see the change on the next scheduler tick.
        await tx.query(
          `UPDATE youtube_connection_state SET next_read_at = $4, next_dispatch_at = $4
            WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
          [scope.organizationId, scope.brandId, scope.connectionId, new Date(systemClock.now())],
        );
      }
      await recordAuditEvent(tx, {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        actorType: 'user',
        actorUserId: org.actorUserId,
        action: 'connection.youtube_settings_updated',
        subjectType: 'connection',
        subjectId: scope.connectionId,
        details: {
          dailyBudgetUnits: saved.dailyBudgetUnits,
          dryRun: saved.dryRun,
          protectedAuthorCount: saved.protectedAuthorIds.length,
        },
      });
      return saved;
    });
    return this.#view(youtube, settings);
  }

  async quota(org: OrgContext, brandId: unknown, connectionId: unknown, day: unknown) {
    const { scope, ledger } = await this.#resolve(org, brandId, connectionId);
    const today = pacificDayKey(systemClock.now());
    const r = day === undefined ? { success: true, data: today } : quotaDay(today).safeParse(day);
    if (!r.success) throw new ApiError(400, 'invalid_request', 'Invalid or missing fields: day.');
    return { day: r.data, totals: await ledger.dailyTotals(scope, r.data) };
  }

  /** The connection must be a YouTube connection of this organization and brand; anything else is a 404. */
  async #resolve(org: OrgContext, brandId: unknown, connectionId: unknown) {
    const brand = await requireBrand(this.deps.pool, org, brandId);
    const scope = { ...brand, connectionId: parseUuidOr404(connectionId) };
    const found = await this.deps.pool.query(
      `SELECT 1 FROM connection
        WHERE id = $1 AND organization_id = $2 AND brand_id = $3 AND platform = 'youtube'`,
      [scope.connectionId, scope.organizationId, scope.brandId],
    );
    const youtube = this.deps.comments;
    if (found.rowCount === 0 || !youtube?.youtubeLedger) throw notFound();
    return {
      scope,
      ledger: youtube.youtubeLedger,
      backlog: youtube.youtubeBacklog,
      settings: youtube.youtubeSettings,
    };
  }

  async #view(
    { scope, ledger, backlog, settings: settingsStore }: ResolvedYouTube,
    known?: YouTubeSettings,
  ) {
    const { pool, env } = this.deps;
    const nowMs = systemClock.now();
    const now = new Date(nowMs);
    const day = pacificDayKey(nowMs);
    const ids = [scope.organizationId, scope.brandId, scope.connectionId];
    const [settings, usage, withSimulated, counts, pause, notice, state] = await Promise.all([
      known ?? settingsStore.get(scope),
      ledger.usage(scope),
      ledger.usage(scope, { simulated: true }),
      backlog.counts(scope),
      pool.query<{ resume_at: Date }>(
        'SELECT resume_at FROM youtube_quota_pause WHERE pacific_day = $1::date AND resume_at > $2',
        [day, now],
      ),
      pool.query<{ count: number }>(
        `SELECT count FROM youtube_notice
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
            AND kind = 'backlog_overflow' AND pacific_day = $4::date`,
        [...ids, day],
      ),
      pool.query<{ next_read_at: Date; last_error_code: string | null }>(
        `SELECT next_read_at, last_error_code FROM youtube_connection_state
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
        ids,
      ),
    ]);
    const view = budgetView(usage);
    return {
      settings,
      limits: {
        maxBudgetUnits: ledger.projectCapUnits,
        projectQuotaUnits: env.youtube!.projectDailyQuota,
      },
      today: {
        pacificDay: day,
        resetAt: nextPacificMidnight(nowMs).toISOString(),
        mode: view.mode,
        budgetUnits: usage.budgetUnits,
        spentUnits: usage.spentUnits,
        readsSpentUnits: usage.readsSpentUnits,
        writesSpentUnits: usage.spentUnits - usage.readsSpentUnits,
        readReserveUnits: view.readReserveUnits,
        remainingUnits: view.remainingUnits,
        simulatedUnits: withSimulated.spentUnits - usage.spentUnits,
        pausedUntil: pause.rows[0]?.resume_at.toISOString() ?? null,
      },
      backlog: { ...counts, skippedOverflowToday: notice.rows[0]?.count ?? 0 },
      nextReadAt: state.rows[0]?.next_read_at.toISOString() ?? null,
      lastErrorCode: state.rows[0]?.last_error_code ?? null,
    };
  }
}
