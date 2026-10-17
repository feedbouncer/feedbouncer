import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { periodForWeek, type ReportPeriod } from './period.js';
import { computeWeeklyStats } from './stats.js';
import { seedAd, seedHide, seedProcessed, seedSource, seedUnhide, setState } from './testing.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let week: ReportPeriod;
let n = 0;

const NOW = new Date('2026-10-19T08:00:00Z');
const at = (iso: string) => new Date(iso);
const MID = at('2026-10-14T12:00:00Z');

beforeAll(async () => {
  h = await migratedDb();
  week = (await periodForWeek(h.c, 'UTC', '2026-10-12'))!;
});
afterAll(async () => {
  await h.close();
});

const fresh = () => seedTenant(h.c, `rs${++n}`, { timezone: 'UTC' });
const stats = (t: Tenant, p: ReportPeriod = week) =>
  computeWeeklyStats(h.c, t.organizationId, p, NOW);
type CommentOpts = Omit<Parameters<typeof seedProcessed>[2], 'postedAt'>;
const processedAt = (t: Tenant, postedAt: Date, o: CommentOpts = {}) =>
  seedProcessed(h.c, t, { ...o, postedAt });
const many = async (count: number, f: () => Promise<unknown>) => {
  for (let i = 0; i < count; i++) await f();
};

describe('computeWeeklyStats', () => {
  it('reports the period and computation time', async () => {
    const t = await fresh();
    expect(await stats(t)).toMatchObject({
      version: 1,
      organizationId: t.organizationId,
      weekStart: '2026-10-12',
      timezone: 'UTC',
      start: '2026-10-12T00:00:00.000Z',
      end: '2026-10-19T00:00:00.000Z',
      computedAt: NOW.toISOString(),
      processed: 0,
      processedPrev: 0,
      hidden: 0,
      buckets: [],
      ads: [],
      brands: [],
      incompleteAccounts: [],
    });
  });

  it('processed counts classified and rule-decided comments in the week; excludes own-account, unprocessed, and comments posted outside [start, end)', async () => {
    const t = await fresh();
    await processedAt(t, at('2026-10-12T00:00:00Z'));
    await processedAt(t, MID, { via: 'rule' });
    await processedAt(t, at('2026-10-18T23:59:59Z'));
    await processedAt(t, MID, { own: true });
    await processedAt(t, MID, { via: 'none' });
    await processedAt(t, at('2026-10-11T23:59:59Z'));
    await processedAt(t, at('2026-10-19T00:00:00Z'));
    const s = await stats(t);
    expect(s.processed).toBe(3);
    expect(s.brands).toEqual([
      { brandId: t.brandId, name: `Brand rs${n}`, archived: false, processed: 3, hidden: 0 },
    ]);
  });

  it('processedPrev counts the prior week only', async () => {
    const t = await fresh();
    await processedAt(t, at('2026-10-05T00:00:00Z'));
    await processedAt(t, at('2026-10-11T23:59:59Z'));
    await processedAt(t, at('2026-10-04T23:59:59Z'));
    await processedAt(t, MID);
    const s = await stats(t);
    expect(s.processedPrev).toBe(2);
    expect(s.processed).toBe(1);
  });

  it('late-arriving comment (posted in week, ingested after end) counts in its posted week', async () => {
    const t = await fresh();
    const id = await processedAt(t, at('2026-10-18T23:00:00Z'));
    await h.c.query(
      "UPDATE comment SET ingested_at = '2026-10-20T10:00:00Z' WHERE organization_id = $1 AND id = $2",
      [t.organizationId, id],
    );
    expect((await stats(t)).processed).toBe(1);
    const next = (await periodForWeek(h.c, 'UTC', '2026-10-19'))!;
    expect((await stats(t, next)).processed).toBe(0);
  });

  it('buckets: 3 spam (classifier), 2 rule, 1 policy, 1 suggestion_classifier harassment_abuse, 1 system → spam 3, harassment_abuse 1, rule 2, custom_policy 1, other 1; Σ = hidden = 8; zero buckets omitted', async () => {
    const t = await fresh();
    const hideOne = async (o: Parameters<typeof seedHide>[3]) =>
      seedHide(h.c, t, await processedAt(t, MID), { at: MID, ...o });
    await many(3, () => hideOne({ by: 'classifier', category: 'spam' }));
    await many(2, () => hideOne({ by: 'rule' }));
    await hideOne({ by: 'policy' });
    await hideOne({ by: 'suggestion_classifier', category: 'harassment_abuse' });
    await hideOne({ by: 'system' });
    await processedAt(t, MID);
    const s = await stats(t);
    expect(s.buckets).toEqual([
      { bucket: 'spam', count: 3 },
      { bucket: 'harassment_abuse', count: 1 },
      { bucket: 'rule', count: 2 },
      { bucket: 'custom_policy', count: 1 },
      { bucket: 'other', count: 1 },
    ]);
    expect(s.hidden).toBe(8);
    expect(s.buckets.reduce((a, b) => a + b.count, 0)).toBe(s.hidden);
    expect(s.processed).toBe(9);
    expect(s.brands[0]).toMatchObject({ processed: 9, hidden: 8 });
  });

  it('unhidden by a person is not hidden; manual re-hide is not counted; classifier re-hide after unhide is counted once', async () => {
    const t = await fresh();
    const hours = (k: number) => new Date(MID.getTime() + k * 3_600_000);

    const unhidden = await processedAt(t, MID);
    const a = await seedHide(h.c, t, unhidden, { by: 'classifier', at: hours(1) });
    await seedUnhide(h.c, t, a.hideActionId);

    const manual = await processedAt(t, MID);
    const b = await seedHide(h.c, t, manual, { by: 'classifier', at: hours(1) });
    await seedUnhide(h.c, t, b.hideActionId);
    await seedHide(h.c, t, manual, { by: 'person', at: hours(2) });

    const rehidden = await processedAt(t, MID);
    const c = await seedHide(h.c, t, rehidden, { by: 'classifier', at: hours(1) });
    await seedUnhide(h.c, t, c.hideActionId);
    await seedHide(h.c, t, rehidden, { by: 'classifier', category: 'profanity', at: hours(2) });

    const s = await stats(t);
    expect(s.hidden).toBe(1);
    expect(s.buckets).toEqual([{ bucket: 'profanity', count: 1 }]);
  });

  it('an unhide recorded as the run step undo also reverses the hide', async () => {
    const t = await fresh();
    const id = await processedAt(t, MID);
    const { hideActionId } = await seedHide(h.c, t, id, { by: 'rule', at: MID });
    // Undo of a rule run: no reverses_action_id, only the step's undo_action_id points at it.
    const undo = await h.c.query<{ id: string }>(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
         actor_user_id, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'unhide', 'user', $5, 'undo:step-test', 'applied', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, id, t.userId],
    );
    expect((await stats(t)).hidden).toBe(1);
    const run = await h.c.query<{ id: string }>(
      `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id,
         dry_run)
       SELECT d.organization_id, d.brand_id, $3, d.comment_id, d.rule_id, d.rule_evaluation_id, false
         FROM decision d WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.comment_id = $4
          AND d.rule_evaluation_id IS NOT NULL
       RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, id],
    );
    await h.c.query(
      `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
         moderation_action_id, undo_action_id, completed_at)
       VALUES ($1, $2, $3, 0, 'hide', '{}', 'succeeded', $4, $5, now())`,
      [t.organizationId, t.brandId, run.rows[0]!.id, hideActionId, undo.rows[0]!.id],
    );
    expect((await stats(t)).hidden).toBe(0);
  });

  it('person-only hide is not counted; comment hidden twice by classifier counted once', async () => {
    const t = await fresh();
    await seedHide(h.c, t, await processedAt(t, MID), { by: 'person', at: MID });
    const twice = await processedAt(t, MID);
    await seedHide(h.c, t, twice, { by: 'classifier', at: MID });
    await seedHide(h.c, t, twice, { by: 'classifier', at: new Date(MID.getTime() + 60_000) });
    const s = await stats(t);
    expect(s.hidden).toBe(1);
    expect(s.buckets).toEqual([{ bucket: 'spam', count: 1 }]);
    expect(s.processed).toBe(2);
  });

  it("platform_state 'deleted' after hide → not hidden", async () => {
    const t = await fresh();
    const id = await processedAt(t, MID);
    await seedHide(h.c, t, id, { by: 'classifier', at: MID });
    await setState(h.c, t, id, 'deleted');
    const s = await stats(t);
    expect(s.hidden).toBe(0);
    expect(s.processed).toBe(1);
  });

  it('ads: ad with 12 comments / 3 hidden included; ad with 9 comments excluded; ad with 15 comments / 0 hidden excluded; comment on a shared source counts for both ads', async () => {
    const t = await fresh();
    const quiet = await seedSource(h.c, t);
    const included = await seedAd(h.c, t, { name: 'Main', externalId: '111111111' });
    const shared = await seedAd(h.c, t, {
      name: null,
      externalId: '222222222',
      platform: 'instagram',
    });
    await seedAd(h.c, t, { name: 'Small', sourceId: t.otherSourceId });
    await seedAd(h.c, t, { name: 'Clean', sourceId: quiet });
    const commentOn = async (sourceId: string, hidden: boolean) => {
      const id = await processedAt(t, MID, { sourceId });
      if (hidden) await seedHide(h.c, t, id, { by: 'classifier', at: MID });
    };
    for (let i = 0; i < 12; i++) await commentOn(t.sourceId, i < 3);
    await processedAt(t, MID, { via: 'none' });
    for (let i = 0; i < 9; i++) await commentOn(t.otherSourceId, i < 2);
    for (let i = 0; i < 15; i++) await commentOn(quiet, false);

    const s = await stats(t);
    const byId = Object.fromEntries(s.ads.map((a) => [a.adId, a]));
    expect(s.ads).toHaveLength(2);
    expect(byId[included.adId]).toEqual({
      adId: included.adId,
      externalId: '111111111',
      name: 'Main',
      platforms: ['facebook'],
      brandId: t.brandId,
      archived: false,
      hidden: 3,
      total: 12,
    });
    expect(byId[shared.adId]).toMatchObject({
      name: null,
      platforms: ['instagram'],
      hidden: 3,
      total: 12,
    });
  });

  it('an ad on two sources counts each comment once and lists both platforms', async () => {
    const t = await fresh();
    const { adId } = await seedAd(h.c, t, { externalId: '333333333' });
    await h.c.query(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       VALUES ($1, $2, $3, $4, 'instagram')`,
      [t.organizationId, t.brandId, adId, t.otherSourceId],
    );
    for (let i = 0; i < 6; i++) {
      const id = await processedAt(t, MID, { sourceId: t.sourceId });
      if (i === 0) await seedHide(h.c, t, id, { by: 'rule', at: MID });
    }
    for (let i = 0; i < 4; i++) {
      const id = await processedAt(t, MID, { sourceId: t.otherSourceId });
      // Instagram ad comments also carry the ad's own source: still one comment.
      await h.c.query(
        'UPDATE comment SET ad_source_id = $3 WHERE organization_id = $1 AND id = $2',
        [t.organizationId, id, t.sourceId],
      );
    }
    const [ad] = (await stats(t)).ads;
    expect(ad).toMatchObject({ adId, platforms: ['facebook', 'instagram'], hidden: 1, total: 10 });
  });

  it('deleted ad still counted and flagged archived; archived brand’s data included and flagged archived', async () => {
    const t = await fresh();
    const gone = await seedAd(h.c, t, { deleted: true });
    const live = await seedAd(h.c, t, { sourceId: t.otherSourceId });
    for (const sourceId of [t.sourceId, t.otherSourceId])
      for (let i = 0; i < 10; i++) {
        const id = await processedAt(t, MID, { sourceId });
        if (i === 0) await seedHide(h.c, t, id, { by: 'classifier', at: MID });
      }
    const archivedOf = (s: Awaited<ReturnType<typeof stats>>) =>
      Object.fromEntries(s.ads.map((a) => [a.adId, a.archived]));

    const before = await stats(t);
    expect(archivedOf(before)).toEqual({ [gone.adId]: true, [live.adId]: false });
    expect(before.brands[0]!.archived).toBe(false);

    await h.c.query('UPDATE brand SET archived_at = now() WHERE organization_id = $1 AND id = $2', [
      t.organizationId,
      t.brandId,
    ]);
    const after = await stats(t);
    expect(archivedOf(after)).toEqual({ [gone.adId]: true, [live.adId]: true });
    expect(after.brands).toEqual([
      { brandId: t.brandId, name: expect.any(String), archived: true, processed: 20, hidden: 2 },
    ]);
    expect(after).toMatchObject({ processed: 20, hidden: 2 });
  });

  it('incompleteAccounts lists a connection with connection.disconnected audit in the week, and one currently reconnect_required', async () => {
    const t = await fresh();
    const connection = async (name: string, status = 'active') =>
      (
        await h.c.query<{ id: string }>(
          `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name, status)
           VALUES ($1, $2, 'instagram', $3, $4, $5) RETURNING id`,
          [t.organizationId, t.brandId, `ig-${name}`, name, status],
        )
      ).rows[0]!.id;
    const audit = (subjectId: string, action: string, createdAt: string) =>
      h.c.query(
        `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
         VALUES ($1, $2, 'system', $3, 'connection', $4, $5)`,
        [t.organizationId, t.brandId, action, subjectId, createdAt],
      );
    await h.c.query('UPDATE connection SET display_name = $2 WHERE id = $1', [
      t.connectionId,
      'Page One',
    ]);
    await audit(t.connectionId, 'connection.disconnected', '2026-10-14T09:00:00Z');
    const flagged = await connection('Insta Two', 'reconnect_required');
    const earlier = await connection('Old Three');
    await audit(earlier, 'connection.disconnected', '2026-10-01T09:00:00Z');
    const other = await connection('Other Four');
    await audit(other, 'connection.connected', '2026-10-14T09:00:00Z');
    const later = await connection('Later Five');
    await audit(later, 'connection.reconnect_required', '2026-10-19T09:00:00Z');
    await connection('Errored Six', 'error');

    const errored = (
      await h.c.query<{ id: string }>(
        "SELECT id FROM connection WHERE organization_id = $1 AND display_name = 'Errored Six'",
        [t.organizationId],
      )
    ).rows[0]!.id;
    expect((await stats(t)).incompleteAccounts).toEqual([
      { connectionId: errored, name: 'Errored Six', platform: 'instagram' },
      { connectionId: flagged, name: 'Insta Two', platform: 'instagram' },
      { connectionId: t.connectionId, name: 'Page One', platform: 'facebook' },
    ]);
  });

  it('incompleteAccounts: a connection revoked long before the week is not listed; one revoked in the week is, via its audit', async () => {
    const t = await fresh();
    const revoked = async (name: string, auditAt: string) => {
      const id = (
        await h.c.query<{ id: string }>(
          `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name, status)
           VALUES ($1, $2, 'instagram', $3, $4, 'revoked') RETURNING id`,
          [t.organizationId, t.brandId, `ig-${name}`, name],
        )
      ).rows[0]!.id;
      await h.c.query(
        `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
         VALUES ($1, $2, 'user', 'connection.disconnected', 'connection', $3, $4)`,
        [t.organizationId, t.brandId, id, auditAt],
      );
      return id;
    };
    await revoked('Gone Long Ago', '2026-03-01T09:00:00Z');
    const recent = await revoked('Gone This Week', '2026-10-13T09:00:00Z');
    expect((await stats(t)).incompleteAccounts).toEqual([
      { connectionId: recent, name: 'Gone This Week', platform: 'instagram' },
    ]);
  });

  it("computes from one statement, so it runs inside the caller's REPEATABLE READ transaction on a single snapshot", async () => {
    const t = await fresh();
    await seedHide(h.c, t, await processedAt(t, MID), { by: 'classifier', at: MID });
    await processedAt(t, at('2026-10-07T00:00:00Z'));
    const query = h.c.query.bind(h.c);
    let calls = 0;
    const counting = Object.assign(Object.create(h.c) as typeof h.c, {
      query: (...args: Parameters<typeof query>) => {
        calls++;
        return query(...args);
      },
    });
    await h.c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const s = await computeWeeklyStats(counting, t.organizationId, week, NOW);
      expect(s).toMatchObject({ processed: 1, processedPrev: 1, hidden: 1 });
    } finally {
      await h.c.query('ROLLBACK');
    }
    expect(calls).toBe(1);
  });

  it('workspace isolation: org B comments, ads, brands and hides never appear in org A stats, even when B shares external ids', async () => {
    const a = await fresh();
    const b = await fresh();
    for (const t of [a, b]) await seedAd(h.c, t, { externalId: '999999999', name: 'Same' });
    await processedAt(a, MID);
    for (let i = 0; i < 12; i++)
      await seedHide(h.c, b, await processedAt(b, MID), { by: 'classifier', at: MID });
    await processedAt(b, at('2026-10-07T00:00:00Z'));
    await h.c.query(
      "UPDATE connection SET status = 'reconnect_required' WHERE organization_id = $1",
      [b.organizationId],
    );
    await h.c.query(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
       VALUES ($1, $2, 'system', 'connection.disconnected', 'connection', $3, $4)`,
      [b.organizationId, b.brandId, b.connectionId, MID],
    );

    const sa = await stats(a);
    expect(sa).toMatchObject({
      organizationId: a.organizationId,
      processed: 1,
      processedPrev: 0,
      hidden: 0,
      buckets: [],
      ads: [],
      incompleteAccounts: [],
    });
    expect(sa.brands.map((x) => x.brandId)).toEqual([a.brandId]);

    const sb = await stats(b);
    expect(sb).toMatchObject({ processed: 12, processedPrev: 1, hidden: 12 });
    expect(sb.ads).toHaveLength(1);
    expect(sb.incompleteAccounts.map((x) => x.connectionId)).toContain(b.connectionId);
  });
});

describe('@feedbouncer/reports source', () => {
  it('no statement in @feedbouncer/reports selects comment.body', async () => {
    const dir = new URL('.', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files).toContain('stats.ts');
    expect(files).toContain('sql.ts');
    for (const f of files) {
      const text = await readFile(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/\.body\b/);
      expect(text, f).not.toMatch(/author/i);
    }
  });
});
