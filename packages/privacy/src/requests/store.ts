import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { recordAudit, recordSystemAudit } from '@feedbouncer/actions';
import { withTransaction } from '@feedbouncer/db';
import { open, seal, type KeyProvider } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { SubjectList, type SubjectIdentifierT } from '../subject/identifier.js';

/** A running request silent this long is taken over: its processor is presumed dead. */
export const STALE_RUNNING_MS = 15 * 60_000;

export interface NewPrivacyRequest {
  organizationId: string;
  kind: 'export' | 'erasure';
  mode: 'dry_run' | 'execute';
  subjects: SubjectIdentifierT[];
  via: 'api' | 'cli';
  actorUserId: string | null;
  actorLabel: string | null;
  reference: string | null;
  keepRuleEntriesReason: string | null;
}

export interface ClaimedRequest {
  id: string;
  organizationId: string;
  kind: 'export' | 'erasure';
  mode: 'dry_run' | 'execute';
  subjects: SubjectIdentifierT[];
  keepRuleEntriesReason: string | null;
}

export interface FinishedRequest {
  found: boolean;
  counts: Record<string, number>;
  coverage: string;
  export?: { bytes: number; sha256: Buffer; expiresAt: Date };
}

/** Everything about a request except the identifiers, which are not readable after it finishes. */
export interface PrivacyRequestView {
  id: string;
  kind: 'export' | 'erasure';
  mode: 'dry_run' | 'execute';
  status: 'queued' | 'running' | 'done' | 'failed';
  requestedVia: 'api' | 'cli';
  actorUserId: string | null;
  actorLabel: string | null;
  reference: string | null;
  subjectCount: number;
  found: boolean | null;
  counts: Record<string, number>;
  coverage: string | null;
  errorCode: string | null;
  exportBytes: number | null;
  exportSha256: string | null;
  exportExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

interface ViewRow {
  id: string;
  kind: PrivacyRequestView['kind'];
  mode: PrivacyRequestView['mode'];
  status: PrivacyRequestView['status'];
  requested_via: PrivacyRequestView['requestedVia'];
  actor_user_id: string | null;
  actor_label: string | null;
  reference: string | null;
  subject_count: number;
  found: boolean | null;
  counts: Record<string, number>;
  coverage: string | null;
  error_code: string | null;
  export_bytes: string | null;
  export_sha256: Buffer | null;
  export_expires_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

const VIEW_COLUMNS = `id, kind, mode, status, requested_via, actor_user_id, actor_label, reference,
  subject_count, found, counts, coverage, error_code, export_bytes, export_sha256, export_expires_at,
  started_at, finished_at, created_at`;

const view = (r: ViewRow): PrivacyRequestView => ({
  id: r.id,
  kind: r.kind,
  mode: r.mode,
  status: r.status,
  requestedVia: r.requested_via,
  actorUserId: r.actor_user_id,
  actorLabel: r.actor_label,
  reference: r.reference,
  subjectCount: r.subject_count,
  found: r.found,
  counts: r.counts,
  coverage: r.coverage,
  errorCode: r.error_code,
  exportBytes: r.export_bytes === null ? null : Number(r.export_bytes),
  exportSha256: r.export_sha256?.toString('hex') ?? null,
  exportExpiresAt: r.export_expires_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
});

const sealContext = (organizationId: string, requestId: string) =>
  ({ organizationId, connectionId: requestId, kind: 'privacy_subject' }) as const;

type Audited = {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  requestId: string;
  details: Record<string, string | number | boolean | null | Record<string, number>>;
};

function audit(tx: pg.PoolClient, a: Audited): Promise<void> {
  const e = {
    organizationId: a.organizationId,
    action: a.action,
    subjectType: 'privacy_request',
    subjectId: a.requestId,
    details: { requestId: a.requestId, ...a.details },
  };
  return a.actorUserId === null
    ? recordSystemAudit(tx, e)
    : recordAudit(tx, { ...e, actorUserId: a.actorUserId });
}

const completedAction = (r: Pick<ClaimedRequest, 'kind' | 'mode'>) =>
  r.kind === 'export'
    ? 'privacy.export_completed'
    : r.mode === 'dry_run'
      ? 'privacy.erasure_dry_run_completed'
      : 'privacy.erasure_completed';

/**
 * Subject export and erasure requests. The identifiers are sealed (bound to the request id
 * and organization) from creation until the request finishes or fails, then wiped; no read
 * method returns them. Audit rows carry counts and flags only.
 */
export class PgPrivacyRequestStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
  ) {}

  async create(r: NewPrivacyRequest): Promise<{ id: string }> {
    const subjects = SubjectList.parse(r.subjects);
    const id = randomUUID();
    const { blob } = await seal(
      this.keys,
      new Secret(JSON.stringify(subjects)),
      sealContext(r.organizationId, id),
    );
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO privacy_request (id, organization_id, kind, mode, requested_via, actor_user_id,
                                      actor_label, reference, subjects_sealed, subject_count,
                                      keep_rule_entries_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          r.organizationId,
          r.kind,
          r.mode,
          r.via,
          r.actorUserId,
          r.actorLabel,
          r.reference,
          blob,
          subjects.length,
          r.keepRuleEntriesReason,
        ],
      );
      await audit(tx, {
        organizationId: r.organizationId,
        actorUserId: r.actorUserId,
        action: `privacy.${r.kind}_requested`,
        requestId: id,
        details: {
          mode: r.mode,
          subjectCount: subjects.length,
          reference: r.reference,
          keepRuleEntriesReason: r.keepRuleEntriesReason,
        },
      });
    });
    return { id };
  }

  /** Takes a queued (or abandoned running) request and opens its identifiers; null if there is none. */
  async claim(id: string): Promise<ClaimedRequest | null> {
    const { rows } = await this.pool.query<{
      organization_id: string;
      kind: ClaimedRequest['kind'];
      mode: ClaimedRequest['mode'];
      subjects_sealed: Buffer;
      keep_rule_entries_reason: string | null;
    }>(
      `UPDATE privacy_request SET status = 'running', started_at = now()
        WHERE id = $1 AND (status = 'queued'
              OR (status = 'running' AND started_at < now() - make_interval(secs => $2)))
       RETURNING organization_id, kind, mode, subjects_sealed, keep_rule_entries_reason`,
      [id, STALE_RUNNING_MS / 1000],
    );
    const r = rows[0];
    if (!r) return null;
    const opened = await open(this.keys, r.subjects_sealed, sealContext(r.organization_id, id));
    return {
      id,
      organizationId: r.organization_id,
      kind: r.kind,
      mode: r.mode,
      subjects: SubjectList.parse(JSON.parse(opened.reveal())),
      keepRuleEntriesReason: r.keep_rule_entries_reason,
    };
  }

  async finish(id: string, r: FinishedRequest): Promise<void> {
    await this.end(
      id,
      `status = 'done', found = $2, counts = $3::jsonb, coverage = $4,
       export_bytes = $5, export_sha256 = $6, export_expires_at = $7`,
      [
        r.found,
        JSON.stringify(r.counts),
        r.coverage,
        r.export?.bytes ?? null,
        r.export?.sha256 ?? null,
        r.export?.expiresAt ?? null,
      ],
      (q) => ({
        action: completedAction(q),
        details: { found: r.found, counts: r.counts, coverage: r.coverage },
      }),
    );
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await this.end(id, `status = 'failed', error_code = $2`, [errorCode], () => ({
      action: 'privacy.request_failed',
      details: {},
    }));
  }

  /** Marks a running request as alive, so it is not taken over as abandoned. */
  async heartbeat(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE privacy_request SET started_at = now() WHERE id = $1 AND status = 'running'",
      [id],
    );
  }

  /** Puts a running request back in the queue after a failed attempt that will be retried. */
  async release(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE privacy_request SET status = 'queued' WHERE id = $1 AND status = 'running'",
      [id],
    );
  }

  async get(organizationId: string, id: string): Promise<PrivacyRequestView | null> {
    const { rows } = await this.pool.query<ViewRow>(
      `SELECT ${VIEW_COLUMNS} FROM privacy_request WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    return rows[0] ? view(rows[0]) : null;
  }

  /** Newest first; `before` is the id of the last request of the previous page. */
  async list(
    organizationId: string,
    o: { limit: number; before?: string },
  ): Promise<PrivacyRequestView[]> {
    const { rows } = await this.pool.query<ViewRow>(
      `SELECT ${VIEW_COLUMNS} FROM privacy_request
        WHERE organization_id = $1
          AND ($3::uuid IS NULL OR (created_at, id) < (SELECT created_at, id FROM privacy_request
                                                       WHERE organization_id = $1 AND id = $3))
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [organizationId, o.limit, o.before ?? null],
    );
    return rows.map(view);
  }

  /** Requests still queued after `olderThanMs`, whose Redis job may have been lost. */
  async staleQueued(olderThanMs: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM privacy_request
        WHERE status = 'queued' AND created_at < now() - make_interval(secs => $1)
        ORDER BY created_at LIMIT 100`,
      [olderThanMs / 1000],
    );
    return rows.map((r) => r.id);
  }

  /** Requests left running past `olderThanMs`: their worker died and its retry found them still claimed. */
  async staleRunning(olderThanMs: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM privacy_request
        WHERE status = 'running' AND started_at < now() - make_interval(secs => $1)
        ORDER BY started_at LIMIT 100`,
      [olderThanMs / 1000],
    );
    return rows.map((r) => r.id);
  }

  /** Ends an open request, wipes its identifiers and audits it, in one transaction; a no-op once ended. */
  private async end(
    id: string,
    set: string,
    params: unknown[],
    outcome: (r: Pick<ClaimedRequest, 'kind' | 'mode'>) => {
      action: string;
      details: Audited['details'];
    },
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        organization_id: string;
        kind: ClaimedRequest['kind'];
        mode: ClaimedRequest['mode'];
        actor_user_id: string | null;
        reference: string | null;
        subject_count: number;
        duration_ms: number;
      }>(
        `UPDATE privacy_request SET ${set}, subjects_sealed = NULL, finished_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')
         RETURNING organization_id, kind, mode, actor_user_id, reference, subject_count,
                   round(extract(epoch FROM now() - coalesce(started_at, created_at)) * 1000)::int AS duration_ms`,
        [id, ...params],
      );
      const r = rows[0];
      if (!r) return;
      const { action, details } = outcome(r);
      await audit(tx, {
        organizationId: r.organization_id,
        actorUserId: r.actor_user_id,
        action,
        requestId: id,
        details: {
          mode: r.mode,
          subjectCount: r.subject_count,
          reference: r.reference,
          ...details,
          durationMs: r.duration_ms,
        },
      });
    });
  }
}
