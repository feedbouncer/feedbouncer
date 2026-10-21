import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { UsageError } from '@feedbouncer/jobs';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { runPrivacy } from './privacy.js';

const X = 'X-psid-7711';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
let dir: string;
let A: Tenant;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'privacy-cli-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM organization');
  A = await seedTenant(h.c, 'a');
  dir = await mkdtemp(path.join(tmpdir(), 'fb-privacy-cli-'));
  const authorId = (
    await h.c.query<{ id: string }>(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, $4, 'Xenia') RETURNING id`,
      [A.organizationId, A.brandId, A.connectionId, X],
    )
  ).rows[0]!.id;
  await h.c.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id, body, permalink, posted_at)
     VALUES ($1, $2, $3, $4, 'c-1', $5, 'hello', 'https://facebook.example/c-1', now())`,
    [A.organizationId, A.brandId, A.connectionId, A.sourceId, authorId],
  );
  return () => rm(dir, { recursive: true, force: true });
});

async function run(...argv: string[]) {
  const out: string[] = [];
  const code = await runPrivacy(
    argv,
    {
      pool,
      keys: testKeyring(),
      log: silent,
      cwd: dir,
      exportDir: dir,
      exportTtlHours: 1,
      batchSize: 100,
    },
    { out: (l) => out.push(l) },
  );
  return { code, out, text: out.join('\n') };
}

const base = () => ['--org', A.organizationId, '--as', 'ops-1'];
const subject = ['--platform', 'facebook', '--external-id', X];
const count = async (table: string) =>
  Number((await h.c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

const authors = async () =>
  Number(
    (await h.c.query<{ n: string }>('SELECT count(*) AS n FROM author WHERE external_id = $1', [X]))
      .rows[0]!.n,
  );

describe('pnpm ops privacy', () => {
  it('erase --dry-run prints counts, changes nothing and never prints the identifier', async () => {
    const r = await run('erase', ...base(), ...subject, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/comments: 1/);
    expect(r.text).toMatch(/coverage: /);
    expect(r.text).not.toContain(X);
    expect(await count('comment')).toBe(1);
    expect(await authors()).toBe(1);
  });

  it('erase removes the subject', async () => {
    const r = await run('erase', ...base(), ...subject);
    expect(r.code).toBe(0);
    expect(await count('comment')).toBe(0);
    expect(await authors()).toBe(0);
  });

  it('export prints an absolute path under the export dir, and status reports it', async () => {
    const r = await run('export', ...base(), ...subject);
    expect(r.code).toBe(0);
    const id = /^request (\S+):/.exec(r.out[0]!)![1]!;
    expect(r.text).toContain(`file: ${path.join(dir, `${id}.zip`)}`);
    expect(r.text).not.toContain(X);
    const s = await run('status', '--org', A.organizationId, '--id', id);
    expect(s.text).toContain('export execute done');
  });

  it('reads identifiers from --subjects-file', async () => {
    const file = path.join(dir, 'subjects.json');
    await writeFile(file, JSON.stringify([{ platform: 'facebook', externalId: X }]));
    const r = await run('erase', ...base(), '--subjects-file', file, '--dry-run');
    expect(r.text).toMatch(/comments: 1/);
  });

  it.each([
    ['unknown subcommand', () => ['purge']],
    ['missing org', () => ['export', '--as', 'ops-1', ...subject]],
    [
      'bad label',
      () => ['export', '--org', '00000000-0000-4000-8000-000000000000', '--as', 'a b', ...subject],
    ],
    ['no identifiers', () => ['export', ...base(), '--platform', 'facebook']],
    ['bad platform', () => ['export', ...base(), '--platform', 'nope', '--external-id', X]],
    ['unknown flag', () => ['export', ...base(), ...subject, '--bogus']],
    ['erase-only flag on export', () => ['export', ...base(), ...subject, '--dry-run']],
    ['empty keep reason', () => ['erase', ...base(), ...subject, '--keep-rule-entries', ' ']],
  ])('rejects %s as a UsageError', async (_n, argv) => {
    await expect(run(...argv())).rejects.toBeInstanceOf(UsageError);
  });
});
