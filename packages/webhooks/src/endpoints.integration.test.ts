import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgApiKeys, type ApiKeyContext } from '@feedbouncer/public-api';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { MAX_ENDPOINTS_PER_ORG } from './constants.js';
import { EndpointLimitError, InvalidWebhookUrlError, PgWebhookEndpoints } from './endpoints.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let endpoints: PgWebhookEndpoints;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = new pg.Pool({ connectionString: h.db.url.href, max: 8 });
  endpoints = new PgWebhookEndpoints(pool, testKeyring(), {
    resolve: (host) =>
      Promise.resolve(host === 'rebind.example.com' ? ['10.0.0.5'] : ['93.184.216.34']),
    allowedPrivateCidrs: [],
  });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

async function ctxOf(): Promise<ApiKeyContext> {
  const t = await seedTenant(h.c, `ep${++seq}`);
  const { key } = await new PgApiKeys(pool).create(t.organizationId, t.userId, {
    name: `k${seq}`,
    scope: 'write',
  });
  return { organizationId: t.organizationId, apiKeyId: key.id, scope: 'write' };
}

const input = (n = 1) => ({
  url: `https://hooks.example.com/${n}`,
  eventTypes: ['comment.received' as const],
});

describe('PgWebhookEndpoints.create', () => {
  it('stores only an envelope-sealed secret and returns it once', async () => {
    const ctx = await ctxOf();
    const { endpoint, secret } = await endpoints.create(ctx, input());
    expect(secret.reveal()).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({ status: 'active', disabledReason: null, description: null });
    const { rows } = await pool.query('SELECT * FROM webhook_endpoint WHERE id = $1', [
      endpoint.id,
    ]);
    for (const value of Object.values(rows[0])) {
      expect(String(Buffer.isBuffer(value) ? value.toString('latin1') : value)).not.toContain(
        'whsec_',
      );
    }
    expect(rows[0].created_by_api_key_id).toBe(ctx.apiKeyId);
  });

  it('audits without the url or the secret', async () => {
    const ctx = await ctxOf();
    const { endpoint, secret } = await endpoints.create(ctx, input());
    const { rows } = await pool.query(
      `SELECT actor_type, action, subject_id, details FROM audit_event
        WHERE organization_id = $1 AND action LIKE 'webhook_endpoint.%'`,
      [ctx.organizationId],
    );
    expect(rows).toEqual([
      {
        actor_type: 'api_key',
        action: 'webhook_endpoint.created',
        subject_id: endpoint.id,
        details: { apiKeyId: ctx.apiKeyId },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret.reveal());
    expect(JSON.stringify(rows)).not.toContain('hooks.example.com');
  });

  it('refuses the eleventh endpoint of an organization, even under concurrency', async () => {
    const ctx = await ctxOf();
    const results = await Promise.allSettled(
      Array.from({ length: MAX_ENDPOINTS_PER_ORG + 3 }, (_, n) => endpoints.create(ctx, input(n))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_ENDPOINTS_PER_ORG);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(EndpointLimitError);
    }
  });

  it('rejects a private-address url with its reason, and a name that resolves privately', async () => {
    const ctx = await ctxOf();
    await expect(
      endpoints.create(ctx, { ...input(), url: 'https://10.0.0.5/hook' }),
    ).rejects.toMatchObject({ reason: 'private_address' });
    await expect(
      endpoints.create(ctx, { ...input(), url: 'https://rebind.example.com/hook' }),
    ).rejects.toBeInstanceOf(InvalidWebhookUrlError);
    await expect(
      endpoints.create(ctx, { ...input(), url: 'http://hooks.example.com/hook' }),
    ).rejects.toMatchObject({ reason: 'not_https' });
    expect((await endpoints.list(ctx.organizationId)).length).toBe(0);
  });
});

describe('PgWebhookEndpoints.signingSecrets', () => {
  it('returns the current secret, both during a rotation overlap, and the new one after it', async () => {
    const ctx = await ctxOf();
    const { endpoint, secret: first } = await endpoints.create(ctx, input());
    const now = new Date();
    const only = await endpoints.signingSecrets(h.c, ctx.organizationId, endpoint.id, now);
    expect(only.map((s) => s.reveal())).toEqual([first.reveal()]);

    const rotated = (await endpoints.rotateSecret(ctx, endpoint.id))!;
    const both = await endpoints.signingSecrets(h.c, ctx.organizationId, endpoint.id, now);
    expect(both.map((s) => s.reveal())).toEqual([rotated.secret.reveal(), first.reveal()]);

    const later = new Date(new Date(rotated.previousSecretExpiresAt).getTime() + 1000);
    const after = await endpoints.signingSecrets(h.c, ctx.organizationId, endpoint.id, later);
    expect(after.map((s) => s.reveal())).toEqual([rotated.secret.reveal()]);
  });

  it('keeps the overlap at 24 hours and drops the oldest secret on a second rotation', async () => {
    const ctx = await ctxOf();
    const { endpoint, secret: first } = await endpoints.create(ctx, input());
    const second = (await endpoints.rotateSecret(ctx, endpoint.id))!;
    const third = (await endpoints.rotateSecret(ctx, endpoint.id))!;
    const secrets = await endpoints.signingSecrets(
      h.c,
      ctx.organizationId,
      endpoint.id,
      new Date(),
    );
    expect(secrets.map((s) => s.reveal())).toEqual([third.secret.reveal(), second.secret.reveal()]);
    expect(secrets.map((s) => s.reveal())).not.toContain(first.reveal());
    const hours = (new Date(third.previousSecretExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it('answers nothing for another organization', async () => {
    const a = await ctxOf();
    const b = await ctxOf();
    const { endpoint } = await endpoints.create(a, input());
    expect(await endpoints.signingSecrets(h.c, b.organizationId, endpoint.id, new Date())).toEqual(
      [],
    );
    expect(await endpoints.rotateSecret(b, endpoint.id)).toBeNull();
  });
});

describe('PgWebhookEndpoints read, update and remove', () => {
  it('scopes get, list, update and remove to the organization', async () => {
    const a = await ctxOf();
    const b = await ctxOf();
    const { endpoint } = await endpoints.create(a, input());
    expect(await endpoints.get(b.organizationId, endpoint.id)).toBeNull();
    expect(await endpoints.list(b.organizationId)).toEqual([]);
    expect(await endpoints.update(b, endpoint.id, { description: 'x' })).toBeNull();
    expect(await endpoints.remove(b, endpoint.id)).toBe(false);
    expect(await endpoints.get(a.organizationId, endpoint.id)).toEqual(endpoint);
  });

  it('updates fields, re-validates a changed url and audits without values', async () => {
    const ctx = await ctxOf();
    const { endpoint } = await endpoints.create(ctx, input());
    const updated = await endpoints.update(ctx, endpoint.id, {
      description: 'prod',
      eventTypes: ['item.flagged', 'comment.hidden'],
      url: 'https://hooks.example.com/new',
    });
    expect(updated).toMatchObject({
      description: 'prod',
      eventTypes: ['item.flagged', 'comment.hidden'],
      url: 'https://hooks.example.com/new',
    });
    await expect(
      endpoints.update(ctx, endpoint.id, { url: 'https://10.0.0.5/' }),
    ).rejects.toMatchObject({ reason: 'private_address' });
    const { rows } = await pool.query(
      `SELECT action, details FROM audit_event WHERE organization_id = $1 AND action = 'webhook_endpoint.updated'`,
      [ctx.organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('hooks.example.com');
  });

  it('disables manually, and re-enabling clears the failure state and audits enabled', async () => {
    const ctx = await ctxOf();
    const { endpoint } = await endpoints.create(ctx, input());
    const off = await endpoints.update(ctx, endpoint.id, { status: 'disabled' });
    expect(off).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    expect(off!.disabledAt).not.toBeNull();
    await pool.query(
      `UPDATE webhook_endpoint SET consecutive_failures = 20, first_failure_at = now() WHERE id = $1`,
      [endpoint.id],
    );
    const on = await endpoints.update(ctx, endpoint.id, { status: 'active' });
    expect(on).toMatchObject({ status: 'active', disabledReason: null, disabledAt: null });
    const { rows } = await pool.query(
      `SELECT consecutive_failures, first_failure_at, disabled_reason, disabled_at
         FROM webhook_endpoint WHERE id = $1`,
      [endpoint.id],
    );
    expect(rows[0]).toEqual({
      consecutive_failures: 0,
      first_failure_at: null,
      disabled_reason: null,
      disabled_at: null,
    });
    const audit = await pool.query(
      `SELECT action FROM audit_event
        WHERE organization_id = $1 AND action LIKE 'webhook_endpoint.%' ORDER BY sequence`,
      [ctx.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.enabled',
    ]);
  });

  it('removes an endpoint with its deliveries and audits it', async () => {
    const ctx = await ctxOf();
    const { endpoint } = await endpoints.create(ctx, input());
    expect(await endpoints.remove(ctx, endpoint.id)).toBe(true);
    expect(await endpoints.remove(ctx, endpoint.id)).toBe(false);
    expect(await endpoints.get(ctx.organizationId, endpoint.id)).toBeNull();
    const { rows } = await pool.query(
      `SELECT 1 FROM audit_event WHERE organization_id = $1 AND action = 'webhook_endpoint.deleted'`,
      [ctx.organizationId],
    );
    expect(rows).toHaveLength(1);
  });
});
