import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
  a = await seedTenant(c, 'a');
  b = await seedTenant(c, 'b');
});
afterAll(() => ctx.close());

const sha = (n = 32) => Buffer.alloc(n, 7);

async function comment(t: Tenant): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
    )
  ).rows[0]!.id;
}

async function rule(t: Tenant, conditions: unknown): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
       VALUES ($1,$2,'r',$3::jsonb,'hide') RETURNING id`,
      [t.organizationId, t.brandId, JSON.stringify(conditions)],
    )
  ).rows[0]!.id;
}

async function evaluation(
  t: Tenant,
  commentId: string,
  o: { org?: string; brand?: string; sha?: Buffer; trigger?: string; run?: string } = {},
): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                    trigger_key, ruleset_version, status, rule_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,'v1','no_match',$7) RETURNING id`,
      [
        o.org ?? t.organizationId,
        o.brand ?? t.brandId,
        t.connectionId,
        commentId,
        o.sha ?? sha(),
        o.trigger ?? 'ingest',
        o.run ?? null,
      ],
    )
  ).rows[0]!.id;
}

async function decide(
  t: Tenant,
  commentId: string,
  evaluationId: string | null,
  brand = t.brandId,
): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                             reason, rule_evaluation_id)
       VALUES ($1,$2,$3,'hide','enforce','rule',$4,'matched',$5) RETURNING id`,
      [t.organizationId, brand, commentId, t.ruleId, evaluationId],
    )
  ).rows[0]!.id;
}

describe('rule.kind and rule.archived_at', () => {
  it('derives kind from conditions.type, NULL for legacy conditions', async () => {
    const id = await rule(a, { type: 'keyword', terms: ['x'] });
    const legacy = await rule(a, { links: ['bit.ly'] });
    const kinds = await c.query<{ id: string; kind: string | null }>(
      'SELECT id, kind FROM rule WHERE id = ANY($1)',
      [[id, legacy]],
    );
    const by = new Map(kinds.rows.map((r) => [r.id, r.kind]));
    expect(by.get(id)).toBe('keyword');
    expect(by.get(legacy)).toBeNull();
    const seeded = await c.query('SELECT kind FROM rule WHERE id = $1', [a.ruleId]);
    expect(seeded.rows[0].kind).toBe('link_domain');
  });

  it('refuses writing kind directly', async () => {
    await expectPgError(
      c.query('UPDATE rule SET kind = $1 WHERE id = $2', ['regex', a.ruleId]),
      '428C9',
    );
  });

  it('rejects unknown kinds', async () => {
    await expectPgError(rule(a, { type: 'sentiment' }), '23514', 'rule_kind_check');
  });

  it('has a nullable archived_at', async () => {
    const r = await c.query('SELECT archived_at FROM rule WHERE id = $1', [a.ruleId]);
    expect(r.rows[0].archived_at).toBeNull();
  });
});

describe('brand_domain', () => {
  const ins = (t: Tenant, domain: string) =>
    c.query('INSERT INTO brand_domain (organization_id, brand_id, domain) VALUES ($1,$2,$3)', [
      t.organizationId,
      t.brandId,
      domain,
    ]);

  it('enforces the domain shape', async () => {
    await expectPgError(ins(a, 'Example.com'), '23514', 'brand_domain_domain_check');
    await expectPgError(ins(a, 'exa mple.com'), '23514', 'brand_domain_domain_check');
    await ins(a, 'xn--espaol-zwa.com');
  });

  it('is unique per brand', async () => {
    await ins(a, 'dup.example.com');
    await expectPgError(ins(a, 'dup.example.com'), '23505', 'brand_domain_brand_id_domain_key');
    await ins(b, 'dup.example.com');
  });

  it('cannot cross tenants', async () => {
    await expectPgError(
      c.query('INSERT INTO brand_domain (organization_id, brand_id, domain) VALUES ($1,$2,$3)', [
        b.organizationId,
        a.brandId,
        'cross.example.com',
      ]),
      '23503',
    );
  });
});

describe('rule_evaluation', () => {
  it('is unique per (comment, body hash, trigger)', async () => {
    const cm = await comment(a);
    await evaluation(a, cm);
    await expectPgError(
      evaluation(a, cm),
      '23505',
      'rule_evaluation_comment_id_body_sha256_trigger_key_key',
    );
    await evaluation(a, cm, { trigger: uuid() });
    await evaluation(a, cm, { sha: Buffer.alloc(32, 9) });
  });

  it('requires a 32 byte hash', async () => {
    const cm = await comment(a);
    await expectPgError(
      evaluation(a, cm, { sha: sha(31) }),
      '23514',
      'rule_evaluation_body_sha256_check',
    );
  });

  it('rejects a comment of another tenant', async () => {
    const foreign = await comment(b);
    await expectPgError(evaluation(a, foreign), '23503');
  });

  it('keeps status, skip reason and outcome consistent', async () => {
    const cm = await comment(a);
    await expectPgError(
      c.query(
        `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                      trigger_key, ruleset_version, status, skip_reason)
         VALUES ($1,$2,$3,$4,$5,'t','v1','no_match','own_account')`,
        [a.organizationId, a.brandId, a.connectionId, cm, sha()],
      ),
      '23514',
      'rule_evaluation_skip_reason_check',
    );
  });
});

describe('decision.rule_evaluation_id', () => {
  it('links a decision to an evaluation of the same brand', async () => {
    const cm = await comment(a);
    const ev = await evaluation(a, cm);
    const d = await decide(a, cm, ev);
    const r = await c.query('SELECT rule_evaluation_id FROM decision WHERE id = $1', [d]);
    expect(r.rows[0].rule_evaluation_id).toBe(ev);
  });

  it('rejects an evaluation of another brand', async () => {
    const cmA = await comment(a);
    const cmB = await comment(b);
    const evB = await evaluation(b, cmB);
    await expectPgError(decide(a, cmA, evB), '23503');
  });

  it('cascades from comment to evaluations and their decisions', async () => {
    const cm = await comment(a);
    const ev = await evaluation(a, cm);
    const d = await decide(a, cm, ev);
    await c.query('DELETE FROM comment WHERE id = $1', [cm]);
    expect((await c.query('SELECT 1 FROM rule_evaluation WHERE id = $1', [ev])).rowCount).toBe(0);
    expect((await c.query('SELECT 1 FROM decision WHERE id = $1', [d])).rowCount).toBe(0);
  });

  it('stays append-only for direct deletes', async () => {
    const cm = await comment(a);
    const ev = await evaluation(a, cm);
    const d = await decide(a, cm, ev);
    await expect(c.query('DELETE FROM decision WHERE id = $1', [d])).rejects.toThrow();
  });
});

describe('rule_evaluation is an immutable record', () => {
  const fresh = async () => evaluation(a, await comment(a));

  it('refuses direct DELETE and TRUNCATE', async () => {
    const ev = await fresh();
    await expectPgError(c.query('DELETE FROM rule_evaluation WHERE id = $1', [ev]), '23001');
    await expectPgError(c.query('TRUNCATE rule_evaluation CASCADE'), '23001');
  });

  it.each([
    ['status', "status = 'skipped'"],
    ['outcome', "outcome = 'hide'"],
    ['trace', "trace = '[{}]'::jsonb"],
    ['body_sha256', "body_sha256 = '\\x' || repeat('aa', 32)::text::bytea"],
    ['trigger_key', "trigger_key = 'other'"],
    ['ruleset_version', "ruleset_version = 'v2'"],
    ['created_at', "created_at = now() - interval '1 day'"],
    ['comment_id', 'comment_id = gen_random_uuid()'],
    ['rule_run_id', 'rule_run_id = gen_random_uuid()'],
  ])('refuses direct UPDATE of %s', async (_n, set) => {
    const ev = await fresh();
    await expectPgError(c.query(`UPDATE rule_evaluation SET ${set} WHERE id = $1`, [ev]), '23001');
  });

  it('allows the fallback lifecycle columns', async () => {
    const ev = await fresh();
    await c.query(
      "UPDATE rule_evaluation SET fallback_at = now(), fallback_code = 'unsupported' WHERE id = $1",
      [ev],
    );
    await c.query('UPDATE rule_evaluation SET recovered_at = now() WHERE id = $1', [ev]);
  });
});

describe('decisions keep naming the rule', () => {
  it('survives rule rename and archival', async () => {
    const cm = await comment(a);
    const ev = await evaluation(a, cm);
    const d = await decide(a, cm, ev);
    await c.query("UPDATE rule SET name = 'renamed', archived_at = now() WHERE id = $1", [
      a.ruleId,
    ]);
    const r = await c.query('SELECT rule_id, reason FROM decision WHERE id = $1', [d]);
    expect(r.rows[0]).toEqual({ rule_id: a.ruleId, reason: 'matched' });
    await c.query('UPDATE rule SET archived_at = NULL WHERE id = $1', [a.ruleId]);
  });
});

describe('rule_run', () => {
  const ins = (status: string, enqueued = 0) =>
    c.query(
      `INSERT INTO rule_run (organization_id, brand_id, connection_id, since, max_comments, status, enqueued_count)
       VALUES ($1,$2,$3, now(), 100, $4, $5)`,
      [a.organizationId, a.brandId, a.connectionId, status, enqueued],
    );

  it('checks status and counts', async () => {
    await ins('queued');
    await expectPgError(ins('bogus'), '23514', 'rule_run_status_check');
    await expectPgError(ins('queued', -1), '23514', 'rule_run_enqueued_count_check');
  });

  it('nulls the run on evaluations when deleted', async () => {
    const run = (
      await c.query<{ id: string }>(
        `INSERT INTO rule_run (organization_id, brand_id, connection_id, since, max_comments)
         VALUES ($1,$2,$3, now(), 10) RETURNING id`,
        [a.organizationId, a.brandId, a.connectionId],
      )
    ).rows[0]!.id;
    const cm = await comment(a);
    const ev = await evaluation(a, cm, { trigger: run, run });
    await c.query('DELETE FROM rule_run WHERE id = $1', [run]);
    const r = await c.query('SELECT rule_run_id, brand_id FROM rule_evaluation WHERE id = $1', [
      ev,
    ]);
    expect(r.rows[0].rule_run_id).toBeNull();
    expect(r.rows[0].brand_id).toBe(a.brandId);
  });
});
