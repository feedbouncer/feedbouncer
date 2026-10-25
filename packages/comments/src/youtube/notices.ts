// Once-per-Pacific-day owner emails about a YouTube connection: the project quota
// ran out, or the backlog overflowed. The claim is a single statement on
// youtube_notice, so replicas and repeated cycles send one email between them.
// A failed send is logged and not retried that day; it never fails a cycle.
import type pg from 'pg';
import type { Clock } from '@feedbouncer/connectors';
import {
  renderYouTubeBacklogOverflow,
  renderYouTubeQuotaPaused,
  type Mailer,
} from '@feedbouncer/mailer';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { organizationOwnerEmails } from '../reconnect-notifier.js';
import { nextPacificMidnight, pacificDayKey } from './quota-day.js';
import { scopeParams } from './sql.js';

export type YouTubeNoticeKind = 'quota_paused' | 'backlog_overflow';

export interface YouTubeNoticeDeps {
  pool: pg.Pool;
  mailer: Mailer;
  publicWebUrl: URL;
  log: Logger;
  clock: Clock;
}

export class YouTubeNotices {
  constructor(private readonly d: YouTubeNoticeDeps) {}

  /**
   * Emails the organization's owners unless this connection was already told about `kind`
   * today. `count` is what the email reports: the actions waiting (`quota_paused`); for
   * `backlog_overflow` it is the count the backlog has been keeping for the day.
   * Returns whether this call claimed the notice.
   */
  async once(scope: ConnectionScope, kind: YouTubeNoticeKind, count = 0): Promise<boolean> {
    try {
      const nowMs = this.d.clock.now();
      const n = await this.#claim(scope, kind, count, nowMs);
      if (n === null) return false;
      await this.#send(scope, kind, n, nowMs);
      return true;
    } catch (err) {
      this.d.log.warn('youtube.notice_failed', {
        connectionId: scope.connectionId,
        kind,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
      return false;
    }
  }

  /** The notice's count when this call is the one to send it, else null. */
  async #claim(
    scope: ConnectionScope,
    kind: YouTubeNoticeKind,
    count: number,
    nowMs: number,
  ): Promise<number | null> {
    const p = [...scopeParams(scope), kind, pacificDayKey(nowMs), new Date(nowMs)];
    // The backlog keeps the overflow count itself; there is nothing to report without it.
    const sql =
      kind === 'backlog_overflow'
        ? `UPDATE youtube_notice SET sent_at = $6
            WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
              AND kind = $4 AND pacific_day = $5::date AND sent_at IS NULL AND count > 0
            RETURNING count`
        : `INSERT INTO youtube_notice AS n (organization_id, brand_id, connection_id, kind, pacific_day, sent_at, count)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7)
           ON CONFLICT (connection_id, kind, pacific_day) DO UPDATE SET sent_at = EXCLUDED.sent_at
            WHERE n.organization_id = $1 AND n.brand_id = $2 AND n.sent_at IS NULL
           RETURNING n.count`;
    const r = await this.d.pool.query<{ count: number }>(
      sql,
      kind === 'backlog_overflow' ? p : [...p, count],
    );
    return r.rows[0]?.count ?? null;
  }

  async #send(
    scope: ConnectionScope,
    kind: YouTubeNoticeKind,
    count: number,
    nowMs: number,
  ): Promise<void> {
    const c = await this.d.pool.query<{ display_name: string | null }>(
      `SELECT display_name FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      scopeParams(scope),
    );
    if (!c.rows[0]) return;
    const channelName = c.rows[0].display_name;
    const settingsUrl = new URL(
      `/orgs/${scope.organizationId}/brands/${scope.brandId}/connections`,
      this.d.publicWebUrl,
    ).href;
    const body =
      kind === 'quota_paused'
        ? renderYouTubeQuotaPaused({
            channelName,
            resumeAt: nextPacificMidnight(nowMs),
            waiting: count,
            settingsUrl,
          })
        : renderYouTubeBacklogOverflow({ channelName, skipped: count, settingsUrl });
    const sent = await Promise.allSettled(
      (await organizationOwnerEmails(this.d.pool, scope.organizationId)).map((to) =>
        this.d.mailer.send({ ...body, to }),
      ),
    );
    const failed = sent.filter((s) => s.status === 'rejected').length;
    if (failed > 0)
      this.d.log.warn('youtube.notice_send_failed', {
        connectionId: scope.connectionId,
        kind,
        failed,
      });
  }
}
