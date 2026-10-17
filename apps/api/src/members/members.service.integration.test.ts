import { afterAll, beforeAll, expect, it } from 'vitest';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { MembersService } from './members.service.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

it('refuses when the actor was demoted after the guard ran', async () => {
  const { orgId, admin, member } = await orgWithRoles(api, 'stale');
  await api.pool.query(
    "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
    [orgId, admin.userId],
  );
  const svc = api.app.get(MembersService);
  await expect(
    svc.changeRole(
      { organizationId: orgId, actorUserId: admin.userId, role: 'admin', grants: [] },
      member.userId,
      'admin',
    ),
  ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
});

it('treats an actor removed after the guard ran as a non-member', async () => {
  const { orgId, admin, member } = await orgWithRoles(api, 'stale2');
  await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
    orgId,
    admin.userId,
  ]);
  const svc = api.app.get(MembersService);
  await expect(
    svc.remove(
      { organizationId: orgId, actorUserId: admin.userId, role: 'admin', grants: [] },
      member.userId,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
