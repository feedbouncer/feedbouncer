// Authenticates inbound platform webhooks before anything reaches the core.
// Order: platform -> body size -> signature header -> timestamp window ->
// secret -> HMAC over the RAW body (constant-time) -> parse -> tenant binding
// -> dedupe (keyed on sha256 of the signed body only). Every failure returns the same frozen REJECTED value; the reason
// is logged as a check name only (never header values, digests or secrets).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SpanKind,
  clampLag,
  setSpanAttributes,
  withLogContext,
  withSpan,
  type Logger,
  type Secret,
} from '@feedbouncer/service-runtime';
import type { Clock } from './clock.js';
import type { InboundEvent, WebhookSpec } from './connector.js';
import type { DeliveryLedger, SyncRecorder, WebhookSecretSource } from './ports.js';
import type { ConnectorRegistry } from './registry.js';
import { inboundEventsSchema } from './schemas.js';
import { isPlatform, type Platform } from './types.js';

export interface InboundWebhook {
  readonly platform: string;
  readonly connectionId: string | null;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Buffer;
}
export interface VerifiedDelivery {
  readonly platform: Platform;
  readonly connectionId: string | null;
  readonly deliveryKey: string;
  readonly events: readonly InboundEvent[];
}
export type WebhookOutcome =
  | { readonly status: 'accepted'; readonly eventCount: number }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected' };

export interface WebhookDeliveryEvent {
  /** `unknown` for anything that is not a registered platform name; never a raw request value. */
  readonly platform: Platform | 'unknown';
  readonly outcome: WebhookOutcome['status'];
  readonly eventCount: number;
  /** Receipt time minus event time per event, clamped at 0. Empty unless accepted. */
  readonly eventDelaysMs: readonly number[];
  /** Events whose timestamp was ahead of our clock. */
  readonly negativeSkews: number;
}
/** Receives one event per delivery. Must not throw; exceptions are swallowed. */
export interface WebhookObserver {
  onDelivery(e: WebhookDeliveryEvent): void;
}

const REJECTED: WebhookOutcome = Object.freeze({ status: 'rejected' });
const DIGEST_BYTES = 32;
const CONNECTION_ID = /^[A-Za-z0-9-]{1,64}$/;

type Verified = { ok: true; delivery: VerifiedDelivery } | { ok: false; check: string };
const fail = (check: string): Verified => ({ ok: false, check });

function headerReader(h: InboundWebhook['headers']) {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string): string | null => {
    const v = lower.get(name.toLowerCase());
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0];
    return null;
  };
}

function decodeSignature(value: string, spec: WebhookSpec['signature']): Buffer | null {
  if (!value.startsWith(spec.prefix)) return null;
  const enc = value.slice(spec.prefix.length);
  const ok =
    spec.encoding === 'hex' ? /^[0-9a-fA-F]{64}$/.test(enc) : /^[A-Za-z0-9+/]{43}=$/.test(enc);
  if (!ok) return null;
  const buf = Buffer.from(enc, spec.encoding);
  return buf.length === DIGEST_BYTES ? buf : null;
}

export class WebhookGate {
  readonly #max: number;
  constructor(
    private readonly d: {
      registry: ConnectorRegistry;
      secrets: WebhookSecretSource;
      ledger: DeliveryLedger;
      clock: Clock;
      log: Logger;
      maxBodyBytes?: number;
      observer?: WebhookObserver;
      sync?: SyncRecorder;
    },
  ) {
    this.#max = d.maxBodyBytes ?? 1_048_576;
  }

  /** Every delivery is a new root span; inbound trace headers are never extracted. */
  async handle(
    req: InboundWebhook,
    deliver: (d: VerifiedDelivery) => Promise<void>,
  ): Promise<WebhookOutcome> {
    const platform: Platform | 'unknown' = isPlatform(req.platform) ? req.platform : 'unknown';
    // The request's connection id is unauthenticated: it is bound to logs and spans
    // only after verification, from the verified delivery (see #handleInner).
    return withLogContext({ connector_type: platform }, () =>
      withSpan(
        'webhook.receive',
        {
          kind: SpanKind.SERVER,
          root: true,
          attributes: { 'feedbouncer.platform': platform },
        },
        async (span) => {
          let delays: number[] = [];
          let skews = 0;
          // Only a delivery the gate verified may be attributed to a connection: an
          // app-secret delivery carries a caller-chosen connectionId that proves nothing.
          let verifiedConnectionId: string | null = null;
          const onVerified = (d: VerifiedDelivery) => {
            verifiedConnectionId = d.connectionId;
            setSpanAttributes(span, { 'feedbouncer.connector.id': d.connectionId });
          };
          const outcome = await this.#handleInner(req, onVerified, async (d) => {
            const now = this.d.clock.now();
            for (const ev of d.events) {
              const { lagMs, skewMs } = clampLag(ev.occurredAt.getTime(), now);
              delays.push(lagMs);
              if (skewMs > 0) skews++;
            }
            await deliver(d);
          });
          if (outcome.status !== 'accepted') {
            delays = [];
            skews = 0;
          }
          if (skews > 0)
            this.d.log.warn('telemetry.negative_lag', {
              source: 'webhook_event',
              platform,
              count: skews,
            });
          setSpanAttributes(span, {
            'feedbouncer.webhook.outcome': outcome.status,
            'feedbouncer.webhook.events': outcome.status === 'accepted' ? outcome.eventCount : 0,
          });
          try {
            this.d.observer?.onDelivery({
              platform,
              outcome: outcome.status,
              eventCount: outcome.status === 'accepted' ? outcome.eventCount : 0,
              eventDelaysMs: delays,
              negativeSkews: skews,
            });
          } catch {
            /* telemetry never fails intake */
          }
          const syncId: string | null = verifiedConnectionId;
          if (outcome.status === 'accepted' && syncId !== null && this.d.sync) {
            const warn = (err: unknown) =>
              this.d.log.warn('telemetry.sync_record_failed', {
                platform,
                connectionId: syncId,
                error: err instanceof Error ? err.name : 'NonError',
              });
            try {
              void this.d.sync.success(syncId, 'webhook').catch(warn);
            } catch (err) {
              warn(err);
            }
          }
          return outcome;
        },
      ),
    );
  }

  async #handleInner(
    req: InboundWebhook,
    onVerified: (d: VerifiedDelivery) => void,
    deliver: (d: VerifiedDelivery) => Promise<void>,
  ): Promise<WebhookOutcome> {
    const v = await this.#verify(req);
    if (!v.ok) {
      this.d.log.warn('webhook rejected', {
        platform: isPlatform(req.platform) ? req.platform : 'unknown',
        check: v.check,
      });
      return REJECTED;
    }
    const { delivery } = v;
    try {
      onVerified(delivery);
    } catch {
      /* telemetry never fails intake */
    }
    // From here on, logs are attributed to the verified connection, if there is one.
    return withLogContext(
      delivery.connectionId !== null ? { connector_id: delivery.connectionId } : {},
      async (): Promise<WebhookOutcome> => {
        const outcome = await this.d.ledger.once(
          `webhook:${delivery.platform}`,
          delivery.deliveryKey,
          () => deliver(delivery),
        );
        if (outcome === 'duplicate') {
          this.d.log.info('duplicate webhook delivery skipped', { platform: delivery.platform });
          return { status: 'duplicate' };
        }
        return { status: 'accepted', eventCount: delivery.events.length };
      },
    );
  }

  async #verify(req: InboundWebhook): Promise<Verified> {
    try {
      return await this.#check(req);
    } catch {
      // Connector hooks and secret sources must never turn into a distinguishable response.
      return fail('internal');
    }
  }

  async #check(req: InboundWebhook): Promise<Verified> {
    if (!isPlatform(req.platform)) return fail('platform');
    const platform = req.platform;
    const spec = this.d.registry.get(platform)?.webhook;
    if (!spec) return fail('platform');
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0 || req.rawBody.length > this.#max)
      return fail('body_size');

    const header = headerReader(req.headers);
    const sigValue = header(spec.signature.header);
    if (sigValue === null) return fail('signature_missing');
    const provided = decodeSignature(sigValue, spec.signature);
    if (!provided) return fail('signature_format');

    // toleranceSec is only validated by the registry when a timestamp header exists.
    let ts: string | null = null;
    if (spec.signature.timestampHeader !== null) {
      ts = header(spec.signature.timestampHeader);
      if (ts === null || !/^\d{1,12}$/.test(ts)) return fail('timestamp_missing');
      if (Math.abs(this.d.clock.now() / 1000 - Number(ts)) > spec.toleranceSec)
        return fail('timestamp_stale');
    }

    let boundAccount: string | null = null;
    let connectionId: string | null = null;
    let secret: Secret | null;
    if (spec.secretSource === 'app') {
      secret = this.d.secrets.appSecret(platform);
    } else {
      if (req.connectionId === null || !CONNECTION_ID.test(req.connectionId))
        return fail('connection');
      connectionId = req.connectionId;
      const found = await this.d.secrets.connectionSecret(connectionId, platform);
      secret = found?.secret ?? null;
      boundAccount = found?.externalAccountId ?? null;
    }
    if (!secret) return fail('secret_unavailable');

    const expected = createHmac('sha256', secret.reveal())
      .update(spec.signature.signedPayload(req.rawBody, ts))
      .digest();
    if (!timingSafeEqual(expected, provided)) return fail('signature_mismatch');

    const parsed = inboundEventsSchema.safeParse(spec.parse(req.rawBody));
    if (!parsed.success) return fail('payload');
    let events: readonly InboundEvent[] = parsed.data;
    if (boundAccount !== null) {
      const kept = events.filter((e) => e.externalAccountId === boundAccount);
      if (kept.length !== events.length)
        this.d.log.warn('webhook events for another account dropped', {
          platform,
          connectionId,
          dropped: events.length - kept.length,
        });
      events = kept;
    }

    // Only signed input may influence the key: headers outside the HMAC are attacker-controlled.
    const base = `sha256:${createHash('sha256').update(req.rawBody).digest('hex')}`;
    const deliveryKey = connectionId === null ? base : `${connectionId}:${base}`;
    return { ok: true, delivery: { platform, connectionId, deliveryKey, events } };
  }
}
