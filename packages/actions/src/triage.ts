// Workspace tags, the done flag and bulk triage over comments. Every statement is scoped by
// organization; a comment outside the org (or on an archived brand) is "not found", the same as a
// missing one. Done and tags are internal state: nothing here talks to a platform.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';
import { recordAudit } from './services.js';
import {
  BULK_MAX,
  TAG_IDS_MAX,
  TAGS_PER_COMMENT,
  TAGS_PER_ORG,
  parseTagName,
  type TagNameError,
} from './triage-rules.js';

export {
  BULK_MAX,
  TAG_IDS_MAX,
  TAG_NAME_MAX,
  TAGS_PER_COMMENT,
  TAGS_PER_ORG,
  parseTagName,
  type TagNameError,
} from './triage-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);

export interface Tag {
  id: string;
  name: string;
  commentCount: number;
  createdAt: Date;
}

export type TriageOp =
  | { type: 'done' }
  | { type: 'reopen' }
  | { type: 'add_tags'; tagIds: string[] }
  | { type: 'remove_tags'; tagIds: string[] };

export type TriageItemStatus =
  | 'ok'
  | 'not_found'
  | 'comment_deleted'
  | 'comment_tag_limit'
  | 'unknown_tag';
export interface TriageItemResult {
  commentId: string;
  status: TriageItemStatus;
  changed: boolean;
}

interface TagRow {
  id: string;
  name: string;
  comment_count: string | number;
  created_at: Date;
}
const toTag = (r: TagRow): Tag => ({
  id: r.id,
  name: r.name,
  commentCount: Number(r.comment_count),
  createdAt: r.created_at,
});

const TAG_COLUMNS = `t.id, t.name, t.created_at,
  (SELECT count(*) FROM comment_tag ct WHERE ct.organization_id = t.organization_id AND ct.tag_id = t.id) AS comment_count`;

export class PgTriage {
  /** `beforeItem`: test-only hook awaited before each comment of `apply` is processed. */
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: { beforeItem?: (index: number) => Promise<void>; log?: Logger } = {},
  ) {}

  /** Brand scope of a comment in this org whose brand is not archived; null otherwise. */
  async commentScope(
    orgId: string,
    commentId: string,
  ): Promise<{ organizationId: string; brandId: string } | null> {
    if (!isUuid(commentId)) return null;
    const { rows } = await this.pool.query<{ brand_id: string }>(
      `SELECT c.brand_id FROM comment c
         JOIN brand b ON b.organization_id = c.organization_id AND b.id = c.brand_id
        WHERE c.organization_id = $1 AND c.id = $2 AND b.archived_at IS NULL`,
      [orgId, commentId],
    );
    return rows[0] ? { organizationId: orgId, brandId: rows[0].brand_id } : null;
  }

  async listTags(orgId: string): Promise<Tag[]> {
    const { rows } = await this.pool.query<TagRow>(
      `SELECT ${TAG_COLUMNS} FROM tag t WHERE t.organization_id = $1
        ORDER BY lower(t.name), t.id`,
      [orgId],
    );
    return rows.map(toTag);
  }

  async createTag(
    orgId: string,
    actorUserId: string,
    raw: string,
  ): Promise<
    | { status: 'created'; tag: Tag }
    | { status: 'invalid'; error: TagNameError }
    | { status: 'taken'; tag: Tag }
    | { status: 'limit' }
  > {
    const parsed = parseTagName(raw);
    if (!parsed.ok) return { status: 'invalid', error: parsed.error };
    return withTransaction(this.pool, async (tx) => {
      // Serialize creators per organization so the cap cannot be overshot by racing inserts.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`tag:${orgId}`]);
      const count = await tx.query<{ n: string }>(
        'SELECT count(*) AS n FROM tag WHERE organization_id = $1',
        [orgId],
      );
      if (Number(count.rows[0]!.n) >= TAGS_PER_ORG) return { status: 'limit' as const };
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO tag (organization_id, name, name_key, created_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, name_key) DO NOTHING RETURNING id`,
        [orgId, parsed.name, parsed.key, actorUserId],
      );
      const id =
        ins.rows[0]?.id ??
        (
          await tx.query<{ id: string }>(
            'SELECT id FROM tag WHERE organization_id = $1 AND name_key = $2',
            [orgId, parsed.key],
          )
        ).rows[0]!.id;
      const { rows } = await tx.query<TagRow>(
        `SELECT ${TAG_COLUMNS} FROM tag t WHERE t.organization_id = $1 AND t.id = $2`,
        [orgId, id],
      );
      const tag = toTag(rows[0]!);
      if (!ins.rows[0]) return { status: 'taken' as const, tag };
      await recordAudit(tx, {
        organizationId: orgId,
        actorUserId,
        action: 'tag.created',
        subjectType: 'tag',
        subjectId: id,
        details: { name: parsed.name },
      });
      return { status: 'created' as const, tag };
    });
  }

  async deleteTag(
    orgId: string,
    actorUserId: string,
    tagId: string,
    confirmCount: number,
  ): Promise<
    | { status: 'deleted'; removedFrom: number }
    | { status: 'not_found' }
    | { status: 'count_changed'; count: number }
  > {
    if (!isUuid(tagId)) return { status: 'not_found' };
    return withTransaction(this.pool, async (tx) => {
      // The row lock serializes against comment_tag inserts, which take a key-share lock on the
      // tag through the foreign key.
      const locked = await tx.query<{ name: string }>(
        'SELECT name FROM tag WHERE organization_id = $1 AND id = $2 FOR UPDATE',
        [orgId, tagId],
      );
      if (!locked.rows[0]) return { status: 'not_found' as const };
      const c = await tx.query<{ n: string }>(
        'SELECT count(*) AS n FROM comment_tag WHERE organization_id = $1 AND tag_id = $2',
        [orgId, tagId],
      );
      const count = Number(c.rows[0]!.n);
      if (count !== confirmCount) return { status: 'count_changed' as const, count };
      await tx.query('DELETE FROM tag WHERE organization_id = $1 AND id = $2', [orgId, tagId]);
      await recordAudit(tx, {
        organizationId: orgId,
        actorUserId,
        action: 'tag.deleted',
        subjectType: 'tag',
        subjectId: tagId,
        details: { name: locked.rows[0].name, removedFrom: count },
      });
      return { status: 'deleted' as const, removedFrom: count };
    });
  }

  /** Throws TypeError on > BULK_MAX ids or > TAG_IDS_MAX tags (the API validates first). Returns
   *  'unknown_tags' without changing anything when any tagId is not this org's. Results are in
   *  input order. */
  async apply(
    orgId: string,
    actorUserId: string,
    commentIds: string[],
    op: TriageOp,
  ): Promise<{ status: 'unknown_tags' } | { status: 'ok'; results: TriageItemResult[] }> {
    if (commentIds.length > BULK_MAX) throw new TypeError(`at most ${BULK_MAX} comments`);
    const tagIds = 'tagIds' in op ? [...new Set(op.tagIds)] : [];
    if (tagIds.length > TAG_IDS_MAX) throw new TypeError(`at most ${TAG_IDS_MAX} tags`);

    if (tagIds.length > 0) {
      const known = tagIds.every(isUuid)
        ? (
            await this.pool.query<{ id: string }>(
              'SELECT id FROM tag WHERE organization_id = $1 AND id = ANY($2::uuid[])',
              [orgId, tagIds],
            )
          ).rows.length
        : -1;
      if (known !== tagIds.length) return { status: 'unknown_tags' };
    }

    const results: TriageItemResult[] = [];
    for (const [i, commentId] of commentIds.entries()) {
      await this.opts.beforeItem?.(i);
      results.push(await this.#applyOne(orgId, actorUserId, commentId, op, tagIds));
    }
    this.opts.log?.info('triage.apply', {
      op: op.type,
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      changed: results.filter((r) => r.changed).length,
    });
    return { status: 'ok', results };
  }

  async #applyOne(
    orgId: string,
    actorUserId: string,
    commentId: string,
    op: TriageOp,
    tagIds: string[],
  ): Promise<TriageItemResult> {
    const result = (status: TriageItemStatus, changed = false) => ({ commentId, status, changed });
    if (!isUuid(commentId)) return result('not_found');
    try {
      return await withTransaction(this.pool, async (tx) => {
        // add_tags enforces a per-comment cap, so concurrent adds on one comment take an
        // exclusive (non-key) lock to count and insert one after another.
        const lock = op.type === 'add_tags' ? 'FOR NO KEY UPDATE OF c' : 'FOR SHARE OF c';
        const found = await tx.query<{ brand_id: string; platform_state: string }>(
          `SELECT c.brand_id, c.platform_state FROM comment c
             JOIN brand b ON b.organization_id = c.organization_id AND b.id = c.brand_id
            WHERE c.organization_id = $1 AND c.id = $2 AND b.archived_at IS NULL ${lock}`,
          [orgId, commentId],
        );
        const row = found.rows[0];
        if (!row) return result('not_found');
        if (row.platform_state === 'deleted') return result('comment_deleted');
        const brandId = row.brand_id;
        const audit = (action: string, details: Record<string, string> = {}) =>
          recordAudit(tx, {
            organizationId: orgId,
            brandId,
            actorUserId,
            action,
            subjectType: 'comment',
            subjectId: commentId,
            details,
          });

        switch (op.type) {
          case 'done': {
            const r = await tx.query(
              `INSERT INTO comment_done (organization_id, brand_id, comment_id, done_by_user_id)
               VALUES ($1, $2, $3, $4) ON CONFLICT (comment_id) DO NOTHING`,
              [orgId, brandId, commentId, actorUserId],
            );
            if (r.rowCount === 0) return result('ok');
            await audit('comment.marked_done');
            return result('ok', true);
          }
          case 'reopen': {
            const r = await tx.query(
              'DELETE FROM comment_done WHERE organization_id = $1 AND comment_id = $2',
              [orgId, commentId],
            );
            if (r.rowCount === 0) return result('ok');
            await audit('comment.reopened');
            return result('ok', true);
          }
          case 'add_tags': {
            const existing = await tx.query<{ tag_id: string }>(
              'SELECT tag_id FROM comment_tag WHERE comment_id = $1',
              [commentId],
            );
            const have = new Set(existing.rows.map((r) => r.tag_id));
            const fresh = tagIds.filter((t) => !have.has(t));
            if (have.size + fresh.length > TAGS_PER_COMMENT) return result('comment_tag_limit');
            const ins = await tx.query<{ tag_id: string }>(
              `INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id, added_by_user_id)
               SELECT $1, $2, $3, t, $4 FROM unnest($5::uuid[]) AS t
               ON CONFLICT (comment_id, tag_id) DO NOTHING RETURNING tag_id`,
              [orgId, brandId, commentId, actorUserId, tagIds],
            );
            for (const r of ins.rows) await audit('comment.tagged', { tagId: r.tag_id });
            return result('ok', ins.rows.length > 0);
          }
          case 'remove_tags': {
            const del = await tx.query<{ tag_id: string }>(
              `DELETE FROM comment_tag
                WHERE organization_id = $1 AND comment_id = $2 AND tag_id = ANY($3::uuid[])
                RETURNING tag_id`,
              [orgId, commentId, tagIds],
            );
            for (const r of del.rows) await audit('comment.untagged', { tagId: r.tag_id });
            return result('ok', del.rows.length > 0);
          }
        }
      });
    } catch (err) {
      // The tag was deleted between the lookup and the insert.
      if ((err as { code?: unknown } | null)?.code === '23503') return result('unknown_tag');
      throw err;
    }
  }
}
