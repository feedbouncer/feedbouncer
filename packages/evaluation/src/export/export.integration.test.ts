import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { EXECUTE_JOB, INGEST_JOB, type IngestPayload } from '@feedbouncer/comments';
import { PgJobLedger, UsageError, deriveIdempotencyKey } from '@feedbouncer/jobs';
import { readRun } from '../io.js';
import { RunManifest } from '../schema.js';
import { seedEvalComment, seedHiddenTimeline } from '../testing.js';
import { pseudonymiser } from './derive.js';
import { exportRun, exportRunWithSalt, type ExportOptions } from './export.js';

let env: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;

const FROM = new Date('2026-10-01T00:00:00Z');
const TO = new Date('2026-10-08T00:00:00Z');
const NOW = new Date('2026-10-18T00:00:00Z');
const day = (n: number) => new Date(FROM.getTime() + n * 86_400_000);

beforeAll(async () => {
  env = await migratedDb();
  pool = new pg.Pool({ connectionString: env.db.url.href, max: 4 });
  a = await seedTenant(env.c, 'a');
  b = await seedTenant(env.c, 'b');
});

afterAll(async () => {
  await pool?.end();
  await env?.close();
});

const outDir = async () => join(await mkdtemp(join(tmpdir(), 'eval-export-')), 'run');

const opts = async (o: Partial<ExportOptions>): Promise<ExportOptions> => ({
  organizationIds: [a.organizationId],
  brandIds: [],
  from: FROM,
  to: TO,
  labelSample: null,
  seed: 7,
  out: await outDir(),
  now: NOW,
  jobRetentionDays: 30,
  ...o,
});

const lines = async (dir: string) =>
  (await readFile(join(dir, 'items.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');

describe('exportRun', () => {
  it('exports only the requested organization', async () => {
    // Fresh tenants so other tests' rows don't change the counts.
    const ta = await seedTenant(env.c, 'iso-a');
    const tb = await seedTenant(env.c, 'iso-b');
    const aRows = [
      await seedHiddenTimeline(env.c, ta, { postedAt: day(1) }),
      await seedHiddenTimeline(env.c, ta, { postedAt: day(2) }),
      await seedHiddenTimeline(env.c, ta, { postedAt: day(3), hidden: false }),
    ];
    const bRows = [
      await seedHiddenTimeline(env.c, tb, { postedAt: day(1) }),
      await seedHiddenTimeline(env.c, tb, { postedAt: day(2) }),
      await seedHiddenTimeline(env.c, tb, { postedAt: day(3) }),
      await seedHiddenTimeline(env.c, tb, { postedAt: day(4), hidden: false }),
    ];
    // B ledger rows carrying A's idempotency keys: only the org predicate keeps them out.
    const polled = aRows[0]!;
    const keyFor = (type: string, externalRef: string) =>
      deriveIdempotencyKey({
        scope: { organizationId: ta.organizationId, brandId: ta.brandId, connectionId: ta.connectionId },
        platform: 'facebook',
        type,
        externalRef,
      });
    for (const [type, key] of [
      [INGEST_JOB.type, keyFor(INGEST_JOB.type, `${polled.externalId}:created`)],
      [EXECUTE_JOB.type, keyFor(EXECUTE_JOB.type, `action:${polled.actionId!}`)],
    ] as const) {
      await env.c.query(
        `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
           payload, expires_at, created_at, first_claimed_at, last_claimed_at)
         VALUES ($1, $2, $3, 'facebook', $4, $5, '{}', now() + interval '1 day', $6, $6, $6)`,
        [tb.organizationId, tb.brandId, tb.connectionId, type, key, day(1)],
      );
    }
    const salt = Buffer.alloc(32, 9);
    const o = await opts({ organizationIds: [ta.organizationId] });
    const manifest = await exportRunWithSalt(pool, o, salt);
    const pseudo = pseudonymiser(salt);

    const items = (await lines(o.out)).map(
      (l) =>
        JSON.parse(l) as {
          item: string;
          outcome: string;
          channel: string;
          timing: { breakdown: unknown } | null;
        },
    );
    expect(items).toHaveLength(3);
    expect(manifest.itemCount).toBe(3);
    expect(items.map((i) => i.item).sort()).toEqual(aRows.map((r) => pseudo(r.id)).sort());
    expect(items.filter((i) => i.outcome === 'hidden')).toHaveLength(2);
    const polledItem = items.find((i) => i.item === pseudo(polled.id))!;
    expect(polledItem.channel).toBe('poll');
    expect(polledItem.timing?.breakdown).toBeNull();
    const all = await readFile(join(o.out, 'items.jsonl'), 'utf8');
    const sheet = await readFile(join(o.out, 'label-sheet.csv'), 'utf8');
    for (const r of bRows) {
      expect(all).not.toContain(pseudo(r.id));
      expect(sheet).not.toContain(pseudo(r.id));
      expect(sheet).not.toContain(r.body);
    }

    // And the other way round, with both orgs, B's items appear.
    const both = await opts({ organizationIds: [ta.organizationId, tb.organizationId] });
    await exportRunWithSalt(pool, both, salt);
    expect(await lines(both.out)).toHaveLength(7);
  });

  it('narrows to brands and rejects a brand from another org', async () => {
    const o = await opts({ organizationIds: [a.organizationId], brandIds: [b.brandId] });
    await expect(exportRun(pool, o)).rejects.toThrow(UsageError);
    await expect(exportRun(pool, o)).rejects.toThrow('brand not in organization');
    await expect(stat(o.out)).rejects.toMatchObject({ code: 'ENOENT' });

    const t = await seedTenant(env.c, 'brand');
    await seedHiddenTimeline(env.c, t, { postedAt: day(1) });
    const otherBrand = (
      await env.c.query<{ id: string }>(
        "INSERT INTO brand (organization_id, name) VALUES ($1, 'Second') RETURNING id",
        [t.organizationId],
      )
    ).rows[0]!.id;
    const scoped = await opts({ organizationIds: [t.organizationId], brandIds: [otherBrand] });
    const m = await exportRun(pool, scoped);
    expect(m.itemCount).toBe(0);
    expect(m.brandsScoped).toBe(true);
    const unscoped = await opts({ organizationIds: [t.organizationId], brandIds: [t.brandId] });
    expect((await exportRun(pool, unscoped)).itemCount).toBe(1);
  });

  it('refuses an existing output directory', async () => {
    const o = await opts({});
    await exportRun(pool, o);
    await expect(exportRun(pool, o)).rejects.toThrow(UsageError);
  });

  it('window is [from, to)', async () => {
    const t = await seedTenant(env.c, 'window');
    const inside = [
      await seedEvalComment(env.c, t, { postedAt: FROM }),
      await seedEvalComment(env.c, t, { postedAt: new Date(TO.getTime() - 1) }),
    ];
    await seedEvalComment(env.c, t, { postedAt: TO });
    await seedEvalComment(env.c, t, { postedAt: new Date(FROM.getTime() - 1) });
    await seedEvalComment(env.c, t, { postedAt: day(2), own: true });
    const salt = Buffer.alloc(32, 3);
    const o = await opts({ organizationIds: [t.organizationId] });
    await exportRunWithSalt(pool, o, salt);
    const ids = (await lines(o.out)).map((l) => (JSON.parse(l) as { item: string }).item);
    const pseudo = pseudonymiser(salt);
    expect(ids.sort()).toEqual(inside.map((s) => pseudo(s.id)).sort());
  });

  it('pages through more than one page of comments', async () => {
    const t = await seedTenant(env.c, 'paging');
    await env.c.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
         platform_state, is_own_account, ingest_origin, posted_at)
       SELECT $1, $2, $3, $4, 'pg_' || g, 'body ' || g, 'visible', false, 'live',
              $5::timestamptz + (g % 7) * interval '1 second'
         FROM generate_series(1, 2100) g`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, day(1)],
    );
    const o = await opts({ organizationIds: [t.organizationId], labelSample: 10 });
    const m = await exportRun(pool, o);
    expect(m.itemCount).toBe(2100);
    expect(new Set(await lines(o.out)).size).toBe(2100);
    expect(m.labelSheetCount).toBe(10);
    expect(m.sample).toEqual({ size: 10, seed: 7 });
  });

  it('items.jsonl contains no comment ids, external ids, bodies or author ids', async () => {
    const t = await seedTenant(env.c, 'leak');
    const s = await seedHiddenTimeline(env.c, t, {
      postedAt: day(1),
      body: '=HYPERLINK("x") call 555-0100',
    });
    const o = await opts({ organizationIds: [t.organizationId] });
    const manifest = await exportRun(pool, o);
    expect(RunManifest.parse(manifest)).toEqual(manifest);
    expect((await readdir(o.out)).sort()).toEqual(['items.jsonl', 'label-sheet.csv', 'manifest.json']);
    const files = {
      items: await readFile(join(o.out, 'items.jsonl'), 'utf8'),
      manifest: await readFile(join(o.out, 'manifest.json'), 'utf8'),
      sheet: await readFile(join(o.out, 'label-sheet.csv'), 'utf8'),
    };
    const secrets = [
      s.id,
      s.externalId,
      t.authorId,
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      s.actionId!,
    ];
    for (const v of [...secrets, s.body, '555-0100']) {
      expect(files.items).not.toContain(v);
      expect(files.manifest).not.toContain(v);
    }
    for (const v of secrets) expect(files.sheet).not.toContain(v);
    // The label sheet carries the text, formula-escaped.
    expect(files.sheet).toContain(`"'=HYPERLINK(""x"") call 555-0100"`);
    for (const f of ['items.jsonl', 'label-sheet.csv', 'manifest.json'])
      expect((await stat(join(o.out, f))).mode & 0o777).toBe(0o600);
    expect((await stat(o.out)).mode & 0o777).toBe(0o700);
    const run = await readRun(o.out);
    expect(run.items).toHaveLength(1);
  });

  it('counts author-deleted comments and timing lost to retention', async () => {
    const t = await seedTenant(env.c, 'deleted');
    await seedEvalComment(env.c, t, { postedAt: day(1), state: 'deleted' });
    await seedHiddenTimeline(env.c, t, { postedAt: day(1) });
    const o = await opts({
      organizationIds: [t.organizationId],
      now: new Date(day(1).getTime() + 3 * 86_400_000),
      jobRetentionDays: 2,
    });
    const m = await exportRun(pool, o);
    expect(m.itemCount).toBe(1);
    expect(m.excludedAuthorDeleted).toBe(1);
    expect(m.timingUnavailableBeforeRetention).toBe(1);
    const fresh = await exportRun(pool, await opts({ organizationIds: [t.organizationId] }));
    expect(fresh.timingUnavailableBeforeRetention).toBe(0);
    const recent = await exportRun(
      pool,
      await opts({ organizationIds: [t.organizationId], jobRetentionDays: 365 }),
    );
    expect(recent.timingUnavailableBeforeRetention).toBe(0);
  });

  it('end-to-end webhook timeline from real ledger rows', async () => {
    const t = await seedTenant(env.c, 'e2e');
    const ledger = new PgJobLedger(pool);
    const scope = {
      organizationId: t.organizationId,
      brandId: t.brandId,
      connectionId: t.connectionId,
    };
    const externalId = 'ext_e2e_1';
    const payload: IngestPayload = {
      sourceExternalId: 'post_1',
      commentExternalId: externalId,
      event: 'created',
      platformEventSec: 1_700_000_000,
      changeId: '0123456789abcdef',
    };
    const ingest = await ledger.insert({
      scope,
      platform: 'facebook',
      jobType: INGEST_JOB.type,
      idempotencyKey: deriveIdempotencyKey({
        scope,
        platform: 'facebook',
        type: INGEST_JOB.type,
        externalRef: INGEST_JOB.externalRef(payload),
      }),
      payloadJson: JSON.stringify(payload),
      ttlMs: 86_400_000,
      traceContext: null,
    });
    if (ingest.status !== 'inserted') throw new Error('ingest not inserted');
    expect((await ledger.claim(ingest.id, 'w1', 60_000)).status).toBe('claimed');
    const received = (
      await env.c.query<{ created_at: Date }>('SELECT created_at FROM job_ledger WHERE id = $1', [
        ingest.id,
      ])
    ).rows[0]!.created_at;
    const postedAt = new Date(received.getTime() - 2000);
    const s = await seedEvalComment(env.c, t, { postedAt, externalId, state: 'hidden' });
    await env.c.query(
      `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
         trigger_key, ruleset_version, status)
       VALUES ($1, $2, $3, $4, sha256(convert_to($5, 'UTF8')), 'ingest', 'v1', 'no_match')`,
      [t.organizationId, t.brandId, t.connectionId, s.id, s.body],
    );
    const actionId = (
      await env.c.query<{ id: string }>(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
           actor_type, request_key, status)
         VALUES ($1, $2, $3, $4, 'hide', 'classifier', 'clf:e2e', 'pending') RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, s.id],
      )
    ).rows[0]!.id;
    const exec = await ledger.insert({
      scope,
      platform: 'facebook',
      jobType: EXECUTE_JOB.type,
      idempotencyKey: deriveIdempotencyKey({
        scope,
        platform: 'facebook',
        type: EXECUTE_JOB.type,
        externalRef: EXECUTE_JOB.externalRef({ actionId }),
      }),
      payloadJson: JSON.stringify({ actionId }),
      ttlMs: 86_400_000,
      traceContext: null,
    });
    if (exec.status !== 'inserted') throw new Error('exec not inserted');
    expect((await ledger.claim(exec.id, 'w2', 60_000)).status).toBe('claimed');
    await env.c.query(
      "UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1",
      [actionId],
    );
    expect(await ledger.complete(exec.id, 'w2', '{}')).toBe(true);

    const salt = Buffer.alloc(32, 5);
    const o = await opts({
      organizationIds: [t.organizationId],
      from: new Date(postedAt.getTime() - 60_000),
      to: new Date(postedAt.getTime() + 60_000),
      now: new Date(postedAt.getTime() + 60_000),
    });
    await exportRunWithSalt(pool, o, salt);
    const [line] = await lines(o.out);
    const item = JSON.parse(line!) as {
      item: string;
      channel: string;
      outcome: string;
      decider: string;
      timing: { totalMs: number; breakdown: Record<string, number> | null } | null;
    };
    expect(item.item).toBe(pseudonymiser(salt)(s.id));
    expect(item.channel).toBe('webhook');
    expect(item.outcome).toBe('hidden');
    expect(item.decider).toBe('classifier');
    const b = item.timing!.breakdown!;
    expect(b).not.toBeNull();
    expect(b.deliveryMs).toBe(2000);
    expect(b.ingestQueueMs).toBeGreaterThanOrEqual(0);
    expect(b.hideQueueMs).toBeGreaterThanOrEqual(0);
    expect(b.deliveryMs! + b.ingestQueueMs! + b.processingMs! + b.hideQueueMs! + b.hideCallMs!).toBe(
      item.timing!.totalMs,
    );
  });
});
