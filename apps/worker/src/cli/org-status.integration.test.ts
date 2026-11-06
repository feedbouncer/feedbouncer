import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { UsageError } from '@feedbouncer/jobs';
import type { OpsContext } from './ops-context.js';
import { OrgStatusError, orgStatusCommand } from './org-status.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'org-status-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

function run(argv: string[]) {
  const lines: string[] = [];
  const ctx = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    out: (line: string) => lines.push(line),
    pool: () => pool,
  } as unknown as OpsContext;
  return { lines, done: orgStatusCommand(argv, ctx) };
}

const setArgv = (org: string, actor: string, status = 'suspended', reason = 'abuse') => [
  'set',
  org,
  status,
  '--actor',
  actor,
  '--reason',
  reason,
];
const statusOf = async (id: string) =>
  (await h.c.query<{ status: string }>('SELECT status FROM organization WHERE id = $1', [id]))
    .rows[0]!.status;
const audits = async (id: string) =>
  (
    await h.c.query(
      "SELECT * FROM audit_event WHERE organization_id = $1 AND action LIKE 'organization.%'",
      [id],
    )
  ).rows;

describe('org-status', () => {
  it('suspends and audits', async () => {
    const t = await seedTenant(h.c, 'os-suspend');
    const r = run(setArgv(t.organizationId, t.userId));
    expect(await r.done).toBe(0);
    expect(r.lines).toEqual([`${t.organizationId} active -> suspended`]);
    expect(await statusOf(t.organizationId)).toBe('suspended');
    const rows = await audits(t.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'organization.suspended',
      actor_type: 'system',
      actor_user_id: t.userId,
      details: { from: 'active', to: 'suspended', reason: 'abuse', via: 'ops_cli' },
    });
  });

  it('repeat is a no-op', async () => {
    const t = await seedTenant(h.c, 'os-repeat');
    await run(setArgv(t.organizationId, t.userId)).done;
    const r = run(setArgv(t.organizationId, t.userId));
    expect(await r.done).toBe(0);
    expect(r.lines).toEqual([`unchanged ${t.organizationId} suspended`]);
    expect(await audits(t.organizationId)).toHaveLength(1);
  });

  it('reactivates and audits organization.reactivated', async () => {
    const t = await seedTenant(h.c, 'os-react');
    await run(setArgv(t.organizationId, t.userId)).done;
    await run(setArgv(t.organizationId, t.userId, 'active', 'customer_request')).done;
    expect(await statusOf(t.organizationId)).toBe('active');
    const actions = (await audits(t.organizationId)).map((a) => a.action).sort();
    expect(actions).toEqual(['organization.reactivated', 'organization.suspended']);
  });

  it('shows the status and the latest status audit row', async () => {
    const t = await seedTenant(h.c, 'os-show');
    const before = run(['show', t.organizationId]);
    await before.done;
    expect(before.lines).toEqual([`${t.organizationId} active`]);
    await run(setArgv(t.organizationId, t.userId, 'suspended', 'non_payment')).done;
    const r = run(['show', t.organizationId]);
    expect(await r.done).toBe(0);
    expect(r.lines[0]).toBe(`${t.organizationId} suspended`);
    expect(r.lines[1]).toMatch(
      new RegExp(`^organization\\.suspended .+ actor_user_id=${t.userId} reason=non_payment$`),
    );
  });

  it('does not touch keys or memberships', async () => {
    const t = await seedTenant(h.c, 'os-keys');
    const snapshot = async () => ({
      keys: (
        await h.c.query('SELECT * FROM api_key WHERE organization_id = $1 ORDER BY id', [
          t.organizationId,
        ])
      ).rows,
      members: (
        await h.c.query('SELECT * FROM membership WHERE organization_id = $1 ORDER BY user_id', [
          t.organizationId,
        ])
      ).rows,
    });
    const before = await snapshot();
    await run(setArgv(t.organizationId, t.userId)).done;
    await run(setArgv(t.organizationId, t.userId, 'active')).done;
    expect(await snapshot()).toEqual(before);
  });

  it('rejects bad input', async () => {
    const t = await seedTenant(h.c, 'os-bad');
    const bad = [
      setArgv(t.organizationId, t.userId, 'paused'),
      setArgv('not-a-uuid', t.userId),
      ['set', t.organizationId, 'suspended', '--reason', 'abuse'],
      setArgv(t.organizationId, t.userId, 'suspended', 'because'),
      setArgv(t.organizationId, 'nope'),
      ['show', 'nope'],
      [],
    ];
    for (const argv of bad) await expect(run(argv).done).rejects.toBeInstanceOf(UsageError);
    expect(await statusOf(t.organizationId)).toBe('active');
  });

  it('unknown org / unknown actor', async () => {
    const t = await seedTenant(h.c, 'os-unknown');
    await expect(run(setArgv(randomUUID(), t.userId)).done).rejects.toMatchObject({
      code: 'org_not_found',
    });
    await expect(run(setArgv(t.organizationId, randomUUID())).done).rejects.toMatchObject({
      code: 'actor_not_found',
    });
    await expect(run(setArgv(randomUUID(), t.userId)).done).rejects.toBeInstanceOf(OrgStatusError);
    expect(await statusOf(t.organizationId)).toBe('active');
    expect(await audits(t.organizationId)).toHaveLength(0);
  });
});
