import { createServer } from 'node:http';
import type { Registry } from '@prometheus-io/client';
import { errorFields, type Logger, type RunningServer } from '@feedbouncer/service-runtime';

export async function startMetricsServer(o: {
  host: string;
  port: number;
  registry: Registry;
  log: Logger;
  allowEphemeral?: boolean;
}): Promise<RunningServer | null> {
  if (o.port === 0 && !o.allowEphemeral) {
    o.log.info('telemetry.metrics_disabled');
    return null;
  }
  let inflight: Promise<string> | null = null;
  const collect = (): Promise<string> => {
    if (!inflight) {
      const p = Promise.resolve().then(() => o.registry.metrics());
      inflight = p;
      const reset = (): void => {
        if (inflight === p) inflight = null;
      };
      p.then(reset, reset);
    }
    return inflight;
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    collect().then(
      (body) => {
        res.writeHead(200, {
          'content-type': o.registry.contentType,
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      (err: unknown) => {
        o.log.warn('telemetry.metrics_failed', errorFields(err));
        res.writeHead(500, { 'content-type': 'text/plain' }).end('metrics unavailable\n');
      },
    );
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, o.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    o.log.error('telemetry.metrics_server_failed', {
      host: o.host,
      port: o.port,
      ...errorFields(err),
    });
    return null;
  }
  server.on('error', (err) => {
    try {
      o.log.warn('telemetry.metrics_server_error', errorFields(err));
    } catch {
      // telemetry never throws
    }
  });
  const port = (server.address() as { port: number }).port;
  o.log.info('telemetry.metrics_ready', { host: o.host, port });
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
