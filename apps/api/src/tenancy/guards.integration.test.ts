import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, verifiedUser, type TestApi } from '../testing/harness.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

describe('GET /api/v1/me', () => {
  it('without a cookie is 401 unauthenticated', async () => {
    const r = await api.req('GET', '/api/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });

  it('with a forged cookie is 401', async () => {
    const r = await api.req('GET', '/api/v1/me', { cookie: 'fb.session_token=forged.value' });
    expect(r.status).toBe(401);
  });

  it('returns the user and memberships, and no secrets', async () => {
    const u = await verifiedUser(api, 'me');
    const r = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user: { id: u.userId, email: u.email, name: 'Test User', emailVerified: true },
      memberships: [],
    });
    expect(JSON.stringify(r.body)).not.toMatch(/token|password|hash/i);
  });

  it('lists memberships ordered by organization name, and reads them fresh', async () => {
    const u = await verifiedUser(api, 'me-orgs');
    const other = await verifiedUser(api, 'me-orgs-owner');
    const org = async (name: string, role: string) => {
      const o = await api.pool.query<{ id: string }>(
        'INSERT INTO organization (name) VALUES ($1) RETURNING id',
        [name],
      );
      await api.pool.query(
        'INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [o.rows[0]!.id, u.userId, role],
      );
      return o.rows[0]!.id;
    };
    const b = await org('Beta', 'member');
    // An organization must keep an owner, so someone else owns Beta.
    await api.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
      [b, other.userId],
    );
    const a = await org('Alpha', 'owner');
    const first = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(first.body.memberships).toEqual([
      { organizationId: a, organizationName: 'Alpha', role: 'owner' },
      { organizationId: b, organizationName: 'Beta', role: 'member' },
    ]);
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      b,
      u.userId,
    ]);
    const second = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(second.body.memberships).toEqual([
      { organizationId: a, organizationName: 'Alpha', role: 'owner' },
    ]);
  });
});
