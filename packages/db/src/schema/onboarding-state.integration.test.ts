import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, type Tenant } from '../testing/index.js';
import { expectPgError as expectPg } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

const insert = (t: Tenant, extra = '', values: unknown[] = []) =>
  c.query(
    `INSERT INTO onboarding_state (organization_id, brand_id${extra ? `, ${extra}` : ''})
     VALUES ($1, $2${values.map((_, i) => `, $${i + 3}`).join('')})`,
    [t.organizationId, t.brandId, ...values],
  );
const row = async (t: Tenant) =>
  (
    await c.query<{ brand_id: string | null }>(
      'SELECT brand_id FROM onboarding_state WHERE organization_id = $1',
      [t.organizationId],
    )
  ).rows;

describe('onboarding_state schema', () => {
  it('defaults to run 1 with every step pending', async () => {
    const t = await seedTenant(c, 'ob-def');
    await insert(t);
    const r = (
      await c.query(
        `SELECT run, connect_status, defaults_status, review_mode_status, report_status, completed_at
         FROM onboarding_state WHERE organization_id = $1`,
        [t.organizationId],
      )
    ).rows[0];
    expect(r).toEqual({
      run: 1,
      connect_status: 'pending',
      defaults_status: 'pending',
      review_mode_status: 'pending',
      report_status: 'pending',
      completed_at: null,
    });
  });

  it('rejects completed_at while a step is pending', async () => {
    const t = await seedTenant(c, 'ob-done');
    await expectPg(
      insert(t, 'completed_at', [new Date()]),
      '23514',
      'onboarding_state_completed_check',
    );
  });

  it('rejects all steps done without completed_at, and accepts the consistent pair', async () => {
    const t = await seedTenant(c, 'ob-all');
    await expectPg(
      insert(t, `connect_status, defaults_status, review_mode_status, report_status`, [
        'done',
        'done',
        'done',
        'done',
      ]),
      '23514',
      'onboarding_state_completed_check',
    );
    await insert(
      t,
      `connect_status, defaults_status, review_mode_status, report_status, completed_at`,
      ['done', 'done', 'done', 'done', new Date()],
    );
  });

  it("rejects an unknown step status ('skipped')", async () => {
    const t = await seedTenant(c, 'ob-skip');
    await expectPg(
      insert(t, 'connect_status', ['skipped']),
      '23514',
      'onboarding_state_step_status_check',
    );
  });

  it('rejects run < 1 and an unknown review mode choice', async () => {
    const t = await seedTenant(c, 'ob-chk');
    await expectPg(insert(t, 'run', [0]), '23514', 'onboarding_state_run_check');
    await expectPg(
      insert(t, 'review_mode_choice', ['maybe']),
      '23514',
      'onboarding_state_review_mode_choice_check',
    );
  });

  it('deleting the brand nulls brand_id and keeps the row', async () => {
    const t = await seedTenant(c, 'ob-brand');
    await insert(t);
    await c.query('DELETE FROM brand WHERE id = $1', [t.brandId]);
    expect(await row(t)).toEqual([{ brand_id: null }]);
  });

  it('deleting the organization removes the row', async () => {
    const t = await seedTenant(c, 'ob-org');
    await insert(t);
    await c.query('DELETE FROM organization WHERE id = $1', [t.organizationId]);
    expect(await row(t)).toEqual([]);
  });

  it('one row per organization', async () => {
    const t = await seedTenant(c, 'ob-pk');
    await insert(t);
    await expectPg(insert(t), '23505', 'onboarding_state_pkey');
  });
});
