import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'a');
  b = await seedTenant(ctx.c, 'b');
});
afterAll(() => ctx.close());

async function audit(
  c: pg.ClientBase,
  t: Tenant,
  o: Partial<{ org: string; brand: string | null; action: string; details: unknown }> = {},
) {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action, subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, 'rule', $5, $6) RETURNING id`,
      [
        o.org ?? t.organizationId,
        o.brand === undefined ? t.brandId : o.brand,
        t.userId,
        o.action ?? 'rule.updated',
        t.ruleId,
        JSON.stringify(o.details ?? { field: 'enabled', from: true, to: false }),
      ],
    )
  ).rows[0]!.id;
}

describe('audit_event', () => {
  it('is append-only', async () => {
    const id = await audit(ctx.c, a);
    await expectPgError(
      ctx.c.query("UPDATE audit_event SET action = 'rule.deleted' WHERE id = $1", [id]),
      '23001',
    );
    await expectPgError(ctx.c.query('DELETE FROM audit_event WHERE id = $1', [id]), '23001');
    await expectPgError(ctx.c.query('TRUNCATE audit_event'), '23001');
  });

  it('cannot reference a brand from another organization', async () => {
    await expectPgError(
      audit(ctx.c, a, { brand: b.brandId }),
      '23503',
      'audit_event_organization_id_brand_id_fkey',
    );
  });

  it.each(['RuleUpdated', 'rule', 'rule.', "rule.updated'; drop table x; --"])(
    'rejects malformed action %j',
    async (action) => {
      await expectPgError(audit(ctx.c, a, { action }), '23514', 'audit_event_action_check');
    },
  );

  it('rejects non-object and oversized details', async () => {
    await expectPgError(audit(ctx.c, a, { details: [1, 2] }), '23514', 'audit_event_details_check');
    await expectPgError(
      audit(ctx.c, a, { details: { blob: 'x'.repeat(70_000) } }),
      '23514',
      'audit_event_details_check',
    );
  });

  it('survives brand deletion with brand_id NULL and user erasure with actor_user_id NULL', async () => {
    const t = await seedTenant(ctx.c, `aud-${uuid()}`);
    const id = await audit(ctx.c, t);
    await ctx.c.query('DELETE FROM brand WHERE id = $1', [t.brandId]);
    await ctx.c.query('DELETE FROM app_user WHERE id = $1', [t.userId]);
    expect(
      (
        await ctx.c.query(
          'SELECT organization_id, brand_id, actor_user_id FROM audit_event WHERE id = $1',
          [id],
        )
      ).rows[0],
    ).toEqual({ organization_id: t.organizationId, brand_id: null, actor_user_id: null });
  });
});

describe('deleting an organization (tenant offboarding)', () => {
  it('removes every row it owns across all tenant tables and leaves other organizations untouched', async () => {
    const t = await seedTenant(ctx.c, `off-${uuid()}`);
    const cid = (
      await ctx.c.query<{ id: string }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id, body, posted_at)
       VALUES ($1,$2,$3,$4,'c1',$5,'x',now()) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId],
      )
    ).rows[0]!.id;
    await ctx.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1,$2,$3,'hide','enforce','rule',$4,'scam link')`,
      [t.organizationId, t.brandId, cid, t.ruleId],
    );
    await audit(ctx.c, t);
    const tables = [
      'membership',
      'brand',
      'connection',
      'source',
      'author',
      'comment',
      'rule',
      'decision',
      'audit_event',
    ];
    const count = async (org: string) =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (tbl) => [
            tbl,
            (
              await ctx.c.query(
                `SELECT count(*)::int AS n FROM ${tbl} WHERE organization_id = $1`,
                [org],
              )
            ).rows[0].n,
          ]),
        ),
      );
    const otherBefore = await count(a.organizationId);
    await ctx.c.query('DELETE FROM organization WHERE id = $1', [t.organizationId]);
    expect(Object.values(await count(t.organizationId)).every((n) => n === 0)).toBe(true);
    expect(await count(a.organizationId)).toEqual(otherBefore);
  });
});
