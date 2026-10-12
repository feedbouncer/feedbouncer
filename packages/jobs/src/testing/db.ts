import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';

type Database = Awaited<ReturnType<typeof migratedDb>>;
let shared: Promise<Database> | undefined;

export function jobsDatabase(): Promise<Database> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set for jobs integration tests.');
  }
  shared ??= migratedDb();
  return shared;
}

export async function closeJobsDatabase(): Promise<void> {
  const db = await shared;
  shared = undefined;
  await db?.close();
}

export type JobsTenant = Tenant & { youtubeConnectionId: string };

/** seedTenant (facebook connection) plus a youtube connection in the same brand. */
export async function seedJobsTenant(db: Database, label: string): Promise<JobsTenant> {
  const t = await seedTenant(db.c, label);
  const { rows } = await db.c.query<{ id: string }>(
    "INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1, $2, 'youtube', $3) RETURNING id",
    [t.organizationId, t.brandId, `chan-${label}`],
  );
  return { ...t, youtubeConnectionId: rows[0]!.id };
}
