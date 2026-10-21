import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  commentFingerprint,
  withPrivacyRedaction,
  withRetentionDelete,
} from '../privacy-guards.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { rollbackLatest } from '../migrations/rollback.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'a');
});
afterAll(() => ctx.close());

async function commentWithDecision(c: pg.ClientBase, t: Tenant) {
  const commentId = (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
    )
  ).rows[0]!.id;
  const decisionId = (
    await c.query<{ id: string }>(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason)
       VALUES ($1,$2,$3,'hide','enforce','user',$4,'Matched rule') RETURNING id`,
      [t.organizationId, t.brandId, commentId, t.userId],
    )
  ).rows[0]!.id;
  return { commentId, decisionId };
}
async function auditEvent(c: pg.ClientBase, t: Tenant): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO audit_event (organization_id, actor_type, action, subject_type, subject_id, details)
       VALUES ($1,'system','rule.updated','rule',$2,'{"k":"v"}') RETURNING id`,
      [t.organizationId, t.ruleId],
    )
  ).rows[0]!.id;
}
async function inTx<T>(c: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    const r = await fn();
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
const asClient = (c: pg.Client) => c as unknown as pg.PoolClient;
const exists = async (c: pg.ClientBase, table: string, id: string) =>
  (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

describe('retention delete hatch', () => {
  it('rejects a direct delete, allows it inside withRetentionDelete', async () => {
    const { decisionId } = await commentWithDecision(ctx.c, a);
    await expectPgError(ctx.c.query('DELETE FROM decision WHERE id = $1', [decisionId]), '23001');
    await inTx(ctx.c, () =>
      withRetentionDelete(asClient(ctx.c), () =>
        ctx.c.query('DELETE FROM decision WHERE id = $1', [decisionId]),
      ),
    );
    expect(await exists(ctx.c, 'decision', decisionId)).toBe(false);
  });

  it('still rejects UPDATE and TRUNCATE inside the hatch', async () => {
    const { decisionId } = await commentWithDecision(ctx.c, a);
    await ctx.c.query('BEGIN');
    await withRetentionDelete(asClient(ctx.c), async () => {
      await ctx.c.query('SAVEPOINT s1');
      await expectPgError(
        ctx.c.query("UPDATE decision SET reason = 'x' WHERE id = $1", [decisionId]),
        '23001',
      );
      await ctx.c.query('ROLLBACK TO s1');
      await expectPgError(ctx.c.query('TRUNCATE decision'), '23001');
    });
    await ctx.c.query('ROLLBACK');
  });

  it('does not leak to the next transaction on the same client', async () => {
    const { decisionId } = await commentWithDecision(ctx.c, a);
    await inTx(ctx.c, () => withRetentionDelete(asClient(ctx.c), async () => undefined));
    await expectPgError(ctx.c.query('DELETE FROM decision WHERE id = $1', [decisionId]), '23001');
    await ctx.c.query('BEGIN');
    await expectPgError(ctx.c.query('DELETE FROM decision WHERE id = $1', [decisionId]), '23001');
    await ctx.c.query('ROLLBACK');
  });

  it('does not open the redaction hatch', async () => {
    const id = await auditEvent(ctx.c, a);
    await ctx.c.query('BEGIN');
    await withRetentionDelete(asClient(ctx.c), async () => {
      await expectPgError(
        ctx.c.query("UPDATE audit_event SET details = '{}' WHERE id = $1", [id]),
        '23001',
      );
    });
    await ctx.c.query('ROLLBACK');
  });
});

describe('privacy redaction hatch', () => {
  it('allows rewriting audit details only', async () => {
    const id = await auditEvent(ctx.c, a);
    await inTx(ctx.c, () =>
      withPrivacyRedaction(asClient(ctx.c), () =>
        ctx.c.query("UPDATE audit_event SET details = '{}' WHERE id = $1", [id]),
      ),
    );
    expect(
      (await ctx.c.query('SELECT details FROM audit_event WHERE id = $1', [id])).rows[0].details,
    ).toEqual({});
  });

  it('rejects changing any other audit column, deleting, and touching other tables', async () => {
    const id = await auditEvent(ctx.c, a);
    const { decisionId } = await commentWithDecision(ctx.c, a);
    await ctx.c.query('BEGIN');
    await withPrivacyRedaction(asClient(ctx.c), async () => {
      for (const [sql, params] of [
        ["UPDATE audit_event SET action = 'x.y' WHERE id = $1", [id]],
        ["UPDATE audit_event SET details = '{}', action = 'x.y' WHERE id = $1", [id]],
        ['DELETE FROM audit_event WHERE id = $1', [id]],
        ["UPDATE decision SET reason = 'x' WHERE id = $1", [decisionId]],
        ['DELETE FROM decision WHERE id = $1', [decisionId]],
      ] as const) {
        await ctx.c.query('SAVEPOINT s');
        await expectPgError(ctx.c.query(sql, [...params]), '23001');
        await ctx.c.query('ROLLBACK TO s');
      }
      await expectPgError(ctx.c.query('TRUNCATE audit_event'), '23001');
    });
    await ctx.c.query('ROLLBACK');
  });

  it('does not leak after commit', async () => {
    const id = await auditEvent(ctx.c, a);
    await inTx(ctx.c, () => withPrivacyRedaction(asClient(ctx.c), async () => undefined));
    await expectPgError(
      ctx.c.query("UPDATE audit_event SET details = '{}' WHERE id = $1", [id]),
      '23001',
    );
  });
});

describe('guard helpers', () => {
  it('require a transaction', async () => {
    for (const helper of [withRetentionDelete, withPrivacyRedaction]) {
      let ran = false;
      await expect(
        helper(asClient(ctx.c), async () => {
          ran = true;
        }),
      ).rejects.toThrow('privacy guard requires a transaction');
      expect(ran).toBe(false);
    }
  });

  it('require a transaction even when the session already has the setting on', async () => {
    await ctx.c.query("SET fb.retention_delete = 'on'");
    try {
      await expect(withRetentionDelete(asClient(ctx.c), async () => undefined)).rejects.toThrow(
        'privacy guard requires a transaction',
      );
    } finally {
      await ctx.c.query('RESET fb.retention_delete');
    }
  });

  it('return the callback result', async () => {
    const r = await inTx(ctx.c, () => withRetentionDelete(asClient(ctx.c), async () => 42));
    expect(r).toBe(42);
  });

  it('commentFingerprint is sha256 of connection id, NUL, external id', () => {
    const fp = commentFingerprint('c', 'x');
    expect(fp).toHaveLength(32);
    expect(fp.equals(createHash('sha256').update('c\0x', 'utf8').digest())).toBe(true);
    expect(commentFingerprint('c', 'y').equals(fp)).toBe(false);
  });
});

describe('privacy_request', () => {
  const insert = (o: Record<string, unknown> = {}) => {
    const v = {
      kind: 'erasure',
      mode: 'execute',
      status: 'queued',
      reference: null,
      sealed: Buffer.from('sealed'),
      count: 1,
      ...o,
    };
    return ctx.c.query(
      `INSERT INTO privacy_request (organization_id, kind, mode, status, requested_via, actor_user_id,
                                    reference, subjects_sealed, subject_count)
       VALUES ($1,$2,$3,$4,'api',$5,$6,$7,$8)`,
      [a.organizationId, v.kind, v.mode, v.status, a.userId, v.reference, v.sealed, v.count],
    );
  };

  it('accepts a valid queued request and a finished one with wiped identifiers', async () => {
    await insert({ reference: 'TICKET-1:a/b.c_d' });
    await insert({ status: 'done', sealed: null });
    await insert({ status: 'failed', sealed: null });
  });
  it('rejects a finished request that still holds sealed identifiers', async () => {
    await expectPgError(insert({ status: 'done' }), '23514');
    await expectPgError(insert({ status: 'failed' }), '23514');
  });
  it('rejects an unfinished request without sealed identifiers', async () => {
    await expectPgError(insert({ sealed: null }), '23514');
  });
  it('rejects a dry-run export', async () => {
    await expectPgError(insert({ kind: 'export', mode: 'dry_run' }), '23514');
    await insert({ kind: 'export', mode: 'execute' });
  });
  it('rejects a malformed reference and out-of-range subject counts', async () => {
    await expectPgError(insert({ reference: 'a b' }), '23514');
    await expectPgError(insert({ reference: '' }), '23514');
    await expectPgError(insert({ reference: 'x'.repeat(65) }), '23514');
    await expectPgError(insert({ count: 0 }), '23514');
    await expectPgError(insert({ count: 21 }), '23514');
  });
  it('is removed with its organization', async () => {
    const t = await seedTenant(ctx.c, 'gone');
    await ctx.c.query(
      `INSERT INTO privacy_request (organization_id, kind, mode, requested_via, subjects_sealed, subject_count)
       VALUES ($1,'export','execute','cli','\\x00',1)`,
      [t.organizationId],
    );
    await ctx.c.query('DELETE FROM organization WHERE id = $1', [t.organizationId]);
    expect(
      (
        await ctx.c.query('SELECT 1 FROM privacy_request WHERE organization_id = $1', [
          t.organizationId,
        ])
      ).rowCount,
    ).toBe(0);
  });
});

describe('erased_comment', () => {
  it('stores 32-byte fingerprints only, once per connection', async () => {
    const fp = commentFingerprint(a.connectionId, 'ext-1');
    await ctx.c.query('INSERT INTO erased_comment (connection_id, fingerprint) VALUES ($1,$2)', [
      a.connectionId,
      fp,
    ]);
    await expectPgError(
      ctx.c.query('INSERT INTO erased_comment (connection_id, fingerprint) VALUES ($1,$2)', [
        a.connectionId,
        fp,
      ]),
      '23505',
    );
    await expectPgError(
      ctx.c.query('INSERT INTO erased_comment (connection_id, fingerprint) VALUES ($1,$2)', [
        a.connectionId,
        fp.subarray(0, 31),
      ]),
      '23514',
    );
  });
});

describe('retention tables', () => {
  it('retention_status holds exactly one seeded row', async () => {
    const rows = (await ctx.c.query('SELECT id, warnings FROM retention_status')).rows;
    expect(rows).toEqual([{ id: 1, warnings: [] }]);
    await expectPgError(
      ctx.c.query(
        "INSERT INTO retention_status (id, settings, effective, warnings) VALUES (2,'{}','{}','{}')",
      ),
      '23514',
    );
  });
  it('retention_confirmation validates category and days', async () => {
    const ins = (cat: string, days: number) =>
      ctx.c.query(
        "INSERT INTO retention_confirmation (category, days, eligible_count, confirmed_by) VALUES ($1,$2,5,'ops@example.test')",
        [cat, days],
      );
    await ins('comments', 30);
    await expectPgError(ins('comments', 30), '23505');
    await expectPgError(ins('nonsense', 30), '23514');
    await expectPgError(ins('audit', 0), '23514');
    await expectPgError(ins('audit', 36501), '23514');
  });
  it('retention_run validates status', async () => {
    await ctx.c.query("INSERT INTO retention_run (status) VALUES ('running')");
    await expectPgError(
      ctx.c.query("INSERT INTO retention_run (status) VALUES ('bogus')"),
      '23514',
    );
  });
  it('comment has a nullable parent_removed_at', async () => {
    const { commentId } = await commentWithDecision(ctx.c, a);
    const r = await ctx.c.query('SELECT parent_removed_at FROM comment WHERE id = $1', [commentId]);
    expect(r.rows[0].parent_removed_at).toBeNull();
  });
});

describe('migration round trip', () => {
  const TABLES = [
    'organization',
    'brand',
    'connection',
    'source',
    'author',
    'comment',
    'decision',
    'audit_event',
    'rule',
  ];
  const counts = async (c: pg.ClientBase) => {
    const out: Record<string, number> = {};
    for (const t of TABLES)
      out[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    return out;
  };

  it('rolls back and re-applies without touching existing rows', async () => {
    const { db, c, close } = await migratedDb();
    try {
      const t = await seedTenant(c, 'rt');
      await commentWithDecision(c, t);
      await auditEvent(c, t);
      const before = await counts(c);
      expect(before.decision).toBe(1);

      expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
        status: 'rolled_back',
        migration: '20261021000200_privacy_request_heartbeat',
      });
      expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
        status: 'rolled_back',
        migration: '20261021000100_privacy_retention',
      });
      expect(await counts(c)).toEqual(before);
      expect((await c.query("SELECT to_regclass('privacy_request') AS t")).rows[0].t).toBeNull();
      // original guard is back: no hatch
      await c.query('BEGIN');
      await c.query("SELECT set_config('fb.retention_delete', 'on', true)");
      await expectPgError(c.query('DELETE FROM decision'), '23001');
      await c.query('ROLLBACK');

      const again = await runPrisma(['migrate', 'deploy'], db.url);
      expect(again.code, again.stderr).toBe(0);
      expect(await counts(c)).toEqual(before);
      expect((await c.query('SELECT count(*)::int AS n FROM retention_status')).rows[0].n).toBe(1);
    } finally {
      await close();
    }
  });
});
