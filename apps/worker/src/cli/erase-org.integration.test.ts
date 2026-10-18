import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { EraseError, eraseOrg, runEraseOrg } from './erase-org.js';

// Smallest well-formed envelope v1 for key id "k1" (the table CHECK rejects anything else).
const envelope = Buffer.concat([
  Buffer.from([1, 2]),
  Buffer.from('k1'),
  Buffer.from([0, 1]),
  Buffer.alloc(1 + 12 + 16 + 1),
]);

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'erase-org-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

interface Fixture extends Tenant {
  name: string;
  email: string;
}

async function seed(label: string): Promise<Fixture> {
  const t = await seedTenant(h.c, label);
  await h.c.query("UPDATE connection SET status = 'active' WHERE id = $1", [t.connectionId]);
  await h.c.query(
    `INSERT INTO connection_secret (organization_id, brand_id, connection_id, kind, key_id, encrypted_value)
     VALUES ($1, $2, $3, 'access_token', 'k1', $4)`,
    [t.organizationId, t.brandId, t.connectionId, envelope],
  );
  const org = await h.c.query<{ name: string }>('SELECT name FROM organization WHERE id = $1', [
    t.organizationId,
  ]);
  const user = await h.c.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [
    t.userId,
  ]);
  return { ...t, name: org.rows[0]!.name, email: user.rows[0]!.email };
}

const orgExists = async (id: string) =>
  (await h.c.query('SELECT 1 FROM organization WHERE id = $1', [id])).rowCount === 1;
const userExists = async (id: string) =>
  (await h.c.query('SELECT 1 FROM app_user WHERE id = $1', [id])).rowCount === 1;

function harness(f: Fixture, opts: { teardownFinishes: boolean } = { teardownFinishes: true }) {
  const disconnected: string[] = [];
  const deps = {
    pool,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    disconnect: async (scope: ConnectionScope) => {
      disconnected.push(scope.connectionId);
      await h.c.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [
        scope.connectionId,
      ]);
    },
    sleep: async () => {
      if (opts.teardownFinishes)
        await h.c.query('DELETE FROM connection_secret WHERE organization_id = $1', [
          f.organizationId,
        ]);
    },
  };
  return { deps, disconnected };
}

const run = (
  deps: ReturnType<typeof harness>['deps'],
  f: Fixture,
  extra: Partial<Parameters<typeof eraseOrg>[1]> = {},
) =>
  eraseOrg(deps, {
    organizationId: f.organizationId,
    confirmName: f.name,
    deleteOrphanUsers: false,
    ...extra,
  });

describe('eraseOrg', () => {
  it('wrong confirm name -> confirmation_mismatch, nothing changed', async () => {
    const f = await seed('mismatch');
    const { deps, disconnected } = harness(f);
    await expect(run(deps, f, { confirmName: 'nope' })).rejects.toMatchObject({
      code: 'confirmation_mismatch',
    });
    expect(disconnected).toEqual([]);
    expect(await orgExists(f.organizationId)).toBe(true);
    const c = await h.c.query('SELECT status FROM connection WHERE id = $1', [f.connectionId]);
    expect(c.rows[0].status).toBe('active');
  });

  it('a non-uuid organization id -> confirmation_mismatch', async () => {
    const f = await seed('baduuid');
    await expect(run(harness(f).deps, f, { organizationId: 'x; DROP' })).rejects.toBeInstanceOf(
      EraseError,
    );
  });

  it('erases org, disconnects each live connection once', async () => {
    const f = await seed('erase');
    await h.c.query(
      "INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status) VALUES ($1, $2, 'facebook', $3, 'revoked')",
      [f.organizationId, f.brandId, `page-${randomUUID()}`],
    );
    const { deps, disconnected } = harness(f);
    expect(await run(deps, f)).toEqual({ connectionsDisconnected: 1, usersDeleted: 0 });
    expect(disconnected).toEqual([f.connectionId]);
    expect(await orgExists(f.organizationId)).toBe(false);
    expect(await userExists(f.userId)).toBe(true);
  });

  it('re-queues teardown for a revoked connection that still holds secrets', async () => {
    const f = await seed('requeue');
    await h.c.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [f.connectionId]);
    const { deps, disconnected } = harness(f);
    expect(await run(deps, f)).toEqual({ connectionsDisconnected: 1, usersDeleted: 0 });
    expect(disconnected).toEqual([f.connectionId]);
    expect(await orgExists(f.organizationId)).toBe(false);
  });

  it('teardown never finishes -> teardown_timeout, org still exists', async () => {
    const f = await seed('timeout');
    const { deps } = harness(f, { teardownFinishes: false });
    await expect(run(deps, f, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'teardown_timeout',
    });
    expect(await orgExists(f.organizationId)).toBe(true);
  });

  it('deleteOrphanUsers deletes only users with no other membership', async () => {
    const f = await seed('orphans');
    const other = await seedTenant(h.c, 'orphans-other');
    const shared = await h.c.query<{ id: string }>(
      'INSERT INTO app_user (email) VALUES ($1) RETURNING id',
      [`shared-${randomUUID()}@example.test`],
    );
    const sharedId = shared.rows[0]!.id;
    for (const org of [f.organizationId, other.organizationId])
      await h.c.query(
        "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
        [org, sharedId],
      );
    const { deps } = harness(f);
    const r = await run(deps, f, { deleteOrphanUsers: true });
    expect(r.usersDeleted).toBe(1);
    expect(await userExists(f.userId)).toBe(false);
    expect(await userExists(sharedId)).toBe(true);
    expect(await userExists(other.userId)).toBe(true);
  });

  it('output contains no email', async () => {
    const f = await seed('output');
    const { deps } = harness(f);
    const lines: string[] = [];
    const code = await runEraseOrg(
      ['--org', f.organizationId, '--confirm', f.name, '--delete-orphan-users'],
      deps,
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    expect(text).toContain(f.organizationId);
    expect(text).not.toContain(f.email);
    expect(text).not.toContain(f.name);
  });
});
