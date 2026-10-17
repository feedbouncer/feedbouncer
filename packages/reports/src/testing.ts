// Integration-test seeds for the weekly report: ads, processed comments and attributed hides.
// Every row is written inside the tenant's organization and brand.
import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Category } from '@feedbouncer/classifier';
import type { Tenant } from '@feedbouncer/db/testing';

type Db = pg.ClientBase;

const id = async (c: Db, sql: string, values: unknown[]) =>
  (await c.query<{ id: string }>(sql, values)).rows[0]!.id;

const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');

const SCORES = JSON.stringify({
  spam: 0.9,
  scam_phishing: 0,
  harassment_abuse: 0,
  hate_speech: 0,
  sexual_content: 0,
  profanity: 0,
  self_promotion: 0,
});

/** A further ad_post source on the tenant's connection. */
export const seedSource = (c: Db, tn: Tenant): Promise<string> =>
  id(
    c,
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'ad_post', $4) RETURNING id`,
    [tn.organizationId, tn.brandId, tn.connectionId, `post-${randomUUID()}`],
  );

/** The brand's Meta ads connection, created on first use. */
async function adsConnection(c: Db, tn: Tenant): Promise<string> {
  const found = await c.query<{ id: string }>(
    `SELECT id FROM connection WHERE organization_id = $1 AND brand_id = $2 AND platform = 'meta_ads'
      ORDER BY created_at, id LIMIT 1`,
    [tn.organizationId, tn.brandId],
  );
  if (found.rows[0]) return found.rows[0].id;
  return id(
    c,
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
     VALUES ($1, $2, 'meta_ads', $3, 'active') RETURNING id`,
    [tn.organizationId, tn.brandId, `act_${digits(12)}`],
  );
}

/** A Meta ad linked to one source (the tenant's first by default). */
export async function seedAd(
  c: Db,
  tn: Tenant,
  o: {
    name?: string | null;
    externalId?: string;
    sourceId?: string;
    platform?: 'facebook' | 'instagram';
    deleted?: boolean;
  } = {},
): Promise<{ adId: string }> {
  const adId = await id(
    c,
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
       effective_status, active, facebook_resolution, instagram_resolution, last_discovered_at, name, deleted_at)
     VALUES ($1, $2, $3, $4, '1001', 'ACTIVE', true, 'linked', 'not_instagram', now(), $5,
       CASE WHEN $6 THEN now() END) RETURNING id`,
    [
      tn.organizationId,
      tn.brandId,
      await adsConnection(c, tn),
      o.externalId ?? digits(15),
      o.name === undefined ? 'Seeded ad' : o.name,
      o.deleted ?? false,
    ],
  );
  await c.query(
    `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
     VALUES ($1, $2, $3, $4, $5)`,
    [tn.organizationId, tn.brandId, adId, o.sourceId ?? tn.sourceId, o.platform ?? 'facebook'],
  );
  return { adId };
}

async function seedClassification(c: Db, tn: Tenant, commentId: string): Promise<string> {
  return id(
    c,
    `INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, status, provider, model, prompt_version, scores, policy, language, language_supported,
       input_chars, outcome)
     SELECT $1, $2, cm.connection_id, cm.id, decode(repeat('ab', 32), 'hex'), $4, 'classified', 'test', 'model',
            'v1', $5::jsonb, '[]'::jsonb, 'en', true, 10, 'hide'
       FROM comment cm
      WHERE cm.organization_id = $1 AND cm.brand_id = $2 AND cm.id = $3
     RETURNING id`,
    [tn.organizationId, tn.brandId, commentId, `rerun:${randomUUID()}`, SCORES],
  );
}

/** A comment posted at `postedAt`, processed by the classifier (default), a rule, or nothing. */
export async function seedProcessed(
  c: Db,
  tn: Tenant,
  o: { postedAt: Date; sourceId?: string; own?: boolean; via?: 'classifier' | 'rule' | 'none' },
): Promise<string> {
  const commentId = await id(
    c,
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
       is_own_account, ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'seeded comment', $6, 'live', $7) RETURNING id`,
    [
      tn.organizationId,
      tn.brandId,
      tn.connectionId,
      o.sourceId ?? tn.sourceId,
      `ext-${randomUUID()}`,
      o.own ?? false,
      o.postedAt,
    ],
  );
  const via = o.via ?? 'classifier';
  if (via === 'classifier') await seedClassification(c, tn, commentId);
  if (via === 'rule')
    await c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1, $2, $3, 'approve', 'enforce', 'rule', $4, 'Seeded rule decision.')`,
      [tn.organizationId, tn.brandId, commentId, tn.ruleId],
    );
  return commentId;
}

async function classifierDecision(
  c: Db,
  tn: Tenant,
  commentId: string,
  classificationId: string,
  category: Category,
  mode: 'enforce' | 'suggest',
): Promise<void> {
  await c.query(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider,
       classifier_model, category, classification_id, confidence, threshold, reason)
     VALUES ($1, $2, $3, 'hide', $4, 'classifier', 'test', 'model', $5, $6, 0.9, 0.8, 'Seeded classifier decision.')`,
    [tn.organizationId, tn.brandId, commentId, mode, category, classificationId],
  );
}

async function hideAction(
  c: Db,
  tn: Tenant,
  commentId: string,
  o: { actor: string; requestKey: string; at: Date; userId?: string; ruleId?: string },
): Promise<string> {
  return id(
    c,
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
       actor_user_id, rule_id, request_key, status, completed_at, created_at)
     SELECT $1, $2, cm.connection_id, cm.id, 'hide', $4, $5, $6, $7, 'applied', $8, $8
       FROM comment cm
      WHERE cm.organization_id = $1 AND cm.brand_id = $2 AND cm.id = $3
     RETURNING id`,
    [
      tn.organizationId,
      tn.brandId,
      commentId,
      o.actor,
      o.userId ?? null,
      o.ruleId ?? null,
      o.requestKey,
      o.at,
    ],
  );
}

/** An approved review-mode suggestion from the classifier, executed as a hide by the tenant's user. */
async function suggestionHide(
  c: Db,
  tn: Tenant,
  commentId: string,
  category: Category,
  at: Date,
): Promise<string> {
  const cls = await seedClassification(c, tn, commentId);
  await classifierDecision(c, tn, commentId, cls, category, 'suggest');
  const suggestionId = await id(
    c,
    `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256, status,
       decided_by_user_id, decided_at)
     SELECT $1, $2, cm.connection_id, cm.id, decode(repeat('ab', 32), 'hex'), 'approved', $4, $5
       FROM comment cm
      WHERE cm.organization_id = $1 AND cm.brand_id = $2 AND cm.id = $3
     RETURNING id`,
    [tn.organizationId, tn.brandId, commentId, tn.userId, at],
  );
  await c.query(
    `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref,
       steps, reason)
     VALUES ($1, $2, $3, 'classifier', $4, '[{"type":"hide"}]', 'Seeded suggestion.')`,
    [tn.organizationId, tn.brandId, suggestionId, cls],
  );
  const hideId = await hideAction(c, tn, commentId, {
    actor: 'user',
    userId: tn.userId,
    requestKey: `sug:${randomUUID()}`,
    at,
  });
  const runId = await id(
    c,
    `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, suggestion_id, dry_run,
       approved_by_user_id, completed_at)
     SELECT $1, $2, cm.connection_id, cm.id, $4, false, $5, $6
       FROM comment cm
      WHERE cm.organization_id = $1 AND cm.brand_id = $2 AND cm.id = $3
     RETURNING id`,
    [tn.organizationId, tn.brandId, commentId, suggestionId, tn.userId, at],
  );
  await c.query(
    `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status,
       moderation_action_id, completed_at)
     VALUES ($1, $2, $3, 0, 'hide', '{}', 'succeeded', $4, $5)`,
    [tn.organizationId, tn.brandId, runId, hideId, at],
  );
  return hideId;
}

async function ruleHide(c: Db, tn: Tenant, commentId: string, at: Date): Promise<string> {
  const evaluationId = await id(
    c,
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
       trigger_key, ruleset_version, status, matched_rule_id, outcome)
     SELECT $1, $2, cm.connection_id, cm.id, decode(repeat('ab', 32), 'hex'), $4, 'v1', 'decided', $5, 'hide'
       FROM comment cm
      WHERE cm.organization_id = $1 AND cm.brand_id = $2 AND cm.id = $3
     RETURNING id`,
    [tn.organizationId, tn.brandId, commentId, `t-${randomUUID().slice(0, 12)}`, tn.ruleId],
  );
  await c.query(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
       rule_evaluation_id, reason)
     VALUES ($1, $2, $3, 'hide', 'enforce', 'rule', $4, $5, 'Seeded rule decision.')`,
    [tn.organizationId, tn.brandId, commentId, tn.ruleId, evaluationId],
  );
  return hideAction(c, tn, commentId, {
    actor: 'rule',
    ruleId: tn.ruleId,
    requestKey: `rule-eval:${evaluationId}`,
    at,
  });
}

/**
 * An applied hide attributed to `by`, and the comment marked hidden.
 * classifier: classification + enforced decision (`category`, default spam) + `clf:` hide;
 * rule: evaluation + decision + `rule-eval:` hide; suggestion_classifier: an approved classifier
 * suggestion run by the tenant's user; person: a manual hide by that user.
 */
export async function seedHide(
  c: Db,
  tn: Tenant,
  commentId: string,
  o: {
    by: 'classifier' | 'rule' | 'policy' | 'person' | 'suggestion_classifier' | 'system';
    category?: Category;
    at?: Date;
  },
): Promise<{ hideActionId: string }> {
  const at = o.at ?? new Date();
  const category = o.category ?? 'spam';
  let hideActionId: string;
  switch (o.by) {
    case 'classifier': {
      const cls = await seedClassification(c, tn, commentId);
      await classifierDecision(c, tn, commentId, cls, category, 'enforce');
      hideActionId = await hideAction(c, tn, commentId, {
        actor: 'classifier',
        requestKey: `clf:${cls}`,
        at,
      });
      break;
    }
    case 'rule':
      hideActionId = await ruleHide(c, tn, commentId, at);
      break;
    case 'suggestion_classifier':
      hideActionId = await suggestionHide(c, tn, commentId, category, at);
      break;
    case 'person':
      hideActionId = await hideAction(c, tn, commentId, {
        actor: 'user',
        userId: tn.userId,
        requestKey: `user:${randomUUID()}`,
        at,
      });
      break;
    case 'policy':
    case 'system':
      hideActionId = await hideAction(c, tn, commentId, {
        actor: o.by,
        requestKey: `${o.by === 'policy' ? 'pol' : 'sys'}:${randomUUID()}`,
        at,
      });
      break;
  }
  await setState(c, tn, commentId, 'hidden');
  return { hideActionId };
}

/** An applied unhide by the tenant's user reversing the hide, a second after it; the comment is visible. */
export async function seedUnhide(c: Db, tn: Tenant, hideActionId: string): Promise<void> {
  const commentId = await id(
    c,
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type,
       actor_user_id, request_key, status, reverses_action_id, completed_at, created_at)
     SELECT h.organization_id, h.brand_id, h.connection_id, h.comment_id, 'unhide', 'user', $4, $5, 'applied',
            h.id, h.completed_at + interval '1 second', h.completed_at + interval '1 second'
       FROM moderation_action h
      WHERE h.organization_id = $1 AND h.brand_id = $2 AND h.id = $3 AND h.kind = 'hide'
     RETURNING comment_id AS id`,
    [tn.organizationId, tn.brandId, hideActionId, tn.userId, `unhide:${randomUUID()}`],
  );
  await setState(c, tn, commentId, 'visible');
}

/** Sets the comment's platform state, e.g. 'deleted' after a hide. */
export async function setState(
  c: Db,
  tn: Tenant,
  commentId: string,
  state: 'visible' | 'hidden' | 'deleted',
): Promise<void> {
  await c.query(
    'UPDATE comment SET platform_state = $4 WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
    [tn.organizationId, tn.brandId, commentId, state],
  );
}
