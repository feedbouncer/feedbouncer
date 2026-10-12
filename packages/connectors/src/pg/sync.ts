// Per-connection sync state in connection_sync. The tenant columns are copied
// from the connection row itself, never from the caller, so a wrong or
// foreign id can neither create a row nor attribute state to another tenant.
// Successes are coalesced in-process: at most one write per connection per
// window. A failure always writes and re-opens the window so the streak reset
// of the next success is not swallowed.
import type pg from 'pg';
import type { ErrorClass } from '@feedbouncer/service-runtime';
import type { SyncRecorder } from '../ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_TRACKED = 10_000;

const SUCCESS_SQL = `
  INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at, consecutive_failures)
  SELECT id, organization_id, brand_id, now(), 0 FROM connection WHERE id = $1::uuid
  ON CONFLICT (connection_id) DO UPDATE SET last_success_at = now(), consecutive_failures = 0`;
const FAILURE_SQL = `
  INSERT INTO connection_sync (connection_id, organization_id, brand_id,
                               last_failure_at, last_error_code, last_error_class, consecutive_failures)
  SELECT id, organization_id, brand_id, now(), $2, $3, 1 FROM connection WHERE id = $1::uuid
  ON CONFLICT (connection_id) DO UPDATE SET last_failure_at = now(), last_error_code = $2,
    last_error_class = $3, consecutive_failures = connection_sync.consecutive_failures + 1`;

export class PgSyncRecorder implements SyncRecorder {
  readonly #lastSuccess = new Map<string, number>();
  readonly #coalesceMs: number;
  readonly #now: () => number;

  constructor(
    private readonly pool: pg.Pool,
    opts: { coalesceMs?: number; now?: () => number } = {},
  ) {
    this.#coalesceMs = opts.coalesceMs ?? 10_000;
    this.#now = opts.now ?? Date.now;
  }

  async success(connectionId: string): Promise<void> {
    if (!UUID.test(connectionId)) return;
    const now = this.#now();
    const prev = this.#lastSuccess.get(connectionId);
    if (prev !== undefined && now - prev < this.#coalesceMs) return;
    await this.pool.query(SUCCESS_SQL, [connectionId]);
    if (this.#lastSuccess.size >= MAX_TRACKED) this.#lastSuccess.clear();
    this.#lastSuccess.set(connectionId, now);
  }

  async failure(
    connectionId: string,
    f: { readonly code: string; readonly errorClass: ErrorClass },
  ): Promise<void> {
    if (!UUID.test(connectionId)) return;
    this.#lastSuccess.delete(connectionId);
    await this.pool.query(FAILURE_SQL, [
      connectionId,
      CODE.test(f.code) ? f.code : 'unspecified',
      f.errorClass,
    ]);
  }
}
