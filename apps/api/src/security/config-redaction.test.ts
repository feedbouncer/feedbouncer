// Objects serialized whole must not leak secrets: the loaded config is the
// most likely thing to be dumped by accident.
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadApiEnv } from '../env.js';

it('the loaded ApiEnv never prints key material via JSON or inspect', () => {
  const entry = randomKeyEntry('k1');
  const material = entry.slice(3);
  const env = loadApiEnv(
    {
      FB_ENV: 'production',
      DATABASE_URL: 'postgresql://u:real-pw-123@db:5432/x',
      REDIS_URL: 'redis://:real-pw-456@redis:6379/0',
      AUTH_SECRET: 'a-real-looking-auth-secret-0123456789abcdef',
      PUBLIC_WEB_URL: 'https://app.example.com',
      SMTP_URL: 'smtp://mail:25',
      FB_ENCRYPTION_KEYS: entry,
      FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    },
    { warn: () => {} },
  );
  for (const out of [
    JSON.stringify(env.encryption),
    inspect(env, { depth: 10, showHidden: true }),
  ]) {
    expect(out).not.toContain(material);
    expect(out).not.toContain(Buffer.from(material, 'base64').toString('hex'));
  }
});
