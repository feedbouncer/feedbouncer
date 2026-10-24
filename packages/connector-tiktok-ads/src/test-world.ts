import { vi, type Mock } from 'vitest';
import { createSafeHttp, type CallContext, type OAuthContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createTikTokAdsConnector } from './connector.js';

export const APP = { appId: '7300000000000002', appSecret: 'tiktok-ads-SECRET-0123456789' };
export const NOW = new Date('2026-10-24T10:00:00Z');
type Log = (msg: string, fields: { code: string; count?: number }) => void;

/** A connected advertiser. `tamper` rewrites the JSON `data` of responses for `path`. */
export async function world(setup: (fake: FakeTikTok) => void = () => {}) {
  const fake = new FakeTikTok({ ...APP, now: () => NOW });
  setup(fake);
  const log: Mock<Log> = vi.fn<Log>();
  const connector = createTikTokAdsConnector(APP, { clock: { now: () => NOW.getTime() }, log });
  let tamper: { path: string; fn: (data: Record<string, unknown>) => unknown } | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    if (!tamper || !String(input).includes(tamper.path)) return res;
    const json = (await res.json()) as { data: Record<string, unknown> };
    return Response.json({ ...json, data: tamper.fn(json.data) });
  };
  const http = createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch });
  const signal = AbortSignal.timeout(5000);
  const oauth: OAuthContext = { http, signal, redirectUri: 'https://app.test/cb' };
  const { advertiserId, authCode } = fake.addAdvertiser({ name: 'Acme Ads' });
  const { tokens } = await connector.exchangeCode(
    { code: new Secret(authCode), codeVerifier: new Secret('v') },
    oauth,
  );
  const ctx: CallContext = {
    accessToken: tokens.accessToken,
    externalAccountId: advertiserId,
    http,
    signal,
    reportQuota: async () => {},
  };
  return {
    fake,
    connector,
    ctx,
    oauth,
    log,
    http,
    signal,
    advertiserId,
    tokens,
    tamper: (path: string, fn: (d: Record<string, unknown>) => unknown) => (tamper = { path, fn }),
  };
}
