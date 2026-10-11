import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  login,
  orgWithRoles,
  PASSWORD,
  signUpAndVerify,
  startTestApi,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';
import { hashInvitationToken } from './token.js';

const KNOWN_TOKEN = 'A'.repeat(43);

let api: TestApi;
// Sign-ups and invitation emails share a per-IP budget, so organizations reuse these users.
let shared: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
beforeAll(async () => {
  api = await startTestApi();
  const first = await orgWithRoles(api, 'inv');
  shared = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const org = (label: string) => orgWithRoles(api, label, shared);
const tokenFrom = (to: string) =>
  new URL(extractFirstUrl(api.mailer.lastTo(to)!.text)!).searchParams.get('token')!;
// Inserts a pending invitation directly (the per-IP email budget is small) and returns its token.
async function seed(orgId: string, email: string, role = 'member') {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await api.pool.query(
    `INSERT INTO invitation (organization_id, email, role, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING id`,
    [orgId, email, role, hashInvitationToken(token)],
  );
  return { token, id: rows[0].id as string };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const invite = (orgId: string, cookie: string, email: string, role: string) =>
  api.req('POST', `/api/v1/orgs/${orgId}/invitations`, { cookie, body: { email, role } });
const accept = (cookie: string, token: string) =>
  api.req('POST', '/api/v1/invitations/accept', { cookie, body: { token } });
const lookup = (cookie: string, token: string) =>
  api.req('POST', '/api/v1/invitations/lookup', { cookie, body: { token } });

describe('invite lifecycle', () => {
  it('admin invites, invitee signs up with the same email (different case) and accepts with the invited role', async () => {
    const { orgId, admin } = await org('life');
    const r = await invite(orgId, admin.cookie, 'New.Person@X.test', 'admin');
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('created');
    expect(r.body.emailSent).toBe(true);
    expect(Object.keys(r.body.invitation).sort()).toEqual([
      'createdAt',
      'email',
      'expired',
      'expiresAt',
      'id',
      'role',
      'status',
    ]);
    await tick();
    const token = tokenFrom('new.person@x.test');
    const invitee = await signUpAndVerify(api, 'NEW.PERSON@x.test');
    const cookie = await login(api, invitee.email);
    const look = await lookup(cookie, token);
    expect(look.body).toEqual({ organizationName: 'life Org', role: 'admin', emailMatches: true });
    const acc = await accept(cookie, token);
    expect(acc.body).toEqual({ organizationId: orgId, role: 'admin' });
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie })).body.role).toBe('admin');
    // Single use: the same link is dead afterwards.
    expect((await accept(cookie, token)).status).toBe(404);
    expect((await lookup(cookie, token)).status).toBe(404);
  });

  it('lists pending invitations of the organization only, to managers only', async () => {
    const { orgId, owner, member } = await org('list');
    const other = await org('list-other');
    await invite(orgId, owner.cookie, 'l1@x.test', 'member');
    await seed(other.orgId, 'l2@x.test');
    const r = await api.req('GET', `/api/v1/orgs/${orgId}/invitations`, { cookie: owner.cookie });
    expect(r.body.invitations.map((i: { email: string }) => i.email)).toEqual(['l1@x.test']);
    expect(r.body.invitations[0].expired).toBe(false);
    const denied = await api.req('GET', `/api/v1/orgs/${orgId}/invitations`, {
      cookie: member.cookie,
    });
    expect(denied.status).toBe(403);
  });

  it('re-inviting a pending address renews the same row (no duplicate) and the old link stops working', async () => {
    const { orgId, owner, member } = await org('reinv');
    await invite(orgId, owner.cookie, 'r@x.test', 'member');
    await tick();
    const t1 = tokenFrom('r@x.test');
    const again = await invite(orgId, owner.cookie, 'R@x.test', 'admin');
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('renewed');
    await tick();
    const t2 = tokenFrom('r@x.test');
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM invitation WHERE organization_id = $1 AND email = 'r@x.test'",
      [orgId],
    );
    expect(rows[0].n).toBe(1);
    expect((await lookup(member.cookie, t1)).status).toBe(404);
    expect((await lookup(member.cookie, t2)).body.role).toBe('admin');
  });

  it('invite emails are rate-limited per address; the invitation itself still succeeds', async () => {
    const { orgId, owner } = await org('invlimit');
    for (let i = 0; i < 3; i++) {
      const r = await invite(orgId, owner.cookie, 'capped@x.test', 'member');
      expect(r.body.emailSent).toBe(true);
    }
    const fourth = await invite(orgId, owner.cookie, 'capped@x.test', 'member');
    expect(fourth.status).toBe(201);
    expect(fourth.body.status).toBe('renewed');
    expect(fourth.body.emailSent).toBe(false);
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM invitation WHERE organization_id = $1 AND email = 'capped@x.test'",
      [orgId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a rate-limited renewal keeps the emailed link working and still bumps the role', async () => {
    // Own API instance: the per-IP email budget of the shared one is nearly spent.
    const own = await startTestApi();
    try {
      const { orgId, owner, member } = await orgWithRoles(own, 'keeptoken');
      const tokenOf = (to: string) =>
        new URL(extractFirstUrl(own.mailer.lastTo(to)!.text)!).searchParams.get('token')!;
      const inv = (email: string, role: string) =>
        own.req('POST', `/api/v1/orgs/${orgId}/invitations`, {
          cookie: owner.cookie,
          body: { email, role },
        });
      for (let i = 0; i < 3; i++) {
        expect((await inv('keep@x.test', 'member')).body.emailSent).toBe(true);
        await tick();
      }
      const emailed = tokenOf('keep@x.test');
      const fourth = await inv('keep@x.test', 'admin');
      expect(fourth.body.status).toBe('renewed');
      expect(fourth.body.emailSent).toBe(false);
      expect(fourth.body.invitation.role).toBe('admin');
      await tick();
      expect(tokenOf('keep@x.test')).toBe(emailed);
      expect(
        (
          await own.req('POST', '/api/v1/invitations/lookup', {
            cookie: member.cookie,
            body: { token: emailed },
          })
        ).body.role,
      ).toBe('admin');
    } finally {
      await own.close();
    }
  });

  it('fails with 503 before writing anything when Redis is unavailable', async () => {
    const dead = await startTestApi();
    try {
      const fx = await orgWithRoles(dead, 'redisdown');
      const first = await dead.req('POST', `/api/v1/orgs/${fx.orgId}/invitations`, {
        cookie: fx.owner.cookie,
        body: { email: 'down@x.test', role: 'member' },
      });
      expect(first.status).toBe(201);
      const before = (
        await dead.pool.query('SELECT * FROM invitation WHERE email = $1', ['down@x.test'])
      ).rows;
      dead.deps.redis.disconnect();
      const r = await dead.req('POST', `/api/v1/orgs/${fx.orgId}/invitations`, {
        cookie: fx.owner.cookie,
        body: { email: 'down@x.test', role: 'admin' },
      });
      expect(r.status).toBe(503);
      const created = await dead.req('POST', `/api/v1/orgs/${fx.orgId}/invitations`, {
        cookie: fx.owner.cookie,
        body: { email: 'down2@x.test', role: 'member' },
      });
      expect(created.status).toBe(503);
      const after = await dead.pool.query('SELECT * FROM invitation WHERE organization_id = $1', [
        fx.orgId,
      ]);
      expect(after.rows).toEqual(before);
    } finally {
      await dead.close();
    }
  });

  it('inviting an existing member creates nothing and sends nothing', async () => {
    const { orgId, owner, member } = await org('exist');
    const before = api.mailer.sent.length;
    const r = await invite(orgId, owner.cookie, member.email.toUpperCase(), 'admin');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'already_member' });
    await tick();
    expect(api.mailer.sent.length).toBe(before);
  });

  it('rejects invalid input', async () => {
    const { orgId, owner } = await org('bad');
    expect((await invite(orgId, owner.cookie, 'not-an-email', 'member')).body.error.code).toBe(
      'invalid_email',
    );
    expect((await invite(orgId, owner.cookie, 'ok@x.test', 'boss')).status).toBe(400);
    const extra = await api.req('POST', `/api/v1/orgs/${orgId}/invitations`, {
      cookie: owner.cookie,
      body: { email: 'ok@x.test', role: 'member', extra: 1 },
    });
    expect(extra.status).toBe(400);
  });
});

describe('accept', () => {
  it('keeps the existing role when the user is already a member', async () => {
    const { orgId, admin } = await org('keep');
    await api.pool.query(
      "INSERT INTO invitation (organization_id, email, role, token_hash, expires_at) VALUES ($1, $2, 'member', $3, now() + interval '1 day')",
      [orgId, admin.email, hashInvitationToken(KNOWN_TOKEN)],
    );
    const r = await accept(admin.cookie, KNOWN_TOKEN);
    expect(r.body.role).toBe('admin');
    const { rows } = await api.pool.query(
      'SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2',
      [orgId, admin.userId],
    );
    expect(rows[0].role).toBe('admin');
  });

  it('requires the matching email without revealing the invited address', async () => {
    const { orgId, member } = await org('mm');
    const { token } = await seed(orgId, 'right@x.test');
    const look = await lookup(member.cookie, token);
    expect(look.body.emailMatches).toBe(false);
    expect(JSON.stringify(look.body)).not.toContain('right@x.test');
    const r = await accept(member.cookie, token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('invitation_email_mismatch');
    expect(JSON.stringify(r.body)).not.toContain('right@x.test');
  });

  it('unverified users cannot accept', async () => {
    const { orgId } = await org('uv');
    const { token } = await seed(orgId, 'uv@x.test');
    await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'uv@x.test', password: PASSWORD, name: 'U' },
    });
    const cookie = await login(api, 'uv@x.test');
    expect((await accept(cookie, token)).body.error.code).toBe('email_not_verified');
  });

  it('expired and revoked invitations cannot be accepted, and malformed tokens look the same', async () => {
    const { orgId, owner } = await org('exp');
    const { token, id } = await seed(orgId, 'e1@x.test');
    const u = await signUpAndVerify(api, 'e1@x.test');
    const cookie = await login(api, u.email);
    await api.pool.query(
      "UPDATE invitation SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const expired = await accept(cookie, token);
    expect(expired.status).toBe(404);
    expect((await lookup(cookie, token)).status).toBe(404);
    expect(
      (await api.req('GET', `/api/v1/orgs/${orgId}/invitations`, { cookie: owner.cookie })).body
        .invitations[0].expired,
    ).toBe(true);
    await api.pool.query(
      "UPDATE invitation SET expires_at = now() + interval '1 day' WHERE id = $1",
      [id],
    );
    const revoke = await api.req('POST', `/api/v1/orgs/${orgId}/invitations/${id}/revoke`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(revoke.status).toBe(200);
    const revoked = await accept(cookie, token);
    expect(revoked.status).toBe(404);
    expect(revoked.body).toEqual(expired.body);
    const again = await api.req('POST', `/api/v1/orgs/${orgId}/invitations/${id}/revoke`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(again.body.error.code).toBe('invitation_not_pending');
    const malformed = await accept(cookie, 'short');
    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual(expired.body);
  });

  it('concurrent accepts create one membership', async () => {
    const { orgId } = await org('dbl');
    const { token } = await seed(orgId, 'dbl@x.test');
    const u = await signUpAndVerify(api, 'dbl@x.test');
    const cookie = await login(api, u.email);
    const rs = await Promise.all([1, 2, 3].map(() => accept(cookie, token)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1 AND action = 'invitation.accepted'",
      [orgId],
    );
    expect(rows[0].n).toBe(1);
    const members = await api.pool.query(
      'SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND user_id = $2',
      [orgId, u.userId],
    );
    expect(members.rows[0].n).toBe(1);
  });

  it('accepting does not deadlock with concurrent invitation changes in the organization', async () => {
    const { orgId, owner } = await org('lock');
    const { token } = await seed(orgId, 'lock-invitee@x.test');
    const u = await signUpAndVerify(api, 'lock-invitee@x.test');
    const cookie = await login(api, u.email);
    const rs = await Promise.all([
      accept(cookie, token),
      invite(orgId, owner.cookie, 'lock-invitee@x.test', 'admin'),
      invite(orgId, owner.cookie, 'lock-invitee@x.test', 'member'),
    ]);
    // Each invite either renews the pending row or finds the user already a member.
    expect(rs[1]!.body.status === 'renewed' || rs[1]!.body.status === 'already_member').toBe(true);
    expect(rs[2]!.body.status === 'renewed' || rs[2]!.body.status === 'already_member').toBe(true);
    expect(rs.map((r) => r.status).every((s) => s === 200 || s === 201 || s === 404)).toBe(true);
    // The accept either won (200) or lost to a rotation of the token (404): never an error.
    expect([200, 404]).toContain(rs[0]!.status);
    const members = await api.pool.query(
      'SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND user_id = $2',
      [orgId, u.userId],
    );
    expect(members.rows[0].n).toBe(rs[0]!.status === 200 ? 1 : 0);
  });
});

describe('permissions and storage', () => {
  it('admins cannot invite owners or revoke owner invites; members cannot invite or list', async () => {
    const { orgId, owner, admin, member } = await org('perm');
    expect((await invite(orgId, admin.cookie, 'o@x.test', 'owner')).body.error.code).toBe(
      'cannot_grant_owner',
    );
    const ownerInv = await invite(orgId, owner.cookie, 'o@x.test', 'owner');
    expect(ownerInv.status).toBe(201);
    const id = ownerInv.body.invitation.id;
    // An admin cannot renew an owner invitation either.
    expect((await invite(orgId, admin.cookie, 'o@x.test', 'member')).body.error.code).toBe(
      'cannot_act_on_owner',
    );
    const revoke = await api.req('POST', `/api/v1/orgs/${orgId}/invitations/${id}/revoke`, {
      cookie: admin.cookie,
      body: {},
    });
    expect(revoke.body.error.code).toBe('cannot_act_on_owner');
    expect((await invite(orgId, member.cookie, 'm@x.test', 'member')).status).toBe(403);
    expect(
      (await api.req('GET', `/api/v1/orgs/${orgId}/invitations`, { cookie: member.cookie })).status,
    ).toBe(403);
  });

  it('revoke is scoped to the organization in the path', async () => {
    const a = await org('scope-a');
    const b = await org('scope-b');
    const inv = await invite(a.orgId, a.owner.cookie, 's@x.test', 'member');
    const r = await api.req(
      'POST',
      `/api/v1/orgs/${b.orgId}/invitations/${inv.body.invitation.id}/revoke`,
      { cookie: b.owner.cookie, body: {} },
    );
    expect(r.status).toBe(404);
  });

  it('stores tokens only as hashes and keeps them out of logs and audit rows', async () => {
    // Own API instance: the shared one's per-IP email budget is spent by earlier tests.
    const own = await startTestApi();
    try {
      const { orgId, owner } = await orgWithRoles(own, 'hash');
      const r = await own.req('POST', `/api/v1/orgs/${orgId}/invitations`, {
        cookie: owner.cookie,
        body: { email: 'h@x.test', role: 'member' },
      });
      expect(r.body.emailSent).toBe(true);
      await tick();
      const token = new URL(extractFirstUrl(own.mailer.lastTo('h@x.test')!.text)!).searchParams.get(
        'token',
      )!;
      const dump = JSON.stringify((await own.pool.query('SELECT * FROM invitation')).rows);
      expect(dump).not.toContain(token);
      const audit = JSON.stringify((await own.pool.query('SELECT * FROM audit_event')).rows);
      expect(audit).not.toContain(token);
      expect(audit).not.toContain('h@x.test');
      expect(own.logLines.join('\n')).not.toContain(token);
    } finally {
      await own.close();
    }
  });
});
