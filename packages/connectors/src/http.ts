import { ConnectorError } from './errors.js';

export interface SafeHttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface SafeHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}
export interface SafeHttp {
  request(req: SafeHttpRequest, signal: AbortSignal): Promise<SafeHttpResponse>;
}

const MAX_RETRY_AFTER_MS = 86_400_000;
const disallowed = () => new ConnectorError('permanent', 'disallowed_url');

export function assertAllowedUrl(input: string | URL, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw disallowed();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw disallowed();
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) throw disallowed();
  return url;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel();
    throw new ConnectorError('permanent', 'response_too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ConnectorError('permanent', 'response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Maps any foreign failure to a ConnectorError without retaining its message. */
function transportError(err: unknown, signal: AbortSignal): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const timedOut =
    signal.aborted ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
  return new ConnectorError('transient', timedOut ? 'timeout' : 'network_error');
}

export function createSafeHttp(opts: {
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}): SafeHttp {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const max = opts.maxResponseBytes ?? 2 * 1024 * 1024;
  return {
    async request(req, signal) {
      const url = assertAllowedUrl(req.url, opts.allowedHosts);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          ...(req.headers && { headers: { ...req.headers } }),
          ...(req.body !== undefined && { body: req.body }),
          redirect: 'manual',
          signal,
        });
      } catch (err) {
        throw transportError(err, signal);
      }
      let body: string;
      try {
        body = await readCapped(res, max);
      } catch (err) {
        throw transportError(err, signal);
      }
      return { status: res.status, headers: res.headers, body };
    },
  };
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d{1,12}$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  if (!/[A-Za-z]/.test(v)) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(t - nowMs, 0), MAX_RETRY_AFTER_MS);
}
