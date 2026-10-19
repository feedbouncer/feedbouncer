import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb } from '../testing/fixtures.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(() => ctx.close());
const q = async <T>(sql: string) => (await ctx.c.query(sql)).rows as T[];

const SYSTEM_TABLES = ['processed_job'];
// One row per connection, keyed by the connection's own id instead of a surrogate id.
const CONNECTION_KEYED_TABLES = ['connection_sync', 'connection_backfill'];
// Tables keyed by their natural key: source_poll is one row per source, meta_ad_source a link row.
const NATURAL_KEY_TABLES: Record<string, string> = {
  source_poll: 'PRIMARY KEY (source_id)',
  meta_ad_source: 'PRIMARY KEY (ad_id, source_id)',
  meta_ad_listing: 'PRIMARY KEY (ads_connection_id)',
  comment_tag: 'PRIMARY KEY (comment_id, tag_id)',
  comment_done: 'PRIMARY KEY (comment_id)',
  role_grant: 'PRIMARY KEY (organization_id, role, capability)',
  alert_brand_settings: 'PRIMARY KEY (brand_id)',
  alert_route: 'PRIMARY KEY (brand_id, alert_type, channel_id)',
  alert_brand_state: 'PRIMARY KEY (brand_id)',
  alert_negative_hourly: 'PRIMARY KEY (brand_id, hour)',
  alert_flag_item: 'PRIMARY KEY (review_item_id)',
};
// Link and grant rows are inserted or deleted, never edited: they keep one event timestamp
// (added_at, done_at, created_at) instead of created_at/updated_at and have no updated_at trigger.
const IMMUTABLE_ROW_TABLES = ['comment_tag', 'comment_done', 'role_grant'];
const GLOBAL_TABLES = [
  'organization',
  'app_user',
  'auth_session',
  'auth_account',
  'auth_verification',
];

// Credential-like columns that are allowed on purpose. Each one holds a hash,
// never a raw secret. Adding to this list needs review.
const ALLOWED_CREDENTIAL_COLUMNS: Record<string, string> = {
  'auth_account.password_hash': 'Better Auth scrypt hash (salted, slow); never plaintext',
  'auth_session.token':
    'SHA-256 digest of the session token; the raw token exists only in the cookie (apps/api auth contract test)',
  'invitation.token_hash': 'sha256 of a 32-byte random invitation token',
  'comment_classification.input_tokens': 'LLM token count, not a credential',
  'comment_classification.output_tokens': 'LLM token count, not a credential',
  'comment_classification.cache_read_tokens': 'LLM token count, not a credential',
  'policy_evaluation.input_tokens': 'LLM token count, not a credential',
  'policy_evaluation.output_tokens': 'LLM token count, not a credential',
  'policy_evaluation.cache_read_tokens': 'LLM token count, not a credential',
  'api_key.secret_sha256':
    'SHA-256 digest of a 256-bit random key secret; the plaintext is shown once at creation',
  'moderation_action.actor_api_key_id':
    'Reference to the api_key row that made the request, not a credential',
  'api_idempotency_record.api_key_id':
    'Reference to the api_key row the record is scoped to, not a credential',
  'webhook_endpoint.created_by_api_key_id':
    'Reference to the api_key row that created the endpoint, not a credential',
  'rule_change_proposal.proposed_by_api_key_id':
    'Reference to the api_key row that proposed the change, not a credential',
};

describe('schema conventions', () => {
  it('server encoding is UTF8', async () => {
    expect((await q<{ server_encoding: string }>('SHOW server_encoding'))[0]!.server_encoding).toBe(
      'UTF8',
    );
  });

  it('names are snake_case and fit in 63 bytes', async () => {
    const names = await q<{ n: string }>(`
      SELECT relname AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname <> '_prisma_migrations' AND relname NOT LIKE '%_seq'
      UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL SELECT attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> '_prisma_migrations'`);
    for (const { n } of names.filter(({ n }) => !n.startsWith('_prisma_migrations')))
      expect(n).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
  });

  it('constraint and index suffixes follow the convention', async () => {
    const cons = await q<{ conname: string; contype: string }>(
      `SELECT conname, contype FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    );
    const suffix: Record<string, RegExp> = { p: /_pkey$/, u: /_key$/, f: /_fkey$/, c: /_check$/ };
    for (const k of cons) if (suffix[k.contype]) expect(k.conname).toMatch(suffix[k.contype]!);
    const idx = await q<{ indexname: string }>(`
      SELECT i.indexname FROM pg_indexes i
       WHERE i.schemaname = 'public' AND i.tablename <> '_prisma_migrations'
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = i.indexname)`);
    for (const { indexname } of idx) expect(indexname).toMatch(/_(idx|key)$/);
  });

  it('every table has created_at and updated_at timestamptz NOT NULL', async () => {
    const rows = await q<{ t: string; ok: number }>(`
      SELECT c.relname AS t,
             count(*) FILTER (WHERE a.attname IN ('created_at','updated_at') AND a.attnotnull
                               AND format_type(a.atttypid, a.atttypmod) = 'timestamp(3) with time zone')::int AS ok
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
       GROUP BY 1`);
    for (const r of rows.filter((r) => !IMMUTABLE_ROW_TABLES.includes(r.t)))
      expect(r.ok, r.t).toBe(2);
  });

  it('every non-system table has a uuid id primary key with a random default', async () => {
    const rows = await q<{ t: string; pk: string | null; def: string | null }>(`
      SELECT c.relname AS t, pg_get_constraintdef(k.oid) AS pk, pg_get_expr(d.adbin, d.adrelid) AS def
        FROM pg_class c
        LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`);
    for (const r of rows) {
      expect(r.pk, r.t).not.toBeNull();
      if (SYSTEM_TABLES.includes(r.t)) continue;
      if (CONNECTION_KEYED_TABLES.includes(r.t)) {
        expect(r.pk, r.t).toBe('PRIMARY KEY (connection_id)');
        continue;
      }
      if (NATURAL_KEY_TABLES[r.t]) {
        expect(r.pk, r.t).toBe(NATURAL_KEY_TABLES[r.t]);
        continue;
      }
      expect(r.pk, r.t).toBe('PRIMARY KEY (id)');
      expect(r.def, r.t).toBe('gen_random_uuid()');
    }
  });

  it('every tenant table has organization_id NOT NULL', async () => {
    const rows = await q<{ t: string; has: boolean }>(`
      SELECT c.relname AS t, bool_or(a.attname = 'organization_id' AND a.attnotnull) AS has
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
       GROUP BY 1`);
    for (const r of rows)
      if (![...SYSTEM_TABLES, ...GLOBAL_TABLES].includes(r.t)) expect(r.has, r.t).toBe(true);
  });

  it('no lossy or legacy column types', async () => {
    const bad = await q<{ col: string }>(`
      SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS col
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND c.relname <> '_prisma_migrations'
         AND (a.atttypid IN ('timestamp'::regtype, 'varchar'::regtype, 'bpchar'::regtype, 'json'::regtype, 'money'::regtype)
              OR (a.atttypid IN ('int4'::regtype, 'int8'::regtype) AND a.attname = 'id'))`);
    expect(bad).toEqual([]);
  });

  it('no plaintext credential columns except the reviewed allowlist', async () => {
    const found = await q<{ col: string }>(`
      SELECT c.relname || '.' || a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname ~ '(token|secret|password|api_key|credential)'
         AND NOT (a.attname LIKE 'encrypted\\_%' AND a.atttypid = 'bytea'::regtype)`);
    const cols = found.map((r) => r.col).sort();
    expect(cols.filter((c) => !(c in ALLOWED_CREDENTIAL_COLUMNS))).toEqual([]);
    // The allowlist must not rot: every entry must still exist.
    expect(cols).toEqual(Object.keys(ALLOWED_CREDENTIAL_COLUMNS).sort());
  });

  it('every foreign key has an index led by its pointer (last) column', async () => {
    const missing = await q<{ fk: string }>(`
      SELECT k.conname AS fk FROM pg_constraint k
       WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = k.conrelid
                          AND i.indkey[0] = k.conkey[array_length(k.conkey, 1)])`);
    expect(missing).toEqual([]);
  });

  it('every mutable table has the updated_at trigger', async () => {
    const rows = await q<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
         AND c.relname NOT IN ('_prisma_migrations', 'decision', 'audit_event', ${IMMUTABLE_ROW_TABLES.map((t) => `'${t}'`).join(', ')})
         AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                          AND t.tgfoid = 'fb_set_updated_at'::regproc)`);
    expect(rows).toEqual([]);
  });
});
