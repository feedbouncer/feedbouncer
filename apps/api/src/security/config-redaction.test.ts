// Objects serialized whole must not leak secrets: the loaded config is the
// most likely thing to be dumped by accident.
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadApiEnv } from '../env.js';

const AUTH = 'sentinel-auth-secret-0123456789abcdef-XYZ';
const DB_PW = 'sentinel-db-password-123';
const REDIS_PW = 'sentinel-redis-password-456';
const SMTP_PW = 'sentinel-smtp-password-789';

function load() {
  const entry = randomKeyEntry('k1');
  const material = entry.slice(3);
  const env = loadApiEnv(
    {
      FB_ENV: 'production',
      DATABASE_URL: `postgresql://u:${DB_PW}@db:5432/x`,
      REDIS_URL: `redis://:${REDIS_PW}@redis:6379/0`,
      AUTH_SECRET: AUTH,
      PUBLIC_WEB_URL: 'https://app.example.com',
      SMTP_URL: `smtp://mail:${SMTP_PW}@mail:25`,
      FB_ENCRYPTION_KEYS: entry,
      FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    },
    { warn: () => {} },
  );
  return { env, material };
}

it('the loaded ApiEnv never prints key material via JSON or inspect', () => {
  const { env, material } = load();
  for (const out of [
    JSON.stringify(env.encryption),
    inspect(env, { depth: 10, showHidden: true }),
  ]) {
    expect(out).not.toContain(material);
    expect(out).not.toContain(Buffer.from(material, 'base64').toString('hex'));
  }
});

it('a whole-config dump contains no auth secret or connection passwords', () => {
  const { env } = load();
  const dumps = [
    JSON.stringify(env),
    JSON.stringify({ config: env }),
    inspect(env, { depth: 10, showHidden: true }),
    `${inspect(env)}`,
  ];
  for (const out of dumps) {
    for (const s of [AUTH, DB_PW, REDIS_PW, SMTP_PW]) expect(out).not.toContain(s);
  }
});

it('the loaded config stays typed and readable for code', () => {
  const { env } = load();
  expect(env.authSecret.reveal()).toBe(AUTH);
  expect(env.databaseUrl.password).toBe(DB_PW);
  expect(env.redisUrl.password).toBe(REDIS_PW);
  expect(String(env.authSecret)).not.toContain(AUTH);
});
