// Integration-test harness: a real app on a scratch, migrated database and a
// real Redis (keys isolated by a random prefix), with an in-memory mailer.
// Requests go through fastify.inject, so no port is opened.
// Needs DATABASE_URL (admin connection for scratch databases) and REDIS_URL.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Redis } from 'ioredis';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPool } from '@feedbouncer/db';
import { migratedDb } from '@feedbouncer/db/testing';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { buildApp } from '../app.factory.js';
import type { AppDeps } from '../deps.js';
import type { ApiEnv } from '../env.js';

export const WEB = 'http://localhost:3000';

export interface TestResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into arbitrary JSON
  body: any;
  headers: Record<string, unknown>;
  /** The Set-Cookie name=value pairs of this response, joined for a Cookie header. */
  cookie: string | null;
}

export interface TestApi {
  app: NestFastifyApplication;
  pool: pg.Pool;
  mailer: MemoryMailer;
  deps: AppDeps;
  /** Every log line the app wrote (JSON), for assertions about what is logged. */
  logLines: string[];
  /**
   * Sends Origin: WEB by default. Pass a header with the value '' to omit it.
   */
  req(
    method: string,
    url: string,
    opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> },
  ): Promise<TestResponse>;
  close(): Promise<void>;
}

export async function startTestApi(overrides: Partial<ApiEnv> = {}): Promise<TestApi> {
  const redisRaw = process.env.REDIS_URL;
  if (!redisRaw) {
    throw new Error(
      'REDIS_URL must be set for API integration tests (see README.md, Common commands).',
    );
  }
  const db = await migratedDb();
  const env: ApiEnv = {
    databaseUrl: db.db.url,
    redisUrl: new URL(redisRaw),
    port: 0,
    logLevel: 'error',
    authSecret: 'test-only-auth-secret-0123456789abcdef',
    publicWebUrl: new URL(WEB),
    smtpUrl: new URL('smtp://127.0.0.1:1'),
    mailFrom: 'FeedBouncer <no-reply@localhost>',
    trustProxyHops: 0,
    ...overrides,
  };
  const logLines: string[] = [];
  const log = createLogger('api-test', 'debug', (l) => logLines.push(l));
  const pool = createPool(env.databaseUrl, { applicationName: 'api-test', onIdleError: () => {} });
  const redis = new Redis(env.redisUrl.href, { maxRetriesPerRequest: 1 });
  redis.on('error', () => {}); // reported through /healthz; tests may point at a dead Redis
  const redisKeyPrefix = `fbtest:${randomUUID()}:`;
  const mailer = new MemoryMailer();
  const deps: AppDeps = { env, pool, redis, mailer, log, redisKeyPrefix };
  let app: NestFastifyApplication;
  try {
    app = await buildApp(deps);
  } catch (err) {
    redis.disconnect();
    await pool.end();
    await db.close();
    throw err;
  }
  const fastify = app.getHttpAdapter().getInstance();

  return {
    app,
    pool,
    mailer,
    deps,
    logLines,
    async req(method, url, opts = {}) {
      const merged: Record<string, string> = { origin: WEB, ...(opts.headers ?? {}) };
      if (opts.cookie) merged.cookie = opts.cookie;
      const headers = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''));
      const res = await fastify.inject({
        method: method as never,
        url,
        headers,
        ...(opts.body === undefined ? {} : { payload: opts.body as never }),
      });
      const setCookie = res.headers['set-cookie'];
      const cookies = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
        .map((c) => c.split(';')[0])
        .join('; ');
      let body: unknown = null;
      try {
        body = res.json();
      } catch {
        body = res.body;
      }
      return { status: res.statusCode, body, headers: res.headers, cookie: cookies || null };
    },
    async close() {
      await app.close();
      if (redis.status === 'ready') {
        const keys = await redis.keys(`${redisKeyPrefix}*`);
        if (keys.length) await redis.del(...keys);
        await redis.quit();
      } else {
        redis.disconnect();
      }
      await pool.end();
      await db.close();
    },
  };
}
