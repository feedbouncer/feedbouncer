// Tells the organization's owners when a connection stops working and must be
// reconnected. Sent once per transition into reconnect_required; a notification
// failure is logged and never fails the work that detected the problem.
import type pg from 'pg';
import type {
  ActivateOptions,
  ActivateResult,
  ConnectionDirectory,
  ConnectionRecord,
  Platform,
  ReauthReason,
} from '@feedbouncer/connectors';
import { renderReconnectRequired, type Mailer } from '@feedbouncer/mailer';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';

export interface ReconnectNotifier {
  connectionNeedsReconnect(scope: ConnectionScope): Promise<void>;
}

const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: 'Facebook Page',
  instagram: 'Instagram account',
  tiktok: 'TikTok account',
  youtube: 'YouTube channel',
  threads: 'Threads account',
  linkedin: 'LinkedIn page',
  x: 'X account',
  bluesky: 'Bluesky account',
  meta_ads: 'Meta ad account',
};

export class EmailReconnectNotifier implements ReconnectNotifier {
  constructor(
    private readonly d: { pool: pg.Pool; mailer: Mailer; publicWebUrl: URL; log: Logger },
  ) {}

  async connectionNeedsReconnect(scope: ConnectionScope): Promise<void> {
    const { organizationId: org, brandId: brand, connectionId } = scope;
    const c = await this.d.pool.query<{
      brand_name: string;
      display_name: string | null;
      platform: Platform;
    }>(
      `SELECT b.name AS brand_name, c.display_name, c.platform
         FROM connection c JOIN brand b ON b.id = c.brand_id AND b.organization_id = c.organization_id
        WHERE c.id = $3 AND c.organization_id = $1 AND c.brand_id = $2`,
      [org, brand, connectionId],
    );
    const row = c.rows[0];
    if (!row) return;
    const owners = await this.d.pool.query<{ email: string }>(
      `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role = 'owner'`,
      [org],
    );
    const body = renderReconnectRequired({
      brandName: row.brand_name,
      accountName: row.display_name,
      platformLabel: PLATFORM_LABELS[row.platform],
      settingsUrl: new URL(`/orgs/${org}/brands/${brand}/connections`, this.d.publicWebUrl).href,
    });
    const sent = await Promise.allSettled(
      owners.rows.map((o) => this.d.mailer.send({ ...body, to: o.email })),
    );
    const failed = sent.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Decorates a directory so a connection's transition into reconnect_required notifies its owners. */
export class NotifyingConnectionDirectory implements ConnectionDirectory {
  constructor(
    private readonly inner: ConnectionDirectory,
    private readonly notifier: ReconnectNotifier,
    private readonly log: Logger,
  ) {}

  load(scope: ConnectionScope): Promise<ConnectionRecord | null> {
    return this.inner.load(scope);
  }

  async markReauthRequired(scope: ConnectionScope, reason: ReauthReason): Promise<boolean> {
    const flagged = await this.inner.markReauthRequired(scope, reason);
    if (flagged) {
      const failed = (err: unknown) =>
        this.log.warn('notification.reconnect_failed', {
          connectionId: scope.connectionId,
          errorName: err instanceof Error ? err.name : 'NonError',
        });
      void this.notifier.connectionNeedsReconnect(scope).catch(failed);
    }
    return flagged;
  }

  upsertPending(i: Parameters<ConnectionDirectory['upsertPending']>[0]) {
    return this.inner.upsertPending(i);
  }

  activate(
    scope: ConnectionScope,
    actorUserId: string,
    opts?: ActivateOptions,
  ): Promise<ActivateResult> {
    return this.inner.activate(scope, actorUserId, opts);
  }

  findLiveByAccount(platform: Platform, externalAccountId: string) {
    return this.inner.findLiveByAccount(platform, externalAccountId);
  }
  findLiveByAccounts(platform: Platform, externalAccountIds: readonly string[]) {
    return this.inner.findLiveByAccounts(platform, externalAccountIds);
  }

  disconnect(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    return this.inner.disconnect(scope, actorUserId);
  }
}
