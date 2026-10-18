import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, startTestApi, type TestApi } from '../testing/harness.js';

const tick = () => new Promise((r) => setTimeout(r, 50)); // emails are fire-and-forget
const LIST = new Set(['partner@example.com']);
const CLOSED = 'FeedBouncer is in private beta';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const signUp = (email: string) =>
  api!.req('POST', '/api/v1/auth/sign-up', { body: { email, password: PASSWORD, name: 'P' } });
const userCount = async (email: string) =>
  (await api!.pool.query('SELECT 1 FROM app_user WHERE email = $1', [email])).rowCount;

async function invite(email: string, state: 'pending' | 'expired' | 'revoked'): Promise<void> {
  const { rows } = await api!.pool.query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Beta') RETURNING id`,
  );
  await api!.pool.query(
    `INSERT INTO invitation (organization_id, email, role, token_hash, status, expires_at, revoked_at)
     VALUES ($1, $2, 'member', $3, $4, now() + $5::interval, $6)`,
    [
      rows[0]!.id,
      email,
      randomBytes(32),
      state === 'revoked' ? 'revoked' : 'pending',
      state === 'expired' ? '-1 day' : '7 days',
      state === 'revoked' ? new Date() : null,
    ],
  );
}

describe('sign-up allowlist', () => {
  it('allowlist unset: anyone can sign up', async () => {
    api = await startTestApi({ signupAllowlist: null });
    expect((await signUp('anyone@example.com')).status).toBe(202);
    expect(await userCount('anyone@example.com')).toBe(1);
  });

  it('listed email (case/space-insensitive) can sign up', async () => {
    api = await startTestApi({ signupAllowlist: LIST });
    expect((await signUp(' Partner@Example.com ')).status).toBe(202);
    expect(await userCount('partner@example.com')).toBe(1);
  });

  it('email with a pending invitation can sign up', async () => {
    api = await startTestApi({ signupAllowlist: LIST });
    await invite('invited@example.com', 'pending');
    await signUp('invited@example.com');
    expect(await userCount('invited@example.com')).toBe(1);
  });

  it('expired or revoked invitation does not count', async () => {
    api = await startTestApi({ signupAllowlist: LIST });
    await invite('late@example.com', 'expired');
    await invite('gone@example.com', 'revoked');
    await signUp('late@example.com');
    await signUp('gone@example.com');
    expect(await userCount('late@example.com')).toBe(0);
    expect(await userCount('gone@example.com')).toBe(0);
  });

  it('unlisted email gets 202 verification_sent, no user row, signupClosed sent once', async () => {
    api = await startTestApi({ signupAllowlist: LIST, betaSupportEmail: 'help@example.com' });
    const r = await signUp('stranger@example.com');
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'verification_sent' });
    await tick();
    expect(await userCount('stranger@example.com')).toBe(0);
    const mails = api.mailer.sent.filter((m) => m.to === 'stranger@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe(CLOSED);
    expect(mails[0]!.text).toContain('help@example.com');
  });

  it('rate limit still applies to unlisted email', async () => {
    api = await startTestApi({ signupAllowlist: LIST });
    for (let i = 0; i < 3; i++) expect((await signUp('spam@example.com')).status).toBe(202);
    expect((await signUp('spam@example.com')).status).toBe(429);
  });
});
