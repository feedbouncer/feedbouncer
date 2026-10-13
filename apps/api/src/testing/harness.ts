// Integration-test harness: a real app on a scratch, migrated database and a
// real Redis (keys isolated by a random prefix), with an in-memory mailer.
// Requests go through fastify.inject, so no port is opened.
// Needs DATABASE_URL (admin connection for scratch databases) and REDIS_URL.
import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Redis } from 'ioredis';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPool } from '@feedbouncer/db';
import { loadJobsConfig } from '@feedbouncer/jobs';
import { migratedDb } from '@feedbouncer/db/testing';
import { extractFirstUrl, MemoryMailer } from '@feedbouncer/mailer/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import {
  PgHealthReader,
  createMetrics,
  loadHealthPolicy,
  loadTelemetryConfig,
} from '@feedbouncer/observability';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { buildApp } from '../app.factory.js';
import type { AppDeps } from '../deps.js';
import type { ApiEnv } from '../env.js';
import { buildFacebookDeps, type FacebookDeps } from '../facebook-deps.js';

export const WEB = 'http://localhost:3000';

export interface TestResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into arbitrary JSON
  body: any;
  headers: Record<string, unknown>;
  /** The Set-Cookie name=value pairs of this response, joined for a Cookie header. */
  cookie: string | null;
}

export interface RawResponse {
  status: number;
  headers: Record<string, unknown>;
  text: string;
}

export interface SeededFacebookConnection {
  /** The numeric Page id the connection is bound to (the webhook entry id). */
  pageId: string;
  scope: { organizationId: string; brandId: string; connectionId: string };
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
  /** No default Origin and no JSON parsing: the body is sent and returned as bytes/text. */
  raw(
    method: string,
    url: string,
    opts?: { body?: string; headers?: Record<string, string> },
  ): Promise<RawResponse>;
  /** Inserts an active Facebook connection with a random 15-digit Page id into an organization's brand. */
  seedFacebookConnection(org: {
    orgId: string;
    brandId: string;
  }): Promise<SeededFacebookConnection>;
  close(): Promise<void>;
}

/**
 * `deps` replaces individual AppDeps built by the harness (e.g. a failing
 * producer). Facebook-backed deps exist only when `overrides.facebook` is set.
 */
export async function startTestApi(
  overrides: Partial<ApiEnv> = {},
  depsOverrides: Partial<Pick<AppDeps, 'connectors' | 'producer' | 'comments'>> = {},
): Promise<TestApi> {
  const redisRaw = process.env.REDIS_URL;
  if (!redisRaw) {
    throw new Error(
      'REDIS_URL must be set for API integration tests (see README.md, Common commands).',
    );
  }
  const db = await migratedDb();
  const env: ApiEnv = {
    appEnv: 'test',
    databaseUrl: db.db.url,
    redisUrl: new URL(redisRaw),
    port: 0,
    logLevel: 'error',
    authSecret: new Secret('test-only-auth-secret-0123456789abcdef'),
    publicWebUrl: new URL(WEB),
    smtpUrl: new URL('smtp://127.0.0.1:1'),
    mailFrom: 'FeedBouncer <no-reply@localhost>',
    trustProxyHops: 0,
    encryption: testKeyring(),
    telemetry: loadTelemetryConfig({ METRICS_PORT: '0' }, 'api'),
    health: loadHealthPolicy({}),
    facebook: null,
    // A random queue prefix per app keeps tests from sharing BullMQ keys.
    jobs: loadJobsConfig({ JOB_QUEUE_PREFIX: `t${randomUUID().replaceAll('-', '').slice(0, 20)}` }),
    ...overrides,
  };
  const logLines: string[] = [];
  const log = createLogger('api-test', 'debug', (l) => logLines.push(l));
  const pool = createPool(env.databaseUrl, { applicationName: 'api-test', onIdleError: () => {} });
  const redis = new Redis(env.redisUrl.href, { maxRetriesPerRequest: 1 });
  redis.on('error', () => {}); // reported through /healthz; tests may point at a dead Redis
  const redisKeyPrefix = `fbtest:${randomUUID()}:`;
  const mailer = new MemoryMailer();
  const metrics = createMetrics('api');
  const facebook: FacebookDeps | null = buildFacebookDeps({ env, pool, log, metrics });
  const deps: AppDeps = {
    env,
    pool,
    redis,
    mailer,
    log,
    redisKeyPrefix,
    metrics,
    health: new PgHealthReader(pool, env.health),
    connectors: facebook?.connectors ?? null,
    producer: facebook?.producer ?? null,
    comments: facebook?.comments ?? null,
    ...depsOverrides,
  };
  let app: NestFastifyApplication;
  try {
    app = await buildApp(deps);
  } catch (err) {
    await facebook?.close();
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
    async raw(method, url, opts = {}) {
      const res = await fastify.inject({
        method: method as never,
        url,
        headers: opts.headers ?? {},
        ...(opts.body === undefined ? {} : { payload: opts.body }),
      });
      return { status: res.statusCode, headers: res.headers, text: res.body };
    },
    async seedFacebookConnection(org) {
      const pageId = `1${String(randomInt(0, 100_000_000_000_000)).padStart(14, '0')}`;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
         VALUES ($1, $2, 'facebook', $3, 'active') RETURNING id`,
        [org.orgId, org.brandId, pageId],
      );
      return {
        pageId,
        scope: { organizationId: org.orgId, brandId: org.brandId, connectionId: rows[0]!.id },
      };
    },
    async close() {
      await app.close();
      await facebook?.close();
      if (redis.status === 'ready') {
        const queueKeys = await redis.keys(`${env.jobs.prefix}:*`);
        if (queueKeys.length) await redis.del(...queueKeys);
      }
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

export const PASSWORD = 'correct horse battery staple 42';
const tick = () => new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget

/** Signs up through the public endpoint and follows the emailed verification link. */
export async function signUpAndVerify(
  api: TestApi,
  email: string,
  name = 'Test User',
): Promise<{ userId: string; email: string }> {
  const r = await api.req('POST', '/api/v1/auth/sign-up', {
    body: { email, password: PASSWORD, name },
  });
  if (r.status !== 202) throw new Error(`sign-up failed: ${r.status}`);
  await tick();
  const normalized = email.trim().toLowerCase();
  const url = new URL(extractFirstUrl(api.mailer.lastTo(normalized)!.text)!);
  const v = await api.req('GET', `${url.pathname}${url.search}`);
  if (v.status !== 302) throw new Error(`verify failed: ${v.status}`);
  const { rows } = await api.pool.query('SELECT id FROM app_user WHERE email = $1', [normalized]);
  return { userId: rows[0].id as string, email: normalized };
}

/** Logs in through the public endpoint and returns the Cookie header value. */
export async function login(api: TestApi, email: string, password = PASSWORD): Promise<string> {
  const r = await api.req('POST', '/api/auth/sign-in/email', { body: { email, password } });
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${r.status}`);
  return r.cookie;
}

export async function verifiedUser(
  api: TestApi,
  label: string,
): Promise<{ userId: string; email: string; cookie: string }> {
  const u = await signUpAndVerify(api, `${label}-${randomUUID().slice(0, 8)}@x.test`);
  return { ...u, cookie: await login(api, u.email) };
}

export interface TestUser {
  userId: string;
  email: string;
  cookie: string;
}

export interface OrgFixture {
  orgId: string;
  brandId: string;
  owner: TestUser;
  admin: TestUser;
  member: TestUser;
}

/**
 * An organization created through the API by its owner, plus an admin and a
 * member added directly in the database. Signs up three users unless `users`
 * is given (each test file has a small email budget, so share users).
 */
export async function orgWithRoles(
  api: TestApi,
  label: string,
  users?: Pick<OrgFixture, 'owner' | 'admin' | 'member'>,
): Promise<OrgFixture> {
  const owner = users?.owner ?? (await verifiedUser(api, `${label}-owner`));
  const created = await api.req('POST', '/api/v1/orgs', {
    cookie: owner.cookie,
    body: { name: `${label} Org`, brandName: `${label} Brand` },
  });
  if (created.status !== 201) throw new Error(`org create failed: ${created.status}`);
  const orgId = created.body.organization.id as string;
  const brandId = created.body.brand.id as string;
  const admin = users?.admin ?? (await verifiedUser(api, `${label}-admin`));
  const member = users?.member ?? (await verifiedUser(api, `${label}-member`));
  await api.pool.query(
    "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')",
    [orgId, admin.userId, member.userId],
  );
  return { orgId, brandId, owner, admin, member };
}
