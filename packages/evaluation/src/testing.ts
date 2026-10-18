// Integration-test helpers: seed comments and the rows an export reads, with explicit times.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Tenant } from '@feedbouncer/db/testing';
import { bodySha256 } from '@feedbouncer/rules';

export type SeededComment = { id: string; externalId: string; body: string; t: Tenant };

export async function seedEvalComment(
  c: pg.ClientBase,
  t: Tenant,
  o: {
    postedAt: Date;
    body?: string;
    ingestedAt?: Date;
    state?: 'visible' | 'hidden' | 'deleted';
    origin?: 'live' | 'backfill';
    own?: boolean;
    externalId?: string;
  },
): Promise<SeededComment> {
  const body = o.body ?? `comment ${randomUUID()}`;
  const externalId = o.externalId ?? `ext_${randomUUID().replaceAll('-', '')}`;
  const r = await c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id, body,
       platform_state, is_own_account, ingest_origin, posted_at, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))
     RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      externalId,
      t.authorId || null,
      body,
      o.state ?? 'visible',
      o.own ?? false,
      o.origin ?? 'live',
      o.postedAt,
      o.ingestedAt ?? null,
    ],
  );
  return { id: r.rows[0]!.id, externalId, body, t };
}

/** A rule_evaluation of the comment's current body (or `body`), created at `createdAt`. */
export async function seedEvalRuleEvaluation(
  c: pg.ClientBase,
  s: SeededComment,
  o: { createdAt: Date; body?: string; reviewMode?: boolean },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status, review_mode, created_at)
     VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6, 'v1', 'no_match', $7, $8) RETURNING id`,
    [
      s.t.organizationId,
      s.t.brandId,
      s.t.connectionId,
      s.id,
      bodySha256(o.body ?? s.body),
      `t-${randomUUID().slice(0, 12)}`,
      o.reviewMode ?? false,
      o.createdAt,
    ],
  );
  return r.rows[0]!.id;
}

export async function seedEvalAction(
  c: pg.ClientBase,
  s: SeededComment,
  o: {
    createdAt: Date;
    completedAt?: Date | null;
    kind?: string;
    status?: string;
    outcomeCode?: string;
    actorType?: string;
    requestKey?: string;
  },
): Promise<string> {
  const status = o.status ?? 'applied';
  const completedAt =
    status === 'pending'
      ? null
      : o.completedAt === undefined
        ? new Date(o.createdAt.getTime() + 1000)
        : o.completedAt;
  const r = await c.query<{ id: string }>(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
       request_key, status, outcome_code, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      s.t.organizationId,
      s.t.brandId,
      s.t.connectionId,
      s.id,
      o.kind ?? 'hide',
      o.actorType ?? 'classifier',
      o.requestKey ?? `clf-${randomUUID()}`,
      status,
      o.outcomeCode ?? null,
      o.createdAt,
      completedAt,
    ],
  );
  return r.rows[0]!.id;
}

/**
 * The common timeline: a comment posted at `postedAt`, evaluated 4 s later and hidden by the
 * classifier 9 s later (completed at 11 s). `hidden: false` stops after the evaluation.
 */
export async function seedHiddenTimeline(
  c: pg.ClientBase,
  t: Tenant,
  o: { postedAt: Date; body?: string; hidden?: boolean },
): Promise<SeededComment & { actionId: string | null }> {
  const sec = (n: number) => new Date(o.postedAt.getTime() + n * 1000);
  const hidden = o.hidden ?? true;
  const s = await seedEvalComment(c, t, {
    postedAt: o.postedAt,
    ingestedAt: sec(2),
    state: hidden ? 'hidden' : 'visible',
    ...(o.body !== undefined ? { body: o.body } : {}),
  });
  await seedEvalRuleEvaluation(c, s, { createdAt: sec(4) });
  const actionId = hidden
    ? await seedEvalAction(c, s, { createdAt: sec(9), completedAt: sec(11) })
    : null;
  return { ...s, actionId };
}
