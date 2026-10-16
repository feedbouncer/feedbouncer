// Integration-test helpers: comment, evaluation and moderation-action seeding.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Tenant } from '@feedbouncer/db/testing';

export interface Seeded {
  id: string;
  body: string;
  t: Tenant;
}

export const scopeOf = (t: Tenant, connectionId = t.connectionId) => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId,
});

export async function seedCommentRow(
  c: pg.ClientBase,
  tn: Tenant,
  body: string,
  o: { state?: string; own?: boolean; parentId?: string; authorId?: string } = {},
): Promise<Seeded> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, platform_state,
       is_own_account, parent_comment_id, author_id, ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'live', now()) RETURNING id`,
    [
      tn.organizationId,
      tn.brandId,
      tn.connectionId,
      tn.sourceId,
      `ext-${randomUUID()}`,
      body,
      o.state ?? 'visible',
      o.own ?? false,
      o.parentId ?? null,
      o.authorId ?? null,
    ],
  );
  return { id: r.rows[0]!.id, body, t: tn };
}

/** A rule_evaluation row for the comment; each call gets a distinct trigger key. */
export async function seedEvaluationRow(c: pg.ClientBase, s: Seeded): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), $5, 'v1', 'no_match') RETURNING id`,
    [s.t.organizationId, s.t.brandId, s.t.connectionId, s.id, `t-${randomUUID().slice(0, 12)}`],
  );
  return r.rows[0]!.id;
}

export async function seedModerationActionRow(
  c: pg.ClientBase,
  s: Seeded,
  o: {
    kind: string;
    actorType?: string;
    status?: string;
    replyText?: string;
    createdAt?: string;
  },
): Promise<string> {
  const status = o.status ?? 'applied';
  const reply =
    o.kind === 'public_reply' || o.kind === 'private_reply' ? (o.replyText ?? 'hi') : null;
  const r = await c.query<{ id: string }>(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
       request_key, reply_text, status, completed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 = 'pending' THEN NULL ELSE now() END,
       COALESCE($10::timestamptz, now())) RETURNING id`,
    [
      s.t.organizationId,
      s.t.brandId,
      s.t.connectionId,
      s.id,
      o.kind,
      o.actorType ?? 'rule',
      `k-${randomUUID()}`,
      reply,
      status,
      o.createdAt ?? null,
    ],
  );
  return r.rows[0]!.id;
}
