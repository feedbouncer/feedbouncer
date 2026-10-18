import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXECUTE_JOB, INGEST_JOB, type IngestPayload } from '@feedbouncer/comments';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { seedEvalComment } from '@feedbouncer/evaluation/testing';
import { PgJobLedger, deriveIdempotencyKey } from '@feedbouncer/jobs';
import { evalExportCommand } from './eval-export.js';
import { evalReportCommand } from './eval-report.js';
import type { OpsContext } from './ops-context.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'eval-cli-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const ctx = (lines: string[], withPool: boolean): OpsContext => ({
  log: { debug() {}, info() {}, warn() {}, error() {} },
  env: {},
  out: (l) => lines.push(l),
  pool: () => {
    if (!withPool) throw new Error('database must not be used');
    return pool;
  },
  producer: () => {
    throw new Error('producer must not be used');
  },
});

/** A webhook comment with real ingest (and, when hidden, execute) ledger rows. */
async function webhookComment(t: Tenant, n: number, hidden: boolean) {
  const ledger = new PgJobLedger(pool);
  const scope = {
    organizationId: t.organizationId,
    brandId: t.brandId,
    connectionId: t.connectionId,
  };
  const externalId = `ext_cli_${n}`;
  const payload: IngestPayload = {
    sourceExternalId: 'post_1',
    commentExternalId: externalId,
    event: 'created',
    platformEventSec: 1_700_000_000,
    changeId: n.toString(16).padStart(16, '0'),
  };
  const insert = async (type: string, externalRef: string, body: unknown, worker: string) => {
    const r = await ledger.insert({
      scope,
      platform: 'facebook',
      jobType: type,
      idempotencyKey: deriveIdempotencyKey({ scope, platform: 'facebook', type, externalRef }),
      payloadJson: JSON.stringify(body),
      ttlMs: 86_400_000,
      traceContext: null,
    });
    if (r.status !== 'inserted') throw new Error('ledger row not inserted');
    await ledger.claim(r.id, worker, 60_000);
    return r.id;
  };
  const ingestId = await insert(INGEST_JOB.type, INGEST_JOB.externalRef(payload), payload, 'w1');
  const received = (
    await h.c.query<{ created_at: Date }>('SELECT created_at FROM job_ledger WHERE id = $1', [
      ingestId,
    ])
  ).rows[0]!.created_at;
  const postedAt = new Date(Math.floor(received.getTime() / 1000) * 1000 - 2000);
  const s = await seedEvalComment(h.c, t, {
    postedAt,
    externalId,
    state: hidden ? 'hidden' : 'visible',
  });
  await h.c.query(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, sha256(convert_to($5, 'UTF8')), 'ingest', 'v1', 'no_match')`,
    [t.organizationId, t.brandId, t.connectionId, s.id, s.body],
  );
  if (hidden) {
    const actionId = (
      await h.c.query<{ id: string }>(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
           actor_type, request_key, status)
         VALUES ($1, $2, $3, $4, 'hide', 'classifier', $5, 'pending') RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id, `clf:cli:${n}`],
      )
    ).rows[0]!.id;
    const execId = await insert(
      EXECUTE_JOB.type,
      EXECUTE_JOB.externalRef({ actionId }),
      { actionId },
      'w2',
    );
    await h.c.query(
      "UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1",
      [actionId],
    );
    await ledger.complete(execId, 'w2', '{}');
  }
  return s;
}

const csv = (rows: [string, string][], labeller: string) =>
  `item,labeller,verdict\n${rows.map(([i, v]) => `${i},${labeller},${v}`).join('\n')}\n`;

describe('eval-export and eval-report', () => {
  it('exports a tenant, reports from labels and pricing, and reruns byte-identically', async () => {
    const t = await seedTenant(h.c, 'eval-cli');
    await webhookComment(t, 1, true);
    await webhookComment(t, 2, true);
    await webhookComment(t, 3, false);

    const day = 86_400_000;
    const date = (offset: number) => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
    const out = join(await mkdtemp(join(tmpdir(), 'eval-cli-')), 'run');
    const lines: string[] = [];
    expect(
      await evalExportCommand(
        [
          '--org',
          t.organizationId,
          '--from',
          date(-1),
          '--to',
          date(1),
          '--out',
          out,
          '--seed',
          '3',
        ],
        ctx(lines, true),
      ),
    ).toBe(0);
    expect(lines[0]).toBe(out);
    expect(lines[1]).toBe('3 items, 3 in the label sheet');
    expect(lines[2]).toContain('keep it private');

    const items = (await readFile(join(out, 'items.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { item: string; outcome: string });
    const hidden = items.filter((i) => i.outcome === 'hidden').map((i) => i.item);
    const visible = items.filter((i) => i.outcome !== 'hidden').map((i) => i.item);
    expect(hidden).toHaveLength(2);
    expect(visible).toHaveLength(1);

    // One hidden comment should have stayed (a false hide); the visible one should have been hidden.
    const verdicts: [string, string][] = [
      [hidden[0]!, 'should_stay'],
      [hidden[1]!, 'should_hide'],
      [visible[0]!, 'should_hide'],
    ];
    await mkdir(join(out, 'labels'));
    await writeFile(join(out, 'labels', 'a.csv'), csv(verdicts, 'a'));
    await writeFile(join(out, 'labels', 'b.csv'), csv(verdicts, 'b'));
    await writeFile(
      join(out, 'pricing.json'),
      JSON.stringify({
        pricedAt: '2026-10-01',
        currency: 'USD',
        models: {},
        compute: { usdPerMonth: 10, commentsPerMonth: 1000 },
        storage: { usdPerGbMonth: 0.1, retentionMonths: 12 },
        other: [],
      }),
    );

    const readLines: string[] = [];
    expect(await evalReportCommand(['--run', out], ctx(readLines, false))).toBe(0);
    expect(readLines).toEqual([join(out, 'report.md')]);
    const json = await readFile(join(out, 'report.json'));
    const md = await readFile(join(out, 'report.md'));
    const report = JSON.parse(json.toString('utf8')) as {
      automatic: {
        falseHides: { rate: { n: number; k: number } };
        missed: { rate: { n: number; k: number } };
      };
      cost: { status: string };
    };
    expect(report.automatic.falseHides.rate.n).toBe(2);
    expect(report.automatic.falseHides.rate.k).toBe(1);
    expect(report.automatic.missed.rate.n).toBe(2);
    expect(report.automatic.missed.rate.k).toBe(1);
    expect(report.cost.status).toBe('complete');

    await evalReportCommand(['--run', out], ctx([], false));
    expect(await readFile(join(out, 'report.json'))).toEqual(json);
    expect(await readFile(join(out, 'report.md'))).toEqual(md);
  });
});
