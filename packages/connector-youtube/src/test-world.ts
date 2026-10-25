import { createSafeHttp, type CallContext, type QuotaMeter } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { API_HOSTS } from './config.js';
import { createYouTubeConnector } from './connector.js';
import { FakeYouTube } from './testing/index.js';

export const CHANNEL = 'UC' + 'c'.repeat(22);
export const NOW = Date.parse('2026-10-24T10:00:00Z');
export const CLIENT = { clientId: 'yt-client-id', clientSecret: 'yt-client-SECRET-0123456789' };

/** Records every reservation and settle; never refuses. */
export function memoryMeter() {
  const reserved: { method: string; units: number; purpose: string }[] = [];
  const settled: { callKey: string; ok: boolean; errorCode?: string }[] = [];
  let n = 0;
  const meter: QuotaMeter = {
    reserve: async (req) => {
      reserved.push(req);
      n += 1;
      return { callKey: `k${n}`, units: req.units };
    },
    settle: async (t, o) => {
      settled.push({ callKey: t.callKey, ...o });
    },
  };
  return { meter, reserved, settled };
}

/**
 * A connected channel with one video. `tamper` rewrites the JSON body of responses whose URL
 * path ends with `path` (for hostile-response tests).
 */
export function world() {
  const fake = new FakeYouTube({
    ...CLIENT,
    channel: { id: CHANNEL, title: 'Mine' },
    clock: () => NOW,
  });
  const quota = memoryMeter();
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const connector = createYouTubeConnector(
    { clientId: CLIENT.clientId, clientSecret: new Secret(CLIENT.clientSecret) },
    {
      clock: { now: () => NOW },
      log: (msg, fields) => logs.push({ msg, fields }),
    },
  );
  let tamper: { path: string; fn: (json: Record<string, unknown>) => unknown } | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!tamper || !url.pathname.endsWith(tamper.path) || res.status !== 200) return res;
    const json = (await res.json()) as Record<string, unknown>;
    return Response.json(tamper.fn(json));
  };
  const ctx: CallContext = {
    accessToken: new Secret(fake.issueAccessToken()),
    externalAccountId: CHANNEL,
    http: createSafeHttp({ allowedHosts: API_HOSTS, fetch }),
    signal: AbortSignal.timeout(5000),
    reportQuota: async () => {},
    quota: quota.meter,
  };
  const videoId = fake.addVideo();
  /** Data API calls only (OAuth endpoints excluded). */
  const apiCalls = () => fake.calls.filter((c) => !c.method.startsWith('oauth.'));
  return {
    fake,
    connector,
    ctx,
    quota,
    logs,
    videoId,
    apiCalls,
    tamper: (path: string, fn: (json: Record<string, unknown>) => unknown) => {
      tamper = { path, fn };
    },
  };
}
