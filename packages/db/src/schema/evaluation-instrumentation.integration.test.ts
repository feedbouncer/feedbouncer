import { describe, expect, it } from 'vitest';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261018000100_evaluation_instrumentation';
const COLUMNS = [
  'job_ledger.first_claimed_at',
  'job_ledger.last_claimed_at',
  'comment_classification.input_tokens',
  'comment_classification.output_tokens',
  'comment_classification.cache_read_tokens',
  'policy_evaluation.input_tokens',
  'policy_evaluation.output_tokens',
  'policy_evaluation.cache_read_tokens',
];

describe('down.sql', () => {
  it('reverts cleanly', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const applied = await snapshotSchema(k);
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        // Migrations added after this one are rolled back first.
        for (const m of dirs.slice(dirs.indexOf(MIGRATION)).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: m,
          });
        const down = (await snapshotSchema(k)).join('\n');
        for (const column of COLUMNS) expect(down).not.toContain(column);
        expect(down).not.toMatch(/job_ledger_claimed_at_check|_tokens_check/);
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        expect(await snapshotSchema(k)).toEqual(applied);
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });
});
