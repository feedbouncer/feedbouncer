import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { ApiKeyLimitError, ApiKeyNameTakenError, MAX_ACTIVE_KEYS, PgApiKeys } from './store.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let keys: PgApiKeys;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = new pg.Pool({ connectionString: h.db.url.href, max: 8 });
  keys = new PgApiKeys(pool);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const tenant = () => seedTenant(h.c, `k${++seq}`);
const fill = async (org: string, user: string, n: number) => {
  for (let i = 0; i < n; i++) await keys.create(org, user, { name: `key ${i}`, scope: 'read' });
};

describe('PgApiKeys.create', () => {
  it('stores only the hash of the secret', async () => {
    const t = await tenant();
    const { key, token } = await keys.create(t.organizationId, t.userId, {
      name: 'ci',
      scope: 'write',
    });
    expect(key).toMatchObject({ name: 'ci', scope: 'write', createdByUserId: t.userId });
    const secret = token.reveal().split('_')[2]!;
    const row = (await h.c.query('SELECT * FROM api_key WHERE id = $1', [key.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(Object.values(row).some((v) => typeof v === 'string' && v.includes('fbk_'))).toBe(false);
  });

  it('rejects the 11th active key, and accepts one after a revoke', async () => {
    const t = await tenant();
    await fill(t.organizationId, t.userId, MAX_ACTIVE_KEYS);
    await expect(
      keys.create(t.organizationId, t.userId, { name: 'extra', scope: 'read' }),
    ).rejects.toBeInstanceOf(ApiKeyLimitError);
    const [first] = await keys.list(t.organizationId);
    await keys.revoke(t.organizationId, t.userId, first!.id);
    await expect(
      keys.create(t.organizationId, t.userId, { name: 'extra', scope: 'read' }),
    ).resolves.toBeDefined();
  });

  it('lets exactly one of two concurrent creates at the limit succeed', async () => {
    const t = await tenant();
    await fill(t.organizationId, t.userId, MAX_ACTIVE_KEYS - 1);
    const results = await Promise.allSettled(
      ['a', 'b'].map((name) => keys.create(t.organizationId, t.userId, { name, scope: 'read' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ApiKeyLimitError);
  });

  it('rejects a duplicate active name, case-insensitively, but allows reuse after revoke', async () => {
    const t = await tenant();
    const { key } = await keys.create(t.organizationId, t.userId, { name: 'Prod', scope: 'read' });
    await expect(
      keys.create(t.organizationId, t.userId, { name: 'prod', scope: 'read' }),
    ).rejects.toBeInstanceOf(ApiKeyNameTakenError);
    await keys.revoke(t.organizationId, t.userId, key.id);
    await expect(
      keys.create(t.organizationId, t.userId, { name: 'prod', scope: 'read' }),
    ).resolves.toBeDefined();
  });

  it('writes an audit row without the token', async () => {
    const t = await tenant();
    const { key, token } = await keys.create(t.organizationId, t.userId, {
      name: 'audited',
      scope: 'read',
    });
    await keys.revoke(t.organizationId, t.userId, key.id);
    const rows = (
      await h.c.query(
        `SELECT action, details::text AS details FROM audit_event
          WHERE organization_id = $1 AND subject_id = $2 ORDER BY created_at, action`,
        [t.organizationId, key.id],
      )
    ).rows;
    expect(rows.map((r) => r.action).sort()).toEqual(['api_key.created', 'api_key.revoked']);
    for (const r of rows) {
      expect(r.details).not.toContain('fbk_');
      expect(r.details).not.toContain(token.reveal().split('_')[2]);
    }
  });
});

describe('PgApiKeys.list', () => {
  it('lists active keys first, then revoked, newest first, scoped to the org', async () => {
    const t = await tenant();
    const other = await tenant();
    const a = await keys.create(t.organizationId, t.userId, { name: 'a', scope: 'read' });
    const b = await keys.create(t.organizationId, t.userId, { name: 'b', scope: 'read' });
    const c = await keys.create(t.organizationId, t.userId, { name: 'c', scope: 'read' });
    await keys.create(other.organizationId, other.userId, { name: 'x', scope: 'read' });
    await keys.revoke(t.organizationId, t.userId, b.key.id);
    const list = await keys.list(t.organizationId);
    expect(list.map((k) => k.id)).toEqual([c.key.id, a.key.id, b.key.id]);
    const email = (await h.c.query('SELECT email FROM app_user WHERE id = $1', [t.userId])).rows[0]
      .email;
    expect(list[0]!.createdByName).toBe(email);
  });
});

describe('PgApiKeys.authenticate and revoke', () => {
  it('authenticates, then fails on the very next call after revoke', async () => {
    const t = await tenant();
    const { key, token } = await keys.create(t.organizationId, t.userId, {
      name: 'auth',
      scope: 'write',
    });
    await expect(keys.authenticate(token.reveal())).resolves.toEqual({
      organizationId: t.organizationId,
      apiKeyId: key.id,
      scope: 'write',
    });
    const raw = token.reveal();
    const tampered = `${raw.slice(0, -1)}${raw.endsWith('A') ? 'B' : 'A'}`;
    await expect(keys.authenticate(tampered)).resolves.toBeNull();
    await expect(keys.authenticate('garbage')).resolves.toBeNull();
    const revoked = await keys.revoke(t.organizationId, t.userId, key.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    await expect(keys.authenticate(raw)).resolves.toBeNull();
  });

  it('authenticates a moderate key with its scope', async () => {
    const t = await tenant();
    const { token } = await keys.create(t.organizationId, t.userId, {
      name: 'mod',
      scope: 'moderate',
    });
    await expect(keys.authenticate(token.reveal())).resolves.toMatchObject({ scope: 'moderate' });
  });

  it('rejects an unknown scope at the database', async () => {
    const t = await tenant();
    await expect(
      h.c.query(
        `INSERT INTO api_key (organization_id, name, public_id, secret_sha256, scope)
         VALUES ($1, 'bad', 'zzzzzzzzzzzzzzzz', '\\x00', 'admin')`,
        [t.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'api_key_scope_check' });
  });

  it('revoke is idempotent and keeps the first revocation time', async () => {
    const t = await tenant();
    const { key } = await keys.create(t.organizationId, t.userId, { name: 'r', scope: 'read' });
    const first = await keys.revoke(t.organizationId, t.userId, key.id);
    const second = await keys.revoke(t.organizationId, t.userId, key.id);
    expect(second?.revokedAt).toEqual(first?.revokedAt);
    const audits = await h.c.query(
      "SELECT 1 FROM audit_event WHERE subject_id = $1 AND action = 'api_key.revoked'",
      [key.id],
    );
    expect(audits.rowCount).toBe(1);
  });

  it("returns null and leaves the key active when revoking another org's key", async () => {
    const t = await tenant();
    const other = await tenant();
    const { key, token } = await keys.create(t.organizationId, t.userId, {
      name: 'mine',
      scope: 'read',
    });
    await expect(keys.revoke(other.organizationId, other.userId, key.id)).resolves.toBeNull();
    await expect(keys.authenticate(token.reveal())).resolves.not.toBeNull();
  });

  it('updates last_used_at at most once per 60 seconds', async () => {
    const t = await tenant();
    const { key, token } = await keys.create(t.organizationId, t.userId, {
      name: 'used',
      scope: 'read',
    });
    const lastUsed = async () =>
      (await h.c.query('SELECT last_used_at FROM api_key WHERE id = $1', [key.id])).rows[0]
        .last_used_at as Date | null;
    expect(await lastUsed()).toBeNull();
    await keys.authenticate(token.reveal());
    const first = await lastUsed();
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 1_000));
    await keys.authenticate(token.reveal());
    expect(await lastUsed()).toEqual(first);
  });

  it('returns null once the organization is gone', async () => {
    const t = await tenant();
    const { token } = await keys.create(t.organizationId, t.userId, { name: 'g', scope: 'read' });
    await h.c.query('DELETE FROM organization WHERE id = $1', [t.organizationId]);
    await expect(keys.authenticate(token.reveal())).resolves.toBeNull();
  });
});
