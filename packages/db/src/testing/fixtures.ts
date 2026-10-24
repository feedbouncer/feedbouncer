import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { adminUrl, createScratchDatabase, type ScratchDb } from './scratch-db.js';
import { runPrisma } from './prisma-cli.js';

export const uuid = randomUUID;

export async function migratedDb(): Promise<{
  db: ScratchDb;
  c: pg.Client;
  close(): Promise<void>;
}> {
  const db = await createScratchDatabase(adminUrl());
  const res = await runPrisma(['migrate', 'deploy'], db.url);
  if (res.code !== 0) {
    await db.drop();
    throw new Error(`migrate deploy failed:\n${res.stderr}`);
  }
  const c = await db.client();
  return {
    db,
    c,
    close: async () => {
      await c.end();
      await db.drop();
    },
  };
}

export interface Tenant {
  organizationId: string;
  userId: string;
  brandId: string;
  connectionId: string;
  sourceId: string;
  otherSourceId: string;
  authorId: string;
  ruleId: string;
}

const one = async (c: pg.ClientBase, sql: string, v: unknown[]) =>
  (await c.query<{ id: string }>(sql, v)).rows[0]!.id;

const columnExists = async (c: pg.ClientBase, table: string, column: string) =>
  (
    await c.query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      [table, column],
    )
  ).rowCount === 1;

/** Seeds whatever the applied migrations support; fields for later tables are '' until those exist. */
export async function seedTenant(
  c: pg.ClientBase,
  label: string,
  opts: { reviewMode?: 'on' | 'opted_out'; timezone?: string } = {},
): Promise<Tenant> {
  const has = async (t: string) =>
    (await c.query('SELECT to_regclass($1) AS t', [t])).rows[0].t !== null;
  const organizationId = await one(c, 'INSERT INTO organization (name) VALUES ($1) RETURNING id', [
    `Org ${label}`,
  ]);
  const userId = await one(c, 'INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
    `${label}-${uuid()}@example.test`,
  ]);
  await c.query(
    "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [organizationId, userId],
  );
  const brandId = await one(
    c,
    'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
    [organizationId, `Brand ${label}`],
  );
  if (opts.timezone !== undefined)
    await c.query('UPDATE brand SET timezone = $2, timezone_set_at = now() WHERE id = $1', [
      brandId,
      opts.timezone,
    ]);
  // Existing suites expect automation, so the connection is 'legacy' unless a mode is asked for.
  const cols = ['organization_id', 'brand_id', 'platform', 'external_account_id'];
  const vals = ['$1', '$2', "'facebook'", '$3'];
  if (await columnExists(c, 'connection', 'review_mode')) {
    cols.push('review_mode');
    vals.push(`'${opts.reviewMode ?? 'legacy'}'`);
    if (opts.reviewMode === 'on') {
      cols.push('review_mode_started_at', 'review_mode_ends_at');
      vals.push('now()', "now() + interval '168 hours'");
    }
  }
  const connectionId = await one(
    c,
    `INSERT INTO connection (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`,
    [organizationId, brandId, `page-${label}`],
  );
  const t: Tenant = {
    organizationId,
    userId,
    brandId,
    connectionId,
    sourceId: '',
    otherSourceId: '',
    authorId: '',
    ruleId: '',
  };
  if (await has('source')) {
    const src = (ext: string) =>
      one(
        c,
        "INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id) VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id",
        [organizationId, brandId, connectionId, ext],
      );
    t.sourceId = await src(`post-${label}-1`);
    t.otherSourceId = await src(`post-${label}-2`);
    t.authorId = await one(
      c,
      'INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [organizationId, brandId, connectionId, `psid-${label}`, `Author ${label}`],
    );
  }
  if (await has('rule')) {
    const hasActions = await columnExists(c, 'rule', 'actions');
    const conditions =
      '{"type":"link_domain","mode":"blocklist","domains":["bit.ly"],"exemptOwnDomains":true,"shorteners":"ignore","lookalikes":"match"}';
    t.ruleId = await one(
      c,
      hasActions
        ? `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions) VALUES ($1, $2, 'Scam links', '${conditions}', 'hide', '[{"type":"hide"}]') RETURNING id`
        : `INSERT INTO rule (organization_id, brand_id, name, conditions, action) VALUES ($1, $2, 'Scam links', '${conditions}', 'hide') RETURNING id`,
      [organizationId, brandId],
    );
  }
  return t;
}
