import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgHealthReader, loadHealthPolicy, type HealthReader } from '@feedbouncer/observability';
import { betaStatus, runBetaStatus } from './beta-status.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'beta-status-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const only = (t: Tenant): HealthReader => {
  const reader = new PgHealthReader(pool, loadHealthPolicy({}));
  return {
    forBrand: (o, b) => reader.forBrand(o, b),
    all: async (limit) => {
      const { rows, truncated } = await reader.all(limit);
      return { rows: rows.filter((r) => r.connectionId === t.connectionId), truncated };
    },
  };
};

async function seed(label: string, status = 'active'): Promise<Tenant> {
  const t = await seedTenant(h.c, label);
  await h.c.query('UPDATE connection SET status = $2 WHERE id = $1', [t.connectionId, status]);
  return t;
}

async function comment(
  t: Tenant,
  o: { age?: string; origin?: 'live' | 'backfill'; state?: string; evaluated?: boolean } = {},
) {
  const { rows } = await h.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          posted_at, ingested_at, ingest_origin, platform_state)
     VALUES ($1, $2, $3, $4, $5, 'hello', now(), now() - $6::interval, $7, $8) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      randomUUID(),
      o.age ?? '1 hour',
      o.origin ?? 'live',
      o.state ?? 'visible',
    ],
  );
  const id = rows[0]!.id;
  if (o.evaluated)
    await h.c.query(
      `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                    trigger_key, ruleset_version, status)
       VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'v1', 'no_match')`,
      [t.organizationId, t.brandId, t.connectionId, id],
    );
  return id;
}

const statusOf = async (t: Tenant) => (await betaStatus(pool, only(t), new Date())).at(0);

describe('betaStatus', () => {
  it('counts comments and evaluations per connection in the last 24h', async () => {
    const t = await seed('counts');
    await comment(t, { evaluated: true });
    await comment(t);
    await comment(t, { age: '30 hours', evaluated: true });
    await comment(t, { origin: 'backfill', evaluated: true });
    await h.c.query(
      `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                               payload, state, expires_at)
       VALUES ($1, $2, $3, 'facebook', 'poll', repeat('c', 64), '{}'::jsonb, 'queued', now() + interval '1 day')`,
      [t.organizationId, t.brandId, t.connectionId],
    );
    expect(await statusOf(t)).toMatchObject({
      organizationId: t.organizationId,
      connectionId: t.connectionId,
      platform: 'facebook',
      commentsLast24h: 2,
      evaluatedLast24h: 1,
      unevaluated: 1,
      failedImports: 0,
      queuedJobs: 1,
    });
  });

  it('unevaluated excludes backfilled, deleted and <10-minute-old comments', async () => {
    const t = await seed('unevaluated');
    await comment(t, { origin: 'backfill' });
    await comment(t, { state: 'deleted' });
    await comment(t, { age: '5 minutes' });
    await comment(t, { age: '15 days' });
    expect((await statusOf(t))?.unevaluated).toBe(0);
    await comment(t, { age: '11 minutes' });
    expect((await statusOf(t))?.unevaluated).toBe(1);
  });
});

describe('runBetaStatus', () => {
  const run = async (t: Tenant, argv: string[] = []) => {
    const lines: string[] = [];
    const code = await runBetaStatus(argv, { pool, health: only(t), now: () => new Date() }, (l) =>
      lines.push(l),
    );
    return { code, lines };
  };

  it('exit code 2 when a connection needs reconnection', async () => {
    const t = await seed('reconnect', 'reconnect_required');
    expect((await run(t)).code).toBe(2);
  });

  it('exit code 2 when a comment is unevaluated', async () => {
    const t = await seed('gap');
    await comment(t, { age: '1 hour' });
    expect((await run(t)).code).toBe(2);
  });

  it('exit code 0 when all healthy', async () => {
    const t = await seed('healthy');
    await comment(t, { evaluated: true });
    expect((await run(t)).code).toBe(0);
  });

  it('no emails or names in output', async () => {
    const t = await seed('privacy');
    for (const argv of [[], ['--json']]) {
      const out = (await run(t, argv)).lines.join('\n');
      expect(out).toContain(t.connectionId);
      expect(out).not.toMatch(/@|Org privacy|Brand privacy|page-privacy/);
    }
    expect(JSON.parse((await run(t, ['--json'])).lines.join('\n'))[0].connectionId).toBe(
      t.connectionId,
    );
  });
});
