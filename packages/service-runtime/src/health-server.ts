import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runChecks, type HealthCheck, type RunChecksOptions } from './health.js';

export interface HealthServerOptions extends RunChecksOptions {
  readonly host: string;
  readonly port: number;
  readonly checks: Readonly<Record<string, HealthCheck>>;
}
export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

export async function startHealthServer(opts: HealthServerOptions): Promise<RunningServer> {
  const server = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      send(res, 400, { status: 'bad_request' });
      return;
    }
    if (pathname !== '/livez' && pathname !== '/healthz') {
      send(res, 404, { status: 'not_found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { status: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    if (pathname === '/livez') {
      send(res, 200, { status: 'ok' });
      return;
    }
    runChecks(opts.checks, opts).then(
      (report) => send(res, report.status === 'ok' ? 200 : 503, report),
      () => send(res, 500, { status: 'error' }),
    );
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
