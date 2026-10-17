import { recordAuditEvent, type AuditEventInput } from '@feedbouncer/db';
import type pg from 'pg';

export interface AlertAuditEvent extends AuditEventInput {
  subjectType: 'alert_channel' | 'brand';
}

export async function recordAlertAudit(c: pg.ClientBase, e: AlertAuditEvent): Promise<void> {
  await recordAuditEvent(c, e);
}
