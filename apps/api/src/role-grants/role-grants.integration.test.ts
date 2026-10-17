import { readFileSync } from 'node:fs';
import { GRANTABLE } from '@feedbouncer/authz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

const url = (orgId: string) => `/api/v1/orgs/${orgId}/role-grants`;
const grant = { role: 'member', capability: 'comment.reply' };
const audits = async (orgId: string) =>
  (
    await api.pool.query(
      "SELECT details FROM audit_event WHERE organization_id = $1 AND action = 'org.role_grant_changed'",
      [orgId],
    )
  ).rows;

describe('role grants', () => {
  it('members cannot change grants; an admin grants once and GET shows it', async () => {
    const { orgId, admin, member } = await orgWithRoles(api, 'rg1');
    const denied = await api.req('PUT', url(orgId), {
      cookie: member.cookie,
      body: { ...grant, granted: true },
    });
    expect(denied.status).toBe(403);

    for (let i = 0; i < 2; i++) {
      const r = await api.req('PUT', url(orgId), {
        cookie: admin.cookie,
        body: { ...grant, granted: true },
      });
      expect(r.status).toBe(200);
      expect(r.body.grants).toEqual([grant]);
    }
    const list = await api.req('GET', url(orgId), { cookie: member.cookie });
    expect(list.status).toBe(200);
    expect(list.body.grants).toEqual([grant]);
    expect(await audits(orgId)).toEqual([
      { details: { role: 'member', capability: 'comment.reply', granted: true } },
    ]);
  });

  it('revoking deletes the grant and audits once', async () => {
    const { orgId, owner } = await orgWithRoles(api, 'rg2');
    const put = (granted: boolean) =>
      api.req('PUT', url(orgId), { cookie: owner.cookie, body: { ...grant, granted } });
    await put(true);
    expect((await put(false)).body.grants).toEqual([]);
    expect((await put(false)).status).toBe(200);
    const rows = await api.pool.query('SELECT 1 FROM role_grant WHERE organization_id = $1', [
      orgId,
    ]);
    expect(rows.rowCount).toBe(0);
    expect((await audits(orgId)).map((a) => a.details.granted)).toEqual([true, false]);
  });

  it('rejects other roles and capabilities', async () => {
    const { orgId, owner } = await orgWithRoles(api, 'rg3');
    for (const body of [
      { role: 'admin', capability: 'comment.reply', granted: true },
      { role: 'member', capability: 'rule.write', granted: true },
      { ...grant, granted: 'yes' },
      { ...grant, granted: true, extra: 1 },
    ]) {
      const r = await api.req('PUT', url(orgId), { cookie: owner.cookie, body });
      expect(r.status).toBe(400);
    }
    const rows = await api.pool.query('SELECT 1 FROM role_grant WHERE organization_id = $1', [
      orgId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('a granted member passes the reply capability and a revoked one does not', async () => {
    const { orgId, owner, member } = await orgWithRoles(api, 'rg4');
    const { findMembership } = await import('../tenancy/memberships.repo.js');
    await api.req('PUT', url(orgId), { cookie: owner.cookie, body: { ...grant, granted: true } });
    expect((await findMembership(api.pool, orgId, member.userId))?.grants).toEqual([
      'comment.reply',
    ]);
    await api.req('PUT', url(orgId), { cookie: owner.cookie, body: { ...grant, granted: false } });
    expect((await findMembership(api.pool, orgId, member.userId))?.grants).toEqual([]);
  });
});

describe('GRANTABLE', () => {
  it('matches role_grant_grantable_check', () => {
    const sql = readFileSync(
      new URL(
        '../../../../packages/db/prisma/migrations/20261017000100_inbox_triage/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const check = /role_grant_grantable_check CHECK \((.*)\),/.exec(sql)?.[1];
    const expected = Object.entries(GRANTABLE)
      .flatMap(([cap, roles]) =>
        (roles ?? []).map((r) => `role = '${r}' AND capability = '${cap}'`),
      )
      .join(' OR ');
    expect(check).toBe(expected);
  });
});
