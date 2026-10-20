import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { Logger } from '@feedbouncer/service-runtime';
import { eraseSubject } from '../erase/erase.js';
import { writeSubjectExport } from '../export/export.js';
import type { PgPrivacyRequestStore } from './store.js';

const HOUR_MS = 3_600_000;

export interface PrivacyProcessorDeps {
  store: PgPrivacyRequestStore;
  pool: pg.Pool;
  /** PRIVACY_EXPORT_DIR. */
  exportDir: string;
  /** PRIVACY_EXPORT_TTL_HOURS: how long a finished export stays downloadable. */
  exportTtlHours: number;
  batchSize: number;
  log: Logger;
}

/**
 * Runs one export or erasure request to completion. Idempotent: a request that is no longer
 * queued is left alone. A failed attempt that will be retried puts the request back in the
 * queue; the last failed attempt fails it and wipes its identifiers. The thrown error and the
 * log carry no data, since error messages can echo identifiers.
 */
export async function processPrivacyRequest(
  d: PrivacyProcessorDeps,
  requestId: string,
  o: { finalAttempt: boolean } = { finalAttempt: true },
): Promise<void> {
  try {
    const req = await d.store.claim(requestId);
    if (!req) return;
    if (req.kind === 'export') {
      await mkdir(d.exportDir, { recursive: true, mode: 0o700 });
      // A crashed earlier attempt may have left its file behind; the write refuses to overwrite.
      const target = path.join(d.exportDir, `${req.id}.zip`);
      await rm(target, { force: true });
      await rm(`${target}.part`, { force: true });
      const r = await writeSubjectExport(d.pool, req.organizationId, req.id, req.subjects, {
        dir: d.exportDir,
      });
      await d.store.finish(req.id, {
        found: r.found,
        counts: r.counts,
        coverage: 'snapshot_at_generated_at',
        export: {
          bytes: r.bytes,
          sha256: r.sha256,
          expiresAt: new Date(Date.now() + d.exportTtlHours * HOUR_MS),
        },
      });
    } else {
      const r = await eraseSubject(d.pool, req.organizationId, req.subjects, {
        dryRun: req.mode === 'dry_run',
        keepRuleEntries:
          req.keepRuleEntriesReason === null ? null : { reason: req.keepRuleEntriesReason },
        batchSize: d.batchSize,
        log: d.log,
      });
      await d.store.finish(req.id, { found: r.found, counts: r.counts, coverage: r.coverage });
    }
  } catch (e) {
    d.log.error('privacy.request_failed', {
      requestId,
      errorCode: 'internal_error',
      finalAttempt: o.finalAttempt,
    });
    if (o.finalAttempt) await d.store.fail(requestId, 'internal_error');
    else await d.store.release(requestId);
    throw new Error('privacy_request_failed');
  }
}
