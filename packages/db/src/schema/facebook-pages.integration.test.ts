import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'fba');
  b = await seedTenant(ctx.c, 'fbb');
});
afterAll(() => ctx.close());

// Failed statements inside an open transaction would poison later queries, so each
// query runs on its own (autocommit) and only the SQLSTATE is compared.
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const query = (sql: string, values?: unknown[]) => ctx.c.query(sql, values);

describe('one live facebook connection per page', () => {
  it('refuses a second live connection to the same page from another brand', async () => {
    const page = `9${Date.now()}`;
    await query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1,$2,'facebook',$3)`,
      [a.organizationId, a.brandId, page],
    );
    expect(
      await code(
        query(
          `INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1,$2,'facebook',$3)`,
          [b.organizationId, b.brandId, page],
        ),
      ),
    ).toBe('23505');
  });

  it('allows it once the first is revoked', async () => {
    const page = `8${Date.now()}`;
    await query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
       VALUES ($1,$2,'facebook',$3,'revoked','user_disconnected')`,
      [a.organizationId, a.brandId, page],
    );
    expect(
      await code(
        query(
          `INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1,$2,'facebook',$3)`,
          [b.organizationId, b.brandId, page],
        ),
      ),
    ).toBe('ok');
  });

  it('does not constrain other platforms', async () => {
    for (const t of [a, b])
      await query(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1,$2,'youtube','same-channel')`,
        [t.organizationId, t.brandId],
      );
  });
});

describe('oauth_grant', () => {
  it('caps lifetime at one hour', async () => {
    expect(
      await code(
        query(
          `INSERT INTO oauth_grant (organization_id, brand_id, platform, initiated_by_user_id, encrypted_user_token, expires_at)
           VALUES ($1,$2,'facebook',$3,'\\x00',now() + interval '2 hours')`,
          [a.organizationId, a.brandId, a.userId],
        ),
      ),
    ).toBe('23514');
  });
});

describe('moderation_action', () => {
  async function comment(t: Tenant) {
    const src = await query(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1,$2,$3,'organic_post',$4) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, `p${Math.random()}`],
    );
    const c = await query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1,$2,$3,$4,$5,'x',now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, src.rows[0].id, `c${Math.random()}`],
    );
    return c.rows[0].id as string;
  }
  const insert = (
    t: Tenant,
    commentId: string,
    kind: string,
    extra: Record<string, unknown> = {},
  ) => {
    const status = (extra.status as string | undefined) ?? 'pending';
    return query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, request_key, reply_text, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,'system',$6,$7,$8, CASE WHEN $8 = 'pending' THEN NULL ELSE now() END)`,
      [
        t.organizationId,
        t.brandId,
        t.connectionId,
        commentId,
        kind,
        extra.requestKey ?? `k-${Math.random()}`,
        extra.replyText ?? null,
        status,
      ],
    );
  };

  it('allows at most one pending/applied private reply per comment', async () => {
    const c = await comment(a);
    await insert(a, c, 'private_reply', { replyText: 'hi' });
    expect(await code(insert(a, c, 'private_reply', { replyText: 'hi again' }))).toBe('23505');
    expect(
      await code(insert(a, c, 'private_reply', { replyText: 'x', status: 'not_eligible' })),
    ).toBe('ok');
  });

  it('requires reply text exactly for reply kinds', async () => {
    const c = await comment(a);
    expect(await code(insert(a, c, 'public_reply'))).toBe('23514');
    expect(await code(insert(a, c, 'hide', { replyText: 'no' }))).toBe('23514');
  });

  it('dedupes request keys per organization', async () => {
    const c = await comment(a);
    await insert(a, c, 'hide', { requestKey: 'same' });
    expect(await code(insert(a, c, 'hide', { requestKey: 'same' }))).toBe('23505');
  });

  it("cannot reference another brand's comment", async () => {
    const c = await comment(b);
    expect(await code(insert(a, c, 'hide'))).toBe('23503');
  });
});
