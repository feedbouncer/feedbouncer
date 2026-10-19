import dns from 'node:dns';
import { Agent, buildConnector, fetch } from 'undici';
import { DELIVERY_TIMEOUT_MS } from './constants.js';
import { checkSyntax, compileAddressPolicy } from './destination.js';

export type DeliveryErrorCode =
  | 'timeout'
  | 'dns_error'
  | 'tls_error'
  | 'connection_error'
  | 'blocked_destination'
  | 'redirect'
  | 'http_status';

export type TransportResult =
  | { ok: true; status: number; durationMs: number }
  | { ok: false; status: number | null; code: DeliveryErrorCode; durationMs: number };

export interface WebhookTransport {
  send(req: { url: URL; headers: Record<string, string>; body: string }): Promise<TransportResult>;
}

const BLOCKED = 'FB_BLOCKED_DESTINATION';
const TLS_CODES =
  /^(CERT_|ERR_TLS_|ERR_SSL_)|^(UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;

export function classifyError(err: unknown): DeliveryErrorCode {
  const e = err as { name?: string; cause?: { code?: string; name?: string } };
  const code = e.cause?.code ?? '';
  if (code === BLOCKED) return 'blocked_destination';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (TLS_CODES.test(code)) return 'tls_error';
  if (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    e.cause?.name === 'TimeoutError' ||
    e.cause?.name === 'AbortError' ||
    /^UND_ERR_.*TIMEOUT$/.test(code) ||
    code === 'ETIMEDOUT'
  ) {
    return 'timeout';
  }
  return 'connection_error';
}

interface TransportOptions {
  allowedPrivateCidrs: readonly string[];
  lookup?: typeof dns.lookup;
  ca?: string;
  timeoutMs?: number;
  /**
   * Wraps the guarded connector the dispatcher dials with (dependency injection of the socket
   * layer). A wrapper must dial through `guarded`, which applies the address policy and TLS checks.
   */
  connect?: (guarded: buildConnector.connector) => buildConnector.connector;
}

export function createGuardedTransport(o: TransportOptions): WebhookTransport {
  const isAllowed = compileAddressPolicy(o.allowedPrivateCidrs);
  const timeoutMs = o.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const baseLookup = o.lookup ?? dns.lookup;

  const guardedLookup = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (...args: unknown[]) => void,
  ): void => {
    (baseLookup as (h: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => void)(
      hostname,
      { ...options, all: true },
      (err: unknown, addresses: unknown) => {
        if (err) return callback(err);
        const list = addresses as dns.LookupAddress[];
        if (list.length === 0 || !list.every((a) => isAllowed(a.address))) {
          return callback(
            Object.assign(new Error('destination address not allowed'), { code: BLOCKED }),
          );
        }
        if (options.all) return callback(null, list);
        return callback(null, list[0]!.address, list[0]!.family);
      },
    );
  };

  const guarded = buildConnector({
    timeout: 5000,
    lookup: guardedLookup as never,
    ...(o.ca ? { ca: o.ca } : {}),
  });
  const dispatcher = new Agent({
    connect: o.connect ? o.connect(guarded) : guarded,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  return {
    async send({ url, headers, body }) {
      const started = Date.now();
      const elapsed = () => Date.now() - started;
      const syntax = checkSyntax(url.href, isAllowed);
      if (!syntax.ok) {
        return { ok: false, status: null, code: 'blocked_destination', durationMs: elapsed() };
      }
      try {
        const res = await fetch(syntax.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          dispatcher,
          signal: AbortSignal.timeout(timeoutMs),
        });
        void res.body?.cancel().catch(() => undefined);
        const durationMs = elapsed();
        if (res.status >= 200 && res.status < 300)
          return { ok: true, status: res.status, durationMs };
        const code = res.status >= 300 && res.status < 400 ? 'redirect' : 'http_status';
        return { ok: false, status: res.status, code, durationMs };
      } catch (err) {
        return { ok: false, status: null, code: classifyError(err), durationMs: elapsed() };
      }
    },
  };
}
