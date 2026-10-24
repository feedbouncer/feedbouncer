import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { Connector, InboundEvent } from './connector.js';
import { MemoryDeliveryLedger, StaticWebhookSecrets } from './memory.js';
import { ConnectorRegistry } from './registry.js';
import { WebhookGate, type InboundWebhook } from './webhook.js';

const APP_SECRET = 'app-secret-SENTINEL-9a8b7c';
const NOW = Date.parse('2026-10-12T10:00:00Z');
const event = (account: string): InboundEvent => ({
  type: 'comment.created',
  externalAccountId: account,
  ref: { sourceExternalId: 's1', externalId: `c-${account}` },
  occurredAt: new Date(NOW),
});

function connector(secretSource: 'app' | 'connection', timestamped = true): Connector {
  return {
    platform: 'facebook',
    capabilities: {
      actions: ['hide'],
      listSources: false,
      recentSources: false,
      ingestion: 'webhook',
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: { points: 10, durationSec: 60, urgentReservePoints: 1, defaultRetryAfterMs: 1000 },
      apiHosts: ['api.reference.test'],
      authorizationHosts: ['auth.reference.test'],
      defaultScopes: [],
      maxPageSize: 10,
    },
    buildAuthorizationUrl: () => new URL('https://auth.reference.test/'),
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refreshTokens: async () => {
      throw new Error('unused');
    },
    listComments: async () => ({ items: [], nextCursor: null }),
    getComment: async () => null,
    act: async () => ({ status: 'not_found' }),
    webhook: {
      secretSource,
      signature: {
        header: 'x-ref-signature',
        prefix: 'sha256=',
        encoding: 'hex',
        timestampHeader: timestamped ? 'x-ref-timestamp' : null,
        signedPayload: (body, ts) =>
          ts === null ? body : Buffer.concat([Buffer.from(`${ts}.`), body]),
      },
      toleranceSec: timestamped ? 300 : 0,
      parse: (body) =>
        (JSON.parse(body.toString('utf8')) as { events: { account: string }[] }).events.map((e) =>
          event(e.account),
        ),
    },
  };
}

function signed(body: object, opts: { secret?: string; ts?: number } = {}): InboundWebhook {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor((opts.ts ?? NOW) / 1000));
  const sig = createHmac('sha256', opts.secret ?? APP_SECRET)
    .update(Buffer.concat([Buffer.from(`${ts}.`), raw]))
    .digest('hex');
  return {
    platform: 'facebook',
    connectionId: null,
    rawBody: raw,
    headers: {
      'x-ref-signature': `sha256=${sig}`,
      'x-ref-timestamp': ts,
      'x-ref-delivery': 'd-1',
    },
  };
}

function gate(secretSource: 'app' | 'connection' = 'app', timestamped = true) {
  const registry = new ConnectorRegistry();
  registry.register(connector(secretSource, timestamped));
  const lines: string[] = [];
  const secrets = new StaticWebhookSecrets(
    new Map([['facebook', new Secret(APP_SECRET)]]),
    new Map([
      [
        'conn-y',
        {
          secret: new Secret('conn-y-secret'),
          externalAccountId: 'acct-y',
          platform: 'facebook' as const,
        },
      ],
    ]),
  );
  const g = new WebhookGate({
    registry,
    secrets,
    ledger: new MemoryDeliveryLedger(),
    clock: { now: () => NOW },
    log: createLogger('test', 'debug', (l) => lines.push(l)),
  });
  return { g, lines };
}
const body = { events: [{ account: 'acct-1' }] };

describe('WebhookGate', () => {
  it('accepts a valid delivery and hands verified events over', async () => {
    const { g } = gate();
    const deliver = vi.fn(async () => undefined);
    expect(await g.handle(signed(body), deliver)).toEqual({ status: 'accepted', eventCount: 1 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ platform: 'facebook' }));
  });

  it('processes duplicate deliveries once', async () => {
    const { g } = gate();
    const deliver = vi.fn(async () => undefined);
    await g.handle(signed(body), deliver);
    expect(await g.handle(signed(body), deliver)).toEqual({ status: 'duplicate' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('lets the platform retry when delivery fails (claim rolled back)', async () => {
    const { g } = gate();
    await expect(
      g.handle(signed(body), async () => {
        throw new Error('queue down');
      }),
    ).rejects.toThrow();
    expect(await g.handle(signed(body), async () => undefined)).toEqual({
      status: 'accepted',
      eventCount: 1,
    });
  });

  const tamper = (r: InboundWebhook, patch: Partial<InboundWebhook>) => ({ ...r, ...patch });
  it.each([
    ['wrong secret', signed(body, { secret: 'nope' })],
    [
      'missing signature',
      tamper(signed(body), { headers: { 'x-ref-timestamp': String(NOW / 1000) } }),
    ],
    [
      'malformed signature',
      tamper(signed(body), {
        headers: { ...signed(body).headers, 'x-ref-signature': 'sha256=zz' },
      }),
    ],
    [
      'truncated signature',
      tamper(signed(body), {
        headers: { ...signed(body).headers, 'x-ref-signature': 'sha256=abcd' },
      }),
    ],
    [
      'duplicated signature header',
      tamper(signed(body), { headers: { ...signed(body).headers, 'x-ref-signature': ['a', 'b'] } }),
    ],
    [
      'body changed after signing',
      tamper(signed(body), {
        rawBody: Buffer.from(JSON.stringify({ events: [{ account: 'evil' }] })),
      }),
    ],
    ['stale timestamp (replay)', signed(body, { ts: NOW - 301_000 })],
    ['future timestamp beyond skew', signed(body, { ts: NOW + 301_000 })],
    [
      'missing timestamp',
      tamper(signed(body), {
        headers: { 'x-ref-signature': signed(body).headers['x-ref-signature'] },
      }),
    ],
    ['unknown platform', tamper(signed(body), { platform: 'myspace' })],
    ['platform without webhooks', tamper(signed(body), { platform: 'youtube' })],
    ['oversized body', tamper(signed(body), { rawBody: Buffer.alloc(1_048_577) })],
    ['empty body', tamper(signed(body), { rawBody: Buffer.alloc(0) })],
  ])('rejects %s with the same opaque outcome', async (_n, req) => {
    const { g, lines } = gate();
    const deliver = vi.fn(async () => undefined);
    expect(await g.handle(req, deliver)).toEqual({ status: 'rejected' });
    expect(deliver).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(APP_SECRET);
    expect(lines.join('\n')).not.toMatch(/[0-9a-f]{64}/); // no signature digests in logs
  });

  it('accepts timestamps inside the skew window', async () => {
    const { g } = gate();
    expect(
      (
        await g.handle(
          signed({ events: [{ account: 'acct-old' }] }, { ts: NOW - 299_000 }),
          async () => undefined,
        )
      ).status,
    ).toBe('accepted');
    expect(
      (
        await g.handle(
          signed({ events: [{ account: 'acct-new' }] }, { ts: NOW + 299_000 }),
          async () => undefined,
        )
      ).status,
    ).toBe('accepted');
  });

  it('drops events for other accounts under a connection-scoped secret', async () => {
    const { g, lines } = gate('connection');
    const req = {
      ...signed(
        { events: [{ account: 'acct-y' }, { account: 'acct-x' }] },
        { secret: 'conn-y-secret' },
      ),
      connectionId: 'conn-y',
    };
    let got: readonly InboundEvent[] = [];
    expect(
      await g.handle(req, async (d) => {
        got = d.events;
      }),
    ).toEqual({ status: 'accepted', eventCount: 1 });
    expect(got.map((e) => e.externalAccountId)).toEqual(['acct-y']);
    const warning = lines.find((l) => l.includes('another account dropped'));
    expect(warning).toContain('"connectionId":"conn-y"');
  });

  it('rejects connection-scoped deliveries for unknown connections like any other failure', async () => {
    const { g } = gate('connection');
    const req = { ...signed(body, { secret: 'conn-y-secret' }), connectionId: 'conn-unknown' };
    expect(await g.handle(req, async () => undefined)).toEqual({ status: 'rejected' });
  });

  it('does not apply toleranceSec when the connector has no timestamp header', async () => {
    const { g } = gate('app', false);
    const raw = Buffer.from(JSON.stringify(body));
    const sig = createHmac('sha256', APP_SECRET).update(raw).digest('hex');
    const req: InboundWebhook = {
      platform: 'facebook',
      connectionId: null,
      rawBody: raw,
      headers: { 'x-ref-signature': `sha256=${sig}`, 'x-ref-timestamp': '1' },
    };
    expect(await g.handle(req, async () => undefined)).toEqual({
      status: 'accepted',
      eventCount: 1,
    });
    const bad = {
      ...req,
      headers: { ...req.headers, 'x-ref-signature': `sha256=${'0'.repeat(64)}` },
    };
    expect(await g.handle(bad, async () => undefined)).toEqual({ status: 'rejected' });
  });

  it('rejects when the secret source throws, without leaking why', async () => {
    const lines: string[] = [];
    const req = { ...signed(body, { secret: 'conn-y-secret' }), connectionId: 'conn-y' };
    const registry = new ConnectorRegistry();
    registry.register(connector('connection'));
    const secrets = {
      appSecret: () => null,
      connectionSecret: async () => {
        throw new Error('db down: password=hunter2');
      },
    };
    const failing = new WebhookGate({
      registry,
      secrets,
      ledger: new MemoryDeliveryLedger(),
      clock: { now: () => NOW },
      log: createLogger('test', 'debug', (l) => lines.push(l)),
    });
    expect(await failing.handle(req, async () => undefined)).toEqual({ status: 'rejected' });
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('does not trust a route connection id for app-scoped secrets', async () => {
    const { g } = gate();
    let got: string | null = 'unset';
    await g.handle({ ...signed(body), connectionId: 'conn-y' }, async (d) => {
      got = d.connectionId;
    });
    expect(got).toBeNull();
  });

  describe('dedupe key', () => {
    it('keys on the signed body only: a changed delivery-id header is a duplicate', async () => {
      const { g } = gate();
      const deliver = vi.fn(async () => undefined);
      const req = signed(body);
      await g.handle(req, deliver);
      const replay = { ...req, headers: { ...req.headers, 'x-ref-delivery': 'attacker-1' } };
      expect(await g.handle(replay, deliver)).toEqual({ status: 'duplicate' });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('treats a replay with the delivery-id header absent as a duplicate', async () => {
      const { g } = gate();
      const deliver = vi.fn(async () => undefined);
      const req = signed(body);
      await g.handle(req, deliver);
      const headers = { ...req.headers };
      delete (headers as Record<string, unknown>)['x-ref-delivery'];
      expect(await g.handle({ ...req, headers }, deliver)).toEqual({ status: 'duplicate' });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('uses sha256 of the raw body as the delivery key', async () => {
      const { g } = gate();
      const req = signed(body);
      let key = '';
      await g.handle(req, async (d) => {
        key = d.deliveryKey;
      });
      expect(key).toBe(`sha256:${createHash('sha256').update(req.rawBody).digest('hex')}`);
    });

    it('does not let a forged request consume the key of the valid one', async () => {
      const { g } = gate();
      const deliver = vi.fn(async () => undefined);
      expect(await g.handle(signed(body, { secret: 'nope' }), deliver)).toEqual({
        status: 'rejected',
      });
      expect(await g.handle(signed(body), deliver)).toEqual({ status: 'accepted', eventCount: 1 });
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });
});
