import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

/**
 * A structurally valid v1 envelope (contents are not real ciphertext; the
 * database checks only the layout written by packages/secrets):
 * version, key id length, key id, 2-byte big-endian wrapped length W, wrapped
 * key, 12-byte IV, 16-byte tag, then at least one ciphertext byte.
 */
function fakeEnvelope(
  keyId: string,
  o: { wrapped?: number; declared?: number; ct?: number; version?: number } = {},
): Buffer {
  const id = Buffer.from(keyId, 'latin1');
  const wrapped = o.wrapped ?? 60;
  const w = Buffer.alloc(2);
  w.writeUInt16BE(o.declared ?? wrapped);
  return Buffer.concat([
    Buffer.from([o.version ?? 1, id.length]),
    id,
    w,
    Buffer.alloc(wrapped, 7),
    Buffer.alloc(12, 8),
    Buffer.alloc(16, 9),
    Buffer.alloc(o.ct ?? 40, 5),
  ]);
}

let h: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  h = await migratedDb();
  a = await seedTenant(h.c, 'a');
  b = await seedTenant(h.c, 'b');
});
afterAll(() => h.close());

type Scope = Pick<Tenant, 'organizationId' | 'brandId' | 'connectionId'>;
const insert = (t: Scope, kind: string, keyId: string, blob: Buffer) =>
  h.c.query(
    'INSERT INTO connection_secret (organization_id, brand_id, connection_id, kind, key_id, encrypted_value) VALUES ($1,$2,$3,$4,$5,$6)',
    [t.organizationId, t.brandId, t.connectionId, kind, keyId, blob],
  );

const ENVELOPE = 'connection_secret_envelope_check';

describe('connection_secret', () => {
  it('accepts a v1 envelope whose embedded key id matches key_id', async () => {
    await insert(a, 'access_token', 'k1', fakeEnvelope('k1'));
  });

  it('accepts the smallest and the largest valid layouts', async () => {
    const t = await seedTenant(h.c, 'bounds');
    await insert(t, 'access_token', 'k', fakeEnvelope('k', { ct: 1 }));
    await insert(
      t,
      'refresh_token',
      'k'.repeat(32),
      fakeEnvelope('k'.repeat(32), { wrapped: 65535, ct: 16384 }),
    );
  });

  it('accepts a short wrapped key (a 40-byte RFC 3394 wrap) and the smallest possible wrap', async () => {
    const t = await seedTenant(h.c, 'shortwrap');
    await insert(t, 'access_token', 'k1', fakeEnvelope('k1', { wrapped: 40, ct: 1 }));
    await insert(t, 'refresh_token', 'k1', fakeEnvelope('k1', { wrapped: 1, ct: 1 }));
  });

  it('rejects every truncation with the check constraint, never an out-of-range error', async () => {
    const t = await seedTenant(h.c, 'truncate');
    const sources = [
      fakeEnvelope('k1', { wrapped: 60, ct: 1 }),
      fakeEnvelope('k1', { wrapped: 1, ct: 1 }),
      fakeEnvelope('k'.repeat(32), { wrapped: 40, ct: 1 }),
    ];
    for (const src of sources) {
      const keyId = src.subarray(2, 2 + src[1]!).toString('latin1');
      for (let len = 0; len < src.length; len++) {
        await expectPgError(
          insert(t, 'webhook_secret', keyId, src.subarray(0, len)),
          '23514',
          ENVELOPE,
        );
      }
    }
  });

  it('rejects plaintext, a wrong version byte, a key id mismatch and short blobs', async () => {
    const plaintext = Buffer.from('EAAGplaintextAccessToken'.padEnd(120, 'x'));
    const cases: [string, Buffer][] = [
      ['k1', plaintext],
      ['k1', fakeEnvelope('k1', { version: 2 })],
      ['k2', fakeEnvelope('k1')],
      ['k1', Buffer.alloc(0)],
    ];
    for (const [keyId, blob] of cases) {
      await expectPgError(insert(a, 'refresh_token', keyId, blob), '23514', ENVELOPE);
    }
  });

  it('rejects layouts the application would refuse to parse', async () => {
    const cases: Buffer[] = [
      fakeEnvelope('k1', { declared: 0 }), // wrapped key length 0
      fakeEnvelope('k1', { declared: 100 }), // leaves IV and tag but no ciphertext byte
      fakeEnvelope('k1', { declared: 128 }), // swallows IV, tag and ciphertext
      fakeEnvelope('k1', { declared: 65535 }), // runs far past the end
      fakeEnvelope('k1', { ct: 0 }), // no ciphertext byte
      fakeEnvelope('k1', { ct: 16385 }), // ciphertext above MAX_PLAINTEXT_BYTES
      Buffer.concat([Buffer.from([1, 0]), fakeEnvelope('k1').subarray(2)]), // key id length 0
      Buffer.concat([Buffer.from([1, 33]), fakeEnvelope('k1').subarray(2), Buffer.alloc(40)]),
    ];
    for (const blob of cases) {
      await expectPgError(insert(a, 'webhook_secret', 'k1', blob), '23514', ENVELOPE);
    }
  });

  it('rejects unknown kinds and malformed key ids', async () => {
    await expectPgError(
      insert(a, 'password', 'k1', fakeEnvelope('k1')),
      '23514',
      'connection_secret_kind_check',
    );
    await expectPgError(
      insert(a, 'webhook_secret', 'K1', fakeEnvelope('K1')),
      '23514',
      'connection_secret_key_id_check',
    );
  });

  it('keeps one row per (connection, kind)', async () => {
    await expectPgError(
      insert(a, 'access_token', 'k1', fakeEnvelope('k1')),
      '23505',
      'connection_secret_connection_id_kind_key',
    );
  });

  it('refuses a cross-tenant link (org A with brand/connection of B)', async () => {
    await expectPgError(
      insert(
        { ...b, organizationId: a.organizationId },
        'webhook_secret',
        'k1',
        fakeEnvelope('k1'),
      ),
      '23503',
    );
  });

  it('cascades with its connection', async () => {
    const t = await seedTenant(h.c, 'cascade');
    await insert(t, 'access_token', 'k1', fakeEnvelope('k1'));
    await h.c.query('DELETE FROM connection WHERE id = $1', [t.connectionId]);
    const { rows } = await h.c.query('SELECT 1 FROM connection_secret WHERE connection_id = $1', [
      t.connectionId,
    ]);
    expect(rows).toEqual([]);
  });

  it('bumps updated_at on update', async () => {
    const before = await h.c.query(
      "SELECT updated_at FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'",
      [a.connectionId],
    );
    await h.c.query('SELECT pg_sleep(0.01)');
    await h.c.query(
      "UPDATE connection_secret SET expires_at = now() WHERE connection_id = $1 AND kind = 'access_token'",
      [a.connectionId],
    );
    const after = await h.c.query(
      "SELECT updated_at FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'",
      [a.connectionId],
    );
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
  });

  it('indexes key_id for rotation queries', async () => {
    const { rows } = await h.c.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'connection_secret_key_id_idx'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe('connection reconnect state', () => {
  it('allows reconnect_required with a snake_case reason', async () => {
    await h.c.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'credential_tampered' WHERE id = $1",
      [a.connectionId],
    );
  });
  it('rejects malformed reasons', async () => {
    await expectPgError(
      h.c.query("UPDATE connection SET status_reason = 'Bad Reason!' WHERE id = $1", [
        a.connectionId,
      ]),
      '23514',
      'connection_status_reason_check',
    );
    await expectPgError(
      h.c.query('UPDATE connection SET status_reason = $2 WHERE id = $1', [
        a.connectionId,
        'a'.repeat(64),
      ]),
      '23514',
      'connection_status_reason_check',
    );
  });
});
