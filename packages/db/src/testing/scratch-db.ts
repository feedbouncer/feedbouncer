import { randomUUID } from 'node:crypto';
import pg from 'pg';

export function adminUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw)
    throw new Error('DATABASE_URL must be set for integration tests (see packages/db/README.md).');
  return new URL(raw);
}

export interface ScratchDb {
  name: string;
  url: URL;
  client(): Promise<pg.Client>;
  drop(): Promise<void>;
}

const SAFE = /^fb_test_[0-9a-f]{32}$/;
const ENCODINGS = { UTF8: 'UTF8', SQL_ASCII: 'SQL_ASCII' } as const;

async function admin<T>(url: URL, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url.href, application_name: 'db-integration-admin' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createScratchDatabase(
  adminDb: URL,
  opts: { encoding?: keyof typeof ENCODINGS } = {},
): Promise<ScratchDb> {
  const name = `fb_test_${randomUUID().replaceAll('-', '')}`;
  if (!SAFE.test(name)) throw new Error('unexpected scratch database name');
  const enc = ENCODINGS[opts.encoding ?? 'UTF8'];
  await admin(adminDb, (c) =>
    c.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE template0 ENCODING '${enc}'`),
  );
  const url = new URL(adminDb.href);
  url.pathname = `/${name}`;
  return {
    name,
    url,
    async client() {
      const c = new pg.Client({
        connectionString: url.href,
        application_name: 'db-integration-test',
      });
      await c.connect();
      return c;
    },
    drop: () =>
      admin(adminDb, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`),
      ).then(() => undefined),
  };
}
