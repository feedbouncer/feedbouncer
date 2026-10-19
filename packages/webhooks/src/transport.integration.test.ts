import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import dns from 'node:dns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { buildConnector } from 'undici';
import { createGuardedTransport } from './transport.js';

// The receiver listens on a random port, so the agent's connector is wrapped to dial that port. The URL
// the policy sees keeps port 443, and the guarded connector still runs the address lookup and TLS checks.
vi.mock('undici', async (importOriginal) => {
  const undici = await importOriginal<typeof import('undici')>();
  class DialingAgent extends undici.Agent {
    constructor(o: { connect: buildConnector.connector }) {
      super({
        ...o,
        connect: (opts, cb) => o.connect({ ...opts, port: String(testPort.value) }, cb),
      });
    }
  }
  return { ...undici, Agent: DialingAgent };
});

const run = promisify(execFile);
let dir: string;
let cert: string;
let key: string;
let server: Server;
let port: number;
const testPort = vi.hoisted(() => ({ value: 0 }));
let requests = 0;
let connections = 0;
let handler: RequestListener = (_req, res) => res.writeHead(204).end();

const toLoopback = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  if (host === 'receiver.test') {
    const all = (opts as { all?: boolean }).all;
    return all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  }
  return dns.lookup(host, opts as never, cb as never);
}) as unknown as typeof dns.lookup;

const target = () => new URL('https://receiver.test/hook');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wh-'));
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=receiver.test',
    '-addext',
    'subjectAltName=DNS:receiver.test',
    '-keyout',
    join(dir, 'k.pem'),
    '-out',
    join(dir, 'c.pem'),
  ]);
  cert = await readFile(join(dir, 'c.pem'), 'utf8');
  key = await readFile(join(dir, 'k.pem'), 'utf8');
  server = createServer({ cert, key }, (req, res) => {
    requests += 1;
    handler(req, res);
  });
  server.on('connection', () => (connections += 1));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  testPort.value = port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const reset = () => {
  requests = 0;
  connections = 0;
};

const make = (o: Record<string, unknown> = {}) =>
  createGuardedTransport({
    allowedPrivateCidrs: ['127.0.0.0/8'],
    lookup: toLoopback,
    ca: cert,
    ...o,
  });
const send = (t: ReturnType<typeof make>, url = target()) =>
  t.send({ url, headers: { 'content-type': 'application/json' }, body: '{}' });

describe('guarded transport', () => {
  it('delivers a 2xx', async () => {
    reset();
    handler = (_q, res) => res.writeHead(204).end();
    expect(await send(make())).toMatchObject({ ok: true, status: 204 });
  });

  it('classifies other statuses as http_status', async () => {
    handler = (_q, res) => res.writeHead(500).end('nope');
    expect(await send(make())).toMatchObject({ ok: false, status: 500, code: 'http_status' });
  });

  it('never follows redirects', async () => {
    reset();
    handler = (_q, res) => res.writeHead(302, { location: 'https://receiver.test/other' }).end();
    expect(await send(make())).toMatchObject({ ok: false, status: 302, code: 'redirect' });
    expect(requests).toBe(1);
  });

  it('times out when headers are late', async () => {
    handler = (_q, res) => setTimeout(() => res.writeHead(200).end(), 1000);
    const started = Date.now();
    const r = await send(make({ timeoutMs: 300 }));
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(800);
  });

  it('cancels a never-ending response body instead of awaiting it', async () => {
    handler = (_q, res) => {
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(1024)), 100);
      res.on('close', () => clearInterval(t));
    };
    const started = Date.now();
    expect(await send(make())).toMatchObject({ ok: true, status: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails TLS verification without the CA', async () => {
    handler = (_q, res) => res.writeHead(204).end();
    expect(await send(make({ ca: undefined }))).toMatchObject({ ok: false, code: 'tls_error' });
  });

  it('blocks a name that resolves to a private address at connect time (DNS rebinding)', async () => {
    reset();
    const r = await send(make({ allowedPrivateCidrs: [] }));
    expect(r).toMatchObject({ ok: false, status: null, code: 'blocked_destination' });
    expect(connections).toBe(0);
  });

  it('blocks when any one of several answers is private', async () => {
    reset();
    const mixed = ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts.all
        ? cb(null, [
            { address: '93.184.215.14', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ])
        : cb(null, '93.184.215.14', 4)) as unknown as typeof dns.lookup;
    const r = await send(make({ allowedPrivateCidrs: [], lookup: mixed }));
    expect(r).toMatchObject({ ok: false, code: 'blocked_destination' });
    expect(connections).toBe(0);
  });

  it('blocks IP literals before connecting', async () => {
    reset();
    for (const u of ['https://[::1]/', 'https://2130706433/', 'https://169.254.169.254/']) {
      expect(await send(make({ allowedPrivateCidrs: [] }), new URL(u))).toMatchObject({
        ok: false,
        code: 'blocked_destination',
      });
    }
  });

  it('refuses a non-443 port without connecting', async () => {
    reset();
    const r = await send(make(), new URL('https://receiver.test:8443/'));
    expect(r).toMatchObject({ ok: false, status: null, code: 'blocked_destination' });
    expect(connections).toBe(0);
    expect(() => createGuardedTransport({ allowedPrivateCidrs: ['bad'] })).toThrow();
  });

  it('reports unresolvable names as dns_error', async () => {
    const r = await send(make({ lookup: undefined }), new URL('https://does-not-exist.invalid/'));
    expect(r).toMatchObject({ ok: false, code: 'dns_error' });
  });
});
