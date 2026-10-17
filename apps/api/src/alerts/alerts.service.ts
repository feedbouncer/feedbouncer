import { Inject, Injectable } from '@nestjs/common';
import {
  AlertDispatcher,
  PgAlertChannels,
  PgAlertSettings,
  confirmLink,
  renderConfirmEmail,
  slackHttp,
  type AlertChannel,
  type AlertRoute,
  type BrandAlertSettings,
  type ChannelKind,
} from '@feedbouncer/alerts';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import {
  toChannelDto,
  toEventDto,
  type AlertChannelDto,
  type AlertEventDto,
  type EventRow,
} from './dto.js';

const RESEND_MIN_MS = 60_000;
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60_000;
const RECENT_EVENTS = 20;

export interface Availability {
  slack: boolean;
  email: boolean;
}

export interface BrandAlertsView {
  availability: Availability;
  settings: BrandAlertSettings;
  routes: AlertRoute[];
  learning: boolean;
  channels: AlertChannelDto[];
  recent: AlertEventDto[];
}

/**
 * Alert channels, brand settings and recipient confirmation. Webhook URLs,
 * tokens and email addresses are never logged and never put in audit details.
 */
@Injectable()
export class AlertsService {
  readonly #channels: PgAlertChannels;
  readonly #settings: PgAlertSettings;
  readonly #dispatcher: AlertDispatcher;
  readonly #testHits = new Map<string, number[]>();
  readonly #publicHits = new Map<string, number[]>();

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#channels = new PgAlertChannels(deps.pool, deps.env.encryption);
    this.#settings = new PgAlertSettings(deps.pool);
    this.#dispatcher = new AlertDispatcher({
      pool: deps.pool,
      log: deps.log,
      channels: this.#channels,
      web: deps.env.publicWebUrl,
      enabled: this.availability,
      mailer: deps.mailer,
      slackHttp: slackHttp(deps.alertsFetch),
      emailPerMinute: 60,
    });
  }

  get availability(): Availability {
    return { slack: this.deps.env.alerts.slack, email: this.deps.env.alerts.email };
  }

  #requireKind(kind: ChannelKind): void {
    if (!this.availability[kind]) throw new ApiError(409, 'alerts_unavailable');
  }

  async list(
    org: OrgContext,
  ): Promise<{ availability: Availability; channels: AlertChannelDto[] }> {
    const channels = await this.#channels.list(org.organizationId);
    return { availability: this.availability, channels: channels.map(toChannelDto) };
  }

  async createSlack(
    org: OrgContext,
    i: { label: string; webhookUrl: string },
  ): Promise<{ channel: AlertChannelDto }> {
    this.#requireKind('slack');
    const r = await this.#channels.createSlack(org.organizationId, org.actorUserId, i);
    if (r.status !== 'created') {
      throw r.status === 'invalid_webhook_url'
        ? new ApiError(400, 'invalid_webhook_url')
        : new ApiError(400, 'invalid_request');
    }
    this.deps.log.info('alerts.channel_created', { kind: 'slack' });
    return { channel: toChannelDto(r.channel) };
  }

  async reconnectSlack(
    org: OrgContext,
    channelId: string,
    webhookUrl: string,
  ): Promise<{ channel: AlertChannelDto }> {
    this.#requireKind('slack');
    const r = await this.#channels.reconnectSlack(
      org.organizationId,
      org.actorUserId,
      channelId,
      webhookUrl,
    );
    if (r.status !== 'ok') {
      throw r.status === 'invalid_webhook_url'
        ? new ApiError(400, 'invalid_webhook_url')
        : notFound();
    }
    return { channel: toChannelDto(r.channel) };
  }

  async createEmail(
    org: OrgContext,
    i: { email: string; label?: string },
  ): Promise<{ channel: AlertChannelDto }> {
    this.#requireKind('email');
    const r = await this.#channels.createEmail(org.organizationId, org.actorUserId, i);
    if (r.status !== 'created') {
      throw r.status === 'invalid_email'
        ? new ApiError(400, 'invalid_email')
        : new ApiError(409, 'email_taken');
    }
    this.deps.log.info('alerts.channel_created', { kind: 'email' });
    await this.#sendConfirmation(org.organizationId, r.channel.email!, r.confirmToken);
    return { channel: toChannelDto(r.channel) };
  }

  async resendConfirmation(org: OrgContext, channelId: string): Promise<void> {
    this.#requireKind('email');
    const r = await this.deps.pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM alert_channel
        WHERE organization_id = $1 AND id = $2 AND kind = 'email'
          AND status IN ('pending_confirmation', 'unsubscribed')`,
      [org.organizationId, channelId],
    );
    const row = r.rows[0];
    if (!row) throw notFound();
    if (Date.now() - row.updated_at.getTime() < RESEND_MIN_MS) throw new ApiError(409, 'too_soon');
    const rotated = await this.#channels.rotateConfirmation(org.organizationId, channelId);
    if (!rotated) throw notFound();
    await this.#sendConfirmation(org.organizationId, rotated.email, rotated.confirmToken);
  }

  async #sendConfirmation(orgId: string, email: string, token: string): Promise<void> {
    const ws = await this.deps.pool.query<{ name: string }>(
      'SELECT name FROM organization WHERE id = $1',
      [orgId],
    );
    const content = renderConfirmEmail({
      email,
      workspaceName: ws.rows[0]?.name ?? '',
      link: confirmLink(this.deps.env.publicWebUrl, token),
    });
    try {
      await this.deps.mailer.send({ to: email, ...content });
    } catch {
      // The cause can quote the address: log the code only. The channel stays pending for a resend.
      this.deps.log.warn('alerts.confirmation_send_failed', { code: 'smtp_error' });
      throw new ApiError(502, 'confirmation_send_failed');
    }
  }

  async test(
    org: OrgContext,
    channelId: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const channel = await this.#channels.get(org.organizationId, channelId);
    if (!channel) throw notFound();
    this.#hit(this.#testHits, channelId, TEST_LIMIT, TEST_WINDOW_MS);
    const r = await this.#dispatcher.sendTest(org.organizationId, channelId);
    this.deps.log.info('alerts.test', {
      kind: channel.kind,
      ok: r.ok,
      ...(r.ok ? {} : { code: r.code }),
    });
    return r;
  }

  async remove(org: OrgContext, channelId: string): Promise<void> {
    const ok = await this.#channels.remove(org.organizationId, org.actorUserId, channelId);
    if (!ok) throw notFound();
  }

  /** In-memory sliding window per key; per process, like the plan's test-send limit. */
  #hit(store: Map<string, number[]>, key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      store.set(key, hits);
      throw new ApiError(429, 'rate_limited');
    }
    hits.push(now);
    store.set(key, hits);
    if (store.size > 10_000) {
      for (const [k, v] of store) if (v.every((t) => now - t >= windowMs)) store.delete(k);
    }
  }

  /** 30 per minute per source IP across the public recipient routes. */
  limitPublic(ip: string): void {
    this.#hit(this.#publicHits, ip, 30, 60_000);
  }

  async confirm(token: string): Promise<{ status: 'confirmed' }> {
    const r = await this.#channels.confirm(token);
    if (r.status === 'invalid') throw new ApiError(404, 'invalid_token');
    return { status: 'confirmed' };
  }

  async unsubscribe(token: string): Promise<{ status: 'unsubscribed' | 'already' }> {
    const r = await this.#channels.unsubscribe(token);
    if (r.status === 'invalid') throw new ApiError(404, 'invalid_token');
    return { status: r.status };
  }

  async brandView(org: OrgContext, rawBrandId: unknown): Promise<BrandAlertsView> {
    const scope = await requireBrand(this.deps.pool, org, rawBrandId);
    return this.#view(scope.organizationId, scope.brandId);
  }

  async putBrand(
    org: OrgContext,
    rawBrandId: unknown,
    body: { settings: BrandAlertSettings; routes: AlertRoute[] },
  ): Promise<BrandAlertsView> {
    const scope = await requireBrand(this.deps.pool, org, rawBrandId);
    const kinds = new Map(
      (await this.#channels.list(scope.organizationId)).map((c) => [c.id, c.kind] as const),
    );
    for (const r of body.routes) {
      const kind = kinds.get(r.channelId);
      if (r.enabled && kind !== undefined && !this.availability[kind]) {
        throw new ApiError(409, 'alerts_unavailable');
      }
    }
    const r = await this.#settings.put(scope.organizationId, scope.brandId, org.actorUserId, body);
    if (r.status === 'unknown_channel') throw new ApiError(422, 'unknown_channel');
    return this.#view(scope.organizationId, scope.brandId);
  }

  async #view(orgId: string, brandId: string): Promise<BrandAlertsView> {
    const [cfg, channels, events] = await Promise.all([
      this.#settings.get(orgId, brandId),
      this.#channels.list(orgId),
      this.deps.pool.query<EventRow>(
        `SELECT e.id, e.alert_type, e.status, e.created_at, e.window_start, e.window_end, e.payload,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('channelId', d.channel_id, 'state', d.state,
                                                              'lastErrorCode', d.last_error_code)
                                           ORDER BY d.created_at, d.channel_id)
                            FROM alert_delivery d
                           WHERE d.organization_id = e.organization_id AND d.alert_event_id = e.id),
                         '[]'::jsonb) AS deliveries
           FROM alert_event e
          WHERE e.organization_id = $1 AND e.brand_id = $2
          ORDER BY e.created_at DESC, e.id DESC LIMIT ${RECENT_EVENTS}`,
        [orgId, brandId],
      ),
    ]);
    return {
      availability: this.availability,
      settings: cfg.settings,
      routes: cfg.routes,
      learning: cfg.learning,
      channels: channels.map((c: AlertChannel) => toChannelDto(c)),
      recent: events.rows.map(toEventDto),
    };
  }
}
