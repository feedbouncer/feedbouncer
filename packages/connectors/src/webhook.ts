// Authenticates inbound platform webhooks before anything reaches the core.
// Order: platform -> body size -> signature header -> timestamp window ->
// secret -> HMAC over the RAW body (constant-time) -> parse -> tenant binding
// -> dedupe. Every failure returns the same frozen REJECTED value; the reason
// is logged as a check name only (never header values, digests or secrets).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger, Secret } from '@feedbouncer/service-runtime';
import type { Clock } from './clock.js';
import type { InboundEvent, WebhookSpec } from './connector.js';
import type { DeliveryLedger, WebhookSecretSource } from './ports.js';
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

const REJECTED: WebhookOutcome = Object.freeze({ status: 'rejected' });
const DIGEST_BYTES = 32;
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
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
    },
  ) {
    this.#max = d.maxBodyBytes ?? 1_048_576;
  }

  async handle(
    req: InboundWebhook,
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
          dropped: events.length - kept.length,
        });
      events = kept;
    }

    const id = spec.deliveryId(header);
    const base =
      id !== null && DELIVERY_ID.test(id)
        ? id
        : `sha256:${createHash('sha256').update(req.rawBody).digest('hex')}`;
    const deliveryKey = connectionId === null ? base : `${connectionId}:${base}`;
    return { ok: true, delivery: { platform, connectionId, deliveryKey, events } };
  }
}
