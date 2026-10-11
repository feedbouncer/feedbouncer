import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, login, orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';

// Own app instance: sign-ups are budgeted per instance (per-IP email limit).
let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

const del = (cookie: string) =>
  api.req('POST', '/api/auth/delete-user', { cookie, body: { password: PASSWORD } });
const userRows = async (userId: string) =>
  (await api.pool.query('SELECT 1 FROM app_user WHERE id = $1', [userId])).rowCount;

/** Resolves once some other session of this database is waiting for a lock. */
async function someoneWaitsForALock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rowCount } = await api.pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if (rowCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no session ever waited for a lock');
}

describe('account deletion locking', () => {
  it('waits for the organization lock a member change holds instead of deadlocking with it', async () => {
    const { orgId, member } = await orgWithRoles(api, 'dlk');
    // What MembersService.remove does: lock the organization, then delete the membership.
    const admin = await api.pool.connect();
    try {
      await admin.query('BEGIN');
      await admin.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [orgId]);
      const deletion = del(member.cookie);
      await someoneWaitsForALock();
      await admin.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        member.userId,
      ]);
      await admin.query('COMMIT');
      const r = await deletion;
      expect(r.status).toBe(200);
    } catch (err) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      admin.release();
    }
    expect(await userRows(member.userId)).toBe(0);
  });

  it('a deadlock or serialization failure is 503 temporarily_unavailable and keeps the account', async () => {
    const { member } = await orgWithRoles(api, 'dlk503');
    await api.pool.query(`CREATE FUNCTION test_fail_user_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated' USING ERRCODE = '40P01'; END $$`);
    await api.pool.query(`CREATE TRIGGER test_fail_user_delete_trg BEFORE DELETE ON app_user
      FOR EACH ROW WHEN (OLD.id = '${member.userId}'::uuid) EXECUTE FUNCTION test_fail_user_delete()`);
    try {
      const r = await del(member.cookie);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('temporarily_unavailable');
    } finally {
      await api.pool.query('DROP TRIGGER test_fail_user_delete_trg ON app_user');
      await api.pool.query('DROP FUNCTION test_fail_user_delete()');
    }
    expect(await userRows(member.userId)).toBe(1);
    expect((await api.req('GET', '/api/v1/me', { cookie: member.cookie })).status).toBe(200);
    await expect(login(api, member.email)).resolves.toBeTruthy();
    expect((await del(member.cookie)).status).toBe(200);
  });
});
