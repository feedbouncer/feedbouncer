// The connector conformance suite. Any connector (reference or real) plus a
// driver for its platform double must pass it; it runs against the memory
// ports in unit tests and against Postgres/Redis in the integration run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Connector } from '../connector.js';
import { isSuccessEquivalent, type ConnectionClient } from '../runtime.js';
import { INVERSE_ACTION, MODERATION_ACTIONS, type NormalizedComment } from '../types.js';
import { assembleStack, type Stack, type StackPorts } from './runtime.js';

/** Async mirror of the platform test controls. */
export interface PlatformDriver {
  createAccount(): Promise<string>;
  consent(authorizationUrl: URL, accountId: string): Promise<{ code: string; state: string }>;
  seedSource(accountId: string): Promise<string>;
  seedComments(accountId: string, sourceId: string, n: number): Promise<string[]>;
  deleteComment(sourceId: string, commentId: string): Promise<void>;
  commentState(sourceId: string, commentId: string): Promise<'visible' | 'hidden' | 'deleted'>;
  expireAccessTokens(): Promise<void>;
  revokeGrant(accountId: string): Promise<void>;
  throttleNext(retryAfterSec: number): Promise<void>;
  calls(op: 'token' | 'refresh' | 'read' | 'act'): Promise<number>;
  /** Every token, code and secret the platform ever issued. */
  issuedSecrets(): Promise<string[]>;
  signedDelivery(
    accountId: string,
    commentId: string,
    sourceId: string,
    opts?: { deliveryId?: string; tsSec?: number },
  ): Promise<{ headers: Record<string, string>; rawBody: Buffer }>;
}

/**
 * `stack` must be assembled over a port set whose `faults.failNextAccessWrite`
 * really makes the next access-token write throw once; the suite asserts the
 * rotation-safety scenario unconditionally.
 */
export interface ConformanceHarness {
  readonly connector: Connector;
  readonly driver: PlatformDriver;
  readonly stack: Stack;
  /**
   * An existing user (member of the actor's organization) and brand (of the same
   * organization) used as impostors. The defaults are fine for memory ports;
   * a database-backed harness must provision real rows (uuid columns).
   */
  /** Real-time harnesses: shifts the stack clock forward, so token expiry is observable without waiting. */
  skipClock?(ms: number): void;
  readonly impostors?: { readonly userId: string; readonly brandId: string };
  cleanup?(): Promise<void>;
}

export interface ConformanceOptions {
  /**
   * Skips fake timers. Needed when time lives outside the process (Redis TTLs,
   * Postgres clock). The suite then waits in real time, and the harness must
   * assemble the stack with `stateTtlMs: REAL_TIME_STATE_TTL_MS`.
   */
  readonly realTime?: boolean;
}

/** State lifetime a real-time harness must configure so the expiry test is quick. */
export const REAL_TIME_STATE_TTL_MS = 500;

const START = Date.parse('2026-10-12T10:00:00Z');
const HOUR_MS = 3_600_000;

export function runConnectorConformance(
  name: string,
  makeHarness: () => Promise<ConformanceHarness>,
  opts: ConformanceOptions = {},
): void {
  const realTime = opts.realTime === true;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Lets `ms` pass: advances fake time, or waits in real time. */
  const elapse = async (ms: number) => {
    if (realTime) await sleep(ms);
    else vi.advanceTimersByTime(ms);
  };

  describe(`connector conformance: ${name}`, () => {
    let h: ConformanceHarness;
    let scope: ConnectionScope;
    let account: string;
    let seen: string[];

    /** Moves the framework clock forward so stored tokens look expired (a real-time harness offsets its own clock). */
    const skipAhead = (ms: number) => {
      if (realTime) h.skipClock?.(ms);
      else vi.advanceTimersByTime(ms);
    };

    /** Everything that could reach a caller or a log, flattened to text. */
    const record = (v: unknown): void => {
      seen.push(
        v instanceof Error
          ? `${String(v)} ${JSON.stringify(v)} ${v.stack ?? ''}`
          : JSON.stringify(v),
      );
    };
    const capture = async <T>(p: Promise<T>): Promise<T> =>
      p.catch((e: unknown) => {
        record(e);
        throw e;
      });

    const begin = async () => {
      const { authorizationUrl } = await h.stack.oauth.start(h.stack.actor, h.connector.platform);
      return h.driver.consent(authorizationUrl, account);
    };
    const target = async (n = 1) => {
      const src = await h.driver.seedSource(account);
      const ids = await h.driver.seedComments(account, src, n);
      return { src, ids };
    };
    /** The same connection and ports, with the connector's hooks (or some ports) partly replaced. */
    const withHooks = async (hooks: Partial<Connector>, ports: Partial<StackPorts> = {}) => {
      const stack = assembleStack(
        { ...h.connector, ...hooks },
        { ...h.stack, ...ports },
        h.stack.redirectUri,
        { clock: h.stack.clock },
      );
      return { client: await stack.runtime.connect(scope), lines: stack.lines };
    };
    /** Wraps a port so that, once armed, the next call to `method` rejects like a storage outage. */
    const outageOnce = <T extends object>(port: T, method: keyof T & string) => {
      let armed = false;
      const wrapped = new Proxy(port, {
        get(target, prop) {
          const v: unknown = Reflect.get(target, prop);
          if (typeof v !== 'function') return v;
          return (...args: unknown[]): unknown => {
            if (prop === method && armed) {
              armed = false;
              return Promise.reject(new Error('simulated storage outage'));
            }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      return { wrapped, arm: () => void (armed = true) };
    };
    const goodComment = (src: string): NormalizedComment => ({
      externalId: 'c-good',
      sourceExternalId: src,
      parentExternalId: null,
      author: null,
      body: 'ok',
      postedAt: new Date(START),
      platformState: 'visible',
      permalink: null,
    });

    beforeEach(async () => {
      seen = [];
      if (!realTime)
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: START });
      h = await makeHarness();
      account = await h.driver.createAccount();
      const { code, state } = await begin();
      const done = await h.stack.oauth.complete(h.stack.actor, h.connector.platform, {
        state,
        code,
      });
      if (!done.ok) throw new Error(`OAuth setup failed: ${done.reason}`);
      scope = {
        organizationId: h.stack.actor.organizationId,
        brandId: h.stack.actor.brandId,
        connectionId: done.connectionId,
      };
    });
    afterEach(async () => {
      if (!realTime) vi.useRealTimers();
      await h.cleanup?.();
    });

    describe('OAuth', () => {
      it('connects an active account and stores its credentials in the vault', async () => {
        expect((await h.stack.directory.load(scope))?.status).toBe('active');
        const { access, refresh } = await h.stack.vault.readTokens(scope);
        expect(access).not.toBeNull();
        expect(refresh).not.toBeNull();
        expect(String(access?.value)).toBe('[redacted]');
      });

      it('rejects a replayed callback without a second code exchange', async () => {
        const q = await begin();
        const first = await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q);
        expect(first).toMatchObject({ ok: true, created: false });
        const exchanges = await h.driver.calls('token');
        const replay = await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q);
        expect(replay).toEqual({ ok: false, reason: 'rejected' });
        expect(await h.driver.calls('token')).toBe(exchanges);
      });

      it('rejects an expired state', async () => {
        const q = await begin();
        const exchanges = await h.driver.calls('token');
        await elapse(realTime ? REAL_TIME_STATE_TTL_MS + 250 : 600_001);
        expect(await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q)).toEqual({
          ok: false,
          reason: 'rejected',
        });
        expect(await h.driver.calls('token')).toBe(exchanges);
      });

      it('rejects a callback from another user or brand without consuming the real state', async () => {
        const { organizationId, brandId, userId } = h.stack.actor;
        const other = h.impostors ?? { userId: 'intruder', brandId: 'brand-b' };
        await h.stack.memberships.grant?.(organizationId, brandId, other.userId, 'admin');
        await h.stack.memberships.grant?.(organizationId, other.brandId, userId, 'admin');
        const q = await begin();
        const exchanges = await h.driver.calls('token');
        for (const impostor of [
          { ...h.stack.actor, userId: other.userId },
          { ...h.stack.actor, brandId: other.brandId },
        ])
          expect(await h.stack.oauth.complete(impostor, h.connector.platform, q)).toEqual({
            ok: false,
            reason: 'rejected',
          });
        expect(await h.driver.calls('token')).toBe(exchanges);
        expect(await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q)).toMatchObject({
          ok: true,
        });
      });
    });

    describe('token refresh', () => {
      it('serializes concurrent refreshes into one', async () => {
        const { src } = await target();
        const before = await h.driver.calls('refresh');
        const oldRefresh = (await h.stack.vault.readTokens(scope)).refresh?.value.reveal();
        await h.driver.expireAccessTokens();
        skipAhead(HOUR_MS);
        const client = await h.stack.runtime.connect(scope);
        await Promise.all(
          Array.from({ length: 8 }, () =>
            capture(client.getComment({ sourceExternalId: src, externalId: 'c-000001' })),
          ),
        );
        expect((await h.driver.calls('refresh')) - before).toBe(1);
        const newRefresh = (await h.stack.vault.readTokens(scope)).refresh?.value.reveal();
        if (h.connector.capabilities.tokens.rotatesRefreshToken)
          expect(newRefresh).not.toBe(oldRefresh);
        else expect(newRefresh).toBe(oldRefresh);
      });

      it('refreshes once when the platform rejects a token that still looks valid', async () => {
        const { src } = await target();
        const before = await h.driver.calls('refresh');
        await h.driver.expireAccessTokens();
        const client = await h.stack.runtime.connect(scope);
        await Promise.all(
          Array.from({ length: 6 }, () =>
            capture(client.getComment({ sourceExternalId: src, externalId: 'c-000001' })),
          ),
        );
        expect((await h.driver.calls('refresh')) - before).toBe(1);
      });

      it('survives a failed access-token write after the platform rotated the refresh token', async () => {
        const { src } = await target();
        await h.driver.expireAccessTokens();
        skipAhead(HOUR_MS);
        const client = await h.stack.runtime.connect(scope);
        h.stack.faults.failNextAccessWrite();
        const ref = { sourceExternalId: src, externalId: 'c-000001' };
        await expect(client.getComment(ref)).rejects.toMatchObject({
          kind: 'transient',
          code: 'storage_unavailable',
        });
        expect(await client.getComment(ref)).toMatchObject({ externalId: 'c-000001' });
        expect((await h.stack.directory.load(scope))?.status).toBe('active');
      });

      it('marks the connection for reauthorization on revocation and stops', async () => {
        await h.driver.revokeGrant(account);
        await h.driver.expireAccessTokens();
        const { src } = await target();
        const client = await h.stack.runtime.connect(scope);
        await expect(
          client.listComments({ sourceExternalId: src, cursor: null }),
        ).rejects.toMatchObject({ kind: 'auth_expired', reauthorize: true });
        const refreshes = await h.driver.calls('refresh');
        const reads = await h.driver.calls('read');
        for (let i = 0; i < 5; i++)
          await expect(
            client.listComments({ sourceExternalId: src, cursor: null }),
          ).rejects.toMatchObject({ kind: 'auth_expired', reauthorize: true });
        expect(await h.driver.calls('refresh')).toBe(refreshes);
        expect(await h.driver.calls('read')).toBe(reads);
        expect((await h.stack.directory.load(scope))?.status).toBe('reconnect_required');
      });
    });

    describe('read', () => {
      it('pages through every comment exactly once', async () => {
        const { src, ids } = await target(7);
        const client = await h.stack.runtime.connect(scope);
        const got: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Awaited<ReturnType<ConnectionClient['listComments']>> =
            await client.listComments({ sourceExternalId: src, cursor });
          got.push(...page.items.map((c) => c.externalId));
          cursor = page.nextCursor;
        } while (cursor !== null);
        expect(got).toEqual(ids);
      });

      it('tolerates content deleted mid-listing', async () => {
        const { src, ids } = await target(7);
        const client = await h.stack.runtime.connect(scope);
        const first = await client.listComments({ sourceExternalId: src, cursor: null, limit: 2 });
        await h.driver.deleteComment(src, ids[2]!);
        await h.driver.deleteComment(src, first.items[1]!.externalId);
        const rest: string[] = [];
        let cursor = first.nextCursor;
        while (cursor !== null) {
          const p = await client.listComments({ sourceExternalId: src, cursor, limit: 2 });
          rest.push(
            ...p.items.filter((c) => c.platformState !== 'deleted').map((c) => c.externalId),
          );
          cursor = p.nextCursor;
        }
        expect(rest).toEqual(ids.slice(3));
        const gone = await client.getComment({ sourceExternalId: src, externalId: ids[2]! });
        expect(gone === null || gone.platformState === 'deleted').toBe(true);
      });
    });

    describe('connector output and URL boundary', () => {
      it('refuses a pagination URL that points away from the platform hosts', async () => {
        const host = h.connector.capabilities.apiHosts[0]!;
        const { src } = await target();
        for (const url of [
          'http://169.254.169.254/latest/meta-data',
          'https://evil.example/next',
          `https://${host}@evil.example/next`,
          `https://${host}:8443/next`,
          `http://${host}/next`,
        ]) {
          const { client } = await withHooks({
            listComments: async (ctx, req) => {
              await h.connector.listComments(ctx, req);
              await ctx.http.request({ method: 'GET', url }, ctx.signal);
              return { items: [], nextCursor: null };
            },
          });
          const reads = await h.driver.calls('read');
          await expect(
            client.listComments({ sourceExternalId: src, cursor: null }),
          ).rejects.toMatchObject({ kind: 'permanent', code: 'disallowed_url' });
          // only the legitimate first request reached the platform
          expect(await h.driver.calls('read')).toBe(reads + 1);
        }
      });

      it('rejects hostile connector output as invalid_connector_output', async () => {
        const { src } = await target();
        const good = goodComment(src);
        const hostile: Record<string, unknown>[] = [
          { ...good, permalink: 'javascript:alert(1)' },
          { ...good, body: 'x'.repeat(10_000_000) },
          { ...good, externalId: 'c-\u0000-id' },
          { ...good, externalId: 'c-\n-id' },
          { ...good, parentExternalId: good.externalId },
          { ...good, postedAt: new Date('not a date') },
          { ...good, injected: true },
        ];
        for (const bad of hostile) {
          const { client } = await withHooks({
            listComments: async () => ({ items: [bad as never], nextCursor: null }),
          });
          await expect(
            client.listComments({ sourceExternalId: src, cursor: null }),
          ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_connector_output' });
        }
        const { client } = await withHooks({
          act: async () => ({ status: 'maybe' }) as never,
        });
        const r = await client.act({
          action: h.connector.capabilities.actions[0]!,
          target: { sourceExternalId: src, externalId: 'c-000001' },
        });
        expect(r).toMatchObject({
          status: 'failed',
          error: { kind: 'permanent', code: 'invalid_connector_output' },
        });
      });

      it('replaces NUL characters in bodies', async () => {
        const { src } = await target();
        const { client } = await withHooks({
          listComments: async () => ({
            items: [{ ...goodComment(src), body: 'a\u0000b' }],
            nextCursor: null,
          }),
        });
        const page = await client.listComments({ sourceExternalId: src, cursor: null });
        expect(page.items[0]?.body).toBe('a�b');
      });
    });

    describe('act', () => {
      it('applies every declared action and offers undo exactly when the inverse is declared', async () => {
        const client = await h.stack.runtime.connect(scope);
        const declared = h.connector.capabilities.actions;
        for (const action of declared) {
          const { src, ids } = await target();
          const ref = { sourceExternalId: src, externalId: ids[0]! };
          const r = await client.act({ action, target: ref });
          expect(r.status).toBe('applied');
          if (r.status !== 'applied') continue;
          const inverse = INVERSE_ACTION[action];
          if (inverse && declared.includes(inverse))
            expect(r.undo).toEqual({ action: inverse, target: ref });
          else expect(r.undo).toBeNull();
          if (action === 'hide') {
            expect(await h.driver.commentState(src, ids[0]!)).toBe('hidden');
            if (r.undo) {
              expect((await client.act(r.undo)).status).toBe('applied');
              expect(await h.driver.commentState(src, ids[0]!)).toBe('visible');
            }
          }
        }
      });

      it('treats a repeated hide as applied', async () => {
        const { src, ids } = await target();
        const client = await h.stack.runtime.connect(scope);
        const req = {
          action: 'hide' as const,
          target: { sourceExternalId: src, externalId: ids[0]! },
        };
        expect((await client.act(req)).status).toBe('applied');
        expect((await client.act(req)).status).toBe('applied');
      });

      it('returns unsupported for every undeclared action without a platform call', async () => {
        const { src, ids } = await target();
        const client = await h.stack.runtime.connect(scope);
        const before = await h.driver.calls('act');
        for (const a of MODERATION_ACTIONS.filter(
          (x) => !h.connector.capabilities.actions.includes(x),
        ))
          expect(
            (
              await client.act({
                action: a,
                target: { sourceExternalId: src, externalId: ids[0]! },
              })
            ).status,
          ).toBe('unsupported');
        expect(await h.driver.calls('act')).toBe(before);
      });

      it('reports not_found on removed content, success-equivalent for delete', async () => {
        const { src, ids } = await target();
        await h.driver.deleteComment(src, ids[0]!);
        const client = await h.stack.runtime.connect(scope);
        const r = await client.act({
          action: 'delete',
          target: { sourceExternalId: src, externalId: ids[0]! },
        });
        expect(r.status).toBe('not_found');
        expect(isSuccessEquivalent(r)).toBe(true);
      });
    });

    describe('storage outages', () => {
      it('a failed directory or vault read during act is transient, and a retry succeeds', async () => {
        for (const port of ['directory', 'vault'] as const) {
          const { src, ids } = await target();
          const req = {
            action: 'hide' as const,
            target: { sourceExternalId: src, externalId: ids[0]! },
          };
          const outage =
            port === 'directory'
              ? outageOnce(h.stack.directory, 'load')
              : outageOnce(h.stack.vault, 'readTokens');
          const { client } = await withHooks({}, { [port]: outage.wrapped });
          const acts = await h.driver.calls('act');
          outage.arm();
          expect(await client.act(req)).toMatchObject({
            status: 'failed',
            error: { kind: 'transient', code: 'storage_unavailable' },
          });
          expect(await h.driver.calls('act')).toBe(acts);
          expect((await client.act(req)).status).toBe('applied');
          expect(await h.driver.commentState(src, ids[0]!)).toBe('hidden');
        }
      });
    });

    describe('rate-limit budget', () => {
      it('defers (not drops) and honors the platform retry hint over the local budget', async () => {
        const { src, ids } = await target();
        const client = await h.stack.runtime.connect(scope);
        const hintSec = realTime ? 1 : 45;
        await h.driver.throttleNext(hintSec);
        const t = { sourceExternalId: src, externalId: ids[0]! };
        const first = await client.act({ action: 'hide', target: t });
        expect(first).toMatchObject({
          status: 'failed',
          error: { kind: 'rate_limited', retryAfterMs: hintSec * 1000 },
        });
        const acts = await h.driver.calls('act');
        const blocked = await client.act({ action: 'hide', target: t });
        expect(blocked).toMatchObject({ status: 'failed', error: { kind: 'rate_limited' } });
        expect(await h.driver.calls('act')).toBe(acts); // deferred locally, no platform call
        await elapse(hintSec * 1000 + 100);
        expect((await client.act({ action: 'hide', target: t })).status).toBe('applied');
      });

      it('bulk reads cannot starve urgent actions', async () => {
        const { src, ids } = await target();
        const client = await h.stack.runtime.connect(scope);
        const { points, urgentReservePoints } = h.connector.capabilities.rateLimit;
        for (let i = 0; i < points; i++)
          await client.listComments({ sourceExternalId: src, cursor: null }).catch(() => undefined);
        await expect(
          client.listComments({ sourceExternalId: src, cursor: null }),
        ).rejects.toMatchObject({ kind: 'rate_limited' });
        for (let i = 0; i < urgentReservePoints; i++)
          expect(
            (
              await client.act({
                action: 'hide',
                target: { sourceExternalId: src, externalId: ids[0]! },
              })
            ).status,
          ).toBe('applied');
      });
    });

    describe('webhooks', () => {
      it('accepts signed deliveries once and rejects stale, forged, tampered and replayed ones', async () => {
        const platform = h.connector.platform;
        const deliver = vi.fn(async () => undefined);
        if (!h.connector.webhook) {
          expect(h.connector.capabilities.ingestion).toBe('polling');
          const out = await h.stack.webhooks.handle(
            {
              platform,
              connectionId: null,
              headers: { 'x-ref-signature': 'sha256=00' },
              rawBody: Buffer.from('{"events":[]}'),
            },
            deliver,
          );
          expect(out).toEqual({ status: 'rejected' });
          expect(deliver).not.toHaveBeenCalled();
          return;
        }
        const { src, ids } = await target();
        const id = ids[0]!;
        const send = (d: { headers: Record<string, string>; rawBody: Buffer }) =>
          h.stack.webhooks.handle({ platform, connectionId: null, ...d }, deliver);

        const ok = await h.driver.signedDelivery(account, id, src, { deliveryId: 'dlv-1' });
        expect(await send(ok)).toEqual({ status: 'accepted', eventCount: 1 });
        expect(await send(ok)).toEqual({ status: 'duplicate' });
        // a different (unsigned) delivery id header does not make a replay new
        const relabeled = { ...ok, headers: { ...ok.headers, 'x-ref-delivery': 'dlv-other' } };
        expect(await send(relabeled)).toEqual({ status: 'duplicate' });

        const stale = await h.driver.signedDelivery(account, id, src, {
          tsSec: Math.floor(Date.now() / 1000) - 3600,
        });
        expect(await send(stale)).toEqual({ status: 'rejected' });

        const fresh = await h.driver.signedDelivery(account, id, src);
        const forged = {
          ...fresh,
          rawBody: Buffer.from(fresh.rawBody.toString().replace(account, 'other-account')),
        };
        expect(await send(forged)).toEqual({ status: 'rejected' });
        const retimed = {
          ...fresh,
          headers: {
            ...fresh.headers,
            'x-ref-timestamp': String(Math.floor(Date.now() / 1000) - 1),
          },
        };
        expect(await send(retimed)).toEqual({ status: 'rejected' });
        const unsigned = { ...fresh.headers };
        delete unsigned['x-ref-signature'];
        expect(await send({ ...fresh, headers: unsigned })).toEqual({ status: 'rejected' });

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            events: [
              expect.objectContaining({
                type: 'comment.created',
                externalAccountId: account,
                ref: { sourceExternalId: src, externalId: id },
              }),
            ],
          }),
        );
      });
    });

    describe('secret hygiene', () => {
      it('no issued token, code, state, signature or secret appears in logs, errors or results', async () => {
        const { src, ids } = await target();
        const t = { sourceExternalId: src, externalId: ids[0]! };
        const known: string[] = [];
        const client = await h.stack.runtime.connect(scope);

        // OAuth failures: a replayed callback and a code the platform rejects
        const q = await begin();
        known.push(q.state, q.code);
        record(await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q));
        record(await h.stack.oauth.complete(h.stack.actor, h.connector.platform, q));
        const bad = await begin();
        known.push(bad.state);
        record(
          await h.stack.oauth.complete(h.stack.actor, h.connector.platform, {
            state: bad.state,
            code: 'ref_code_rejected',
          }),
        );

        // webhook rejections
        if (h.connector.webhook) {
          const d = await h.driver.signedDelivery(account, t.externalId, src);
          known.push(d.headers['x-ref-signature']!.replace(/^sha256=/, ''));
          const out = await h.stack.webhooks.handle(
            {
              platform: h.connector.platform,
              connectionId: null,
              headers: { ...d.headers, 'x-ref-timestamp': '1' },
              rawBody: d.rawBody,
            },
            async () => undefined,
          );
          record(out);
        }

        // platform failures on the action and read paths
        await h.driver.throttleNext(1);
        record(await client.act({ action: 'hide', target: t }));
        await elapse(1_100);

        // a connector whose own error text embeds the bearer token
        const { client: leaky, lines: leakyLines } = await withHooks({
          act: async (ctx) => {
            throw new Error(
              `POST https://api.reference.test/x?access_token=${ctx.accessToken.reveal()}`,
            );
          },
          listComments: async (ctx) => {
            throw Object.assign(new Error(`bad token ${ctx.accessToken.reveal()}`), {
              name: 'Oops',
            });
          },
        });
        record(await leaky.act({ action: 'hide', target: t }));
        await leaky.listComments({ sourceExternalId: src, cursor: null }).catch(record);

        await h.driver.expireAccessTokens();
        await h.driver.revokeGrant(account);
        await capture(client.listComments({ sourceExternalId: src, cursor: null })).catch(
          () => undefined,
        );

        const output = [...h.stack.lines, ...leakyLines, ...seen].join('\n');
        const secrets = [...(await h.driver.issuedSecrets()), ...known];
        expect(secrets.length).toBeGreaterThan(5);
        for (const s of secrets) expect(output).not.toContain(s);
      });
    });
  });
}
