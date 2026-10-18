import type pg from 'pg';

export interface AuditEventInput {
  organizationId: string;
  brandId?: string | null;
  actorType: 'user' | 'system' | 'api_key';
  actorUserId?: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  /** Ids, kinds and codes only: never URLs, emails, tokens or comment text. */
  details?: Record<string, string | number | boolean>;
}

/** Writes inside the caller's transaction, so the event commits or rolls back with the change. */
export async function recordAuditEvent(c: pg.ClientBase, e: AuditEventInput): Promise<void> {
  await c.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action, subject_type, subject_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      e.organizationId,
      e.brandId ?? null,
      e.actorType,
      e.actorUserId ?? null,
      e.action,
      e.subjectType,
      e.subjectId,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
