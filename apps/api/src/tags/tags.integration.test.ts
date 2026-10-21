import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { upsertStored } from '@feedbouncer/comments/testing';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let org: OrgFixture;

const tags = (o: OrgFixture) => `/api/v1/orgs/${o.orgId}/tags`;
const create = (name: unknown, cookie = org.owner.cookie, o = org) =>
  api.req('POST', tags(o), { cookie, body: { name } });
const remove = (tagId: string, confirmCount: number, cookie = org.admin.cookie) =>
  api.req('DELETE', `${tags(org)}/${tagId}`, { cookie, body: { confirmCount } });

beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK });
  org = await orgWithRoles(api, 'tags');
});
afterAll(() => api.close());

describe('tags', () => {
  it('create, duplicate by case → 409 with existing, invalid names → 400 per error, limit → 409', async () => {
    const created = await create('  Café  ');
    expect(created.status).toBe(201);
    expect(created.body.tag).toMatchObject({ name: 'Café', commentCount: 0 });
    expect(typeof created.body.tag.createdAt).toBe('string');
    for (const dup of ['CAFÉ', 'café']) {
      const r = await create(dup);
      expect(r.status, dup).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'tag_name_taken',
        tag: { id: created.body.tag.id, name: 'Café' },
      });
    }
    for (const name of ['🔥', 'مهم']) {
      const r = await create(name);
      expect(r.status).toBe(201);
      expect(r.body.tag.name).toBe(name);
    }
    for (const [name, reason] of [
      ['   ', 'empty'],
      ['x'.repeat(51), 'too_long'],
      ['bad\u0007name', 'control_chars'],
    ] as const) {
      const r = await create(name);
      expect(r.status, reason).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'invalid_tag_name', reason });
    }
    expect((await create('x'.repeat(401))).status).toBe(400);
    expect((await create(5)).status).toBe(400);
    expect(
      (await api.req('POST', tags(org), { cookie: org.owner.cookie, body: { name: 'a', id: 'b' } }))
        .status,
    ).toBe(400);

    const listed = await api.req('GET', tags(org), { cookie: org.member.cookie });
    expect(listed.status).toBe(200);
    expect(listed.body.canManage).toBe(false);
    const listedByAdmin = await api.req('GET', tags(org), { cookie: org.admin.cookie });
    expect(listedByAdmin.body.canManage).toBe(true);
    expect(listed.body.tags.map((t: { name: string }) => t.name).sort()).toEqual(
      ['Café', '🔥', 'مهم'].sort(),
    );

    const full = await orgWithRoles(api, 'tagsFull', {
      owner: org.owner,
      admin: org.admin,
      member: org.member,
    });
    await api.pool.query(
      `INSERT INTO tag (organization_id, name, name_key)
       SELECT $1, 'tag ' || n, 'tag ' || n FROM generate_series(1, 200) n`,
      [full.orgId],
    );
    const over = await create('one more', full.owner.cookie, full);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('tag_limit_reached');
    const existing = await create('TAG 7', full.owner.cookie, full);
    expect(existing.status).toBe(409);
    expect(existing.body.error.code).toBe('tag_name_taken');
  });

  it('member can create but cannot delete (403); admin delete with stale count → 409 {count}, with right count → 200 and tag gone from rows', async () => {
    const made = await create('Member made', org.member.cookie);
    expect(made.status).toBe(201);
    const tagId = made.body.tag.id as string;
    // A comment carrying the tag.
    const { scope } = await api.seedFacebookConnection(org);
    const stored = await upsertStored(
      api.deps.comments!.store,
      scope,
      {
        externalId: '1_2_3',
        sourceExternalId: '1_2',
        parentExternalId: null,
        author: { externalId: 'a1', displayName: 'Fan', profileUrl: null },
        body: 'hello',
        postedAt: new Date(),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: 'own', syncedAt: new Date() },
    );
    const t = await api.req('POST', `/api/v1/orgs/${org.orgId}/comments/triage`, {
      cookie: org.member.cookie,
      body: { commentIds: [stored.commentId], op: { type: 'add_tags', tagIds: [tagId] } },
    });
    expect(t.body.results[0].status).toBe('ok');

    const denied = await remove(tagId, 1, org.member.cookie);
    expect(denied.status).toBe(403);
    const stale = await remove(tagId, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'tag_count_changed', count: 1 });
    const ok = await remove(tagId, 1);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ removedFrom: 1 });
    expect((await remove(tagId, 0)).status).toBe(404);
    expect((await remove('not-a-uuid', 0)).status).toBe(404);
    expect(
      (await api.req('DELETE', `${tags(org)}/${tagId}`, { cookie: org.admin.cookie, body: {} }))
        .status,
    ).toBe(400);
    const rows = await api.req('GET', `/api/v1/orgs/${org.orgId}/comments?queue=all`, {
      cookie: org.owner.cookie,
    });
    const row = rows.body.items.find((i: { id: string }) => i.id === stored.commentId);
    expect(row.tags).toEqual([]);
    const remaining = await api.req('GET', tags(org), { cookie: org.owner.cookie });
    expect(remaining.body.tags.map((x: { id: string }) => x.id)).not.toContain(tagId);
  });

  it('logs carry no tag names', () => {
    const logs = api.logLines.join('\n');
    expect(logs).toContain('tags.create');
    expect(logs).not.toContain('Member made');
    expect(logs).not.toContain('Café');
  });
});
