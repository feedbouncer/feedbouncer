import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { CommentResource, FlaggedItemResource } from '@feedbouncer/public-api';
import { renderEvent } from './render.js';
import { WEBHOOK_PAYLOAD_SCHEMAS } from './payloads.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  h = await migratedDb();
});
afterAll(() => h.close());

async function tenant(label: string): Promise<Tenant> {
  const t = await seedTenant(h.c, label);
  await h.c.query(
    `INSERT INTO webhook_endpoint (organization_id, url, event_types, signing_key_id, encrypted_signing_secret)
     VALUES ($1, 'https://hooks.example.com/x', ARRAY['comment.received', 'comment.hidden', 'item.flagged'], 'k1', '\\x01')`,
    [t.organizationId],
  );
  return t;
}

async function comment(t: Tenant, body = 'hello'): Promise<string> {
  const { rows } = await h.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at, ingest_origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'live') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId, `c-${uuid()}`, body],
  );
  return rows[0]!.id;
}

async function eventId(t: Tenant, dedupe: string): Promise<string> {
  const { rows } = await h.c.query<{ id: string }>(
    'SELECT id FROM webhook_event WHERE organization_id = $1 AND dedupe_key = $2',
    [t.organizationId, dedupe],
  );
  return rows[0]!.id;
}

async function hide(
  t: Tenant,
  commentId: string,
  actor: { type: string; ruleId?: string; userId?: string },
): Promise<string> {
  const { rows } = await h.c.query<{ id: string }>(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, actor_user_id, rule_id, request_key)
     VALUES ($1, $2, $3, $4, 'hide', $5, $6, $7, $8) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      commentId,
      actor.type,
      actor.userId ?? null,
      actor.ruleId ?? null,
      `k:${uuid()}`,
    ],
  );
  await h.c.query(
    `UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1`,
    [rows[0]!.id],
  );
  await h.c.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [commentId]);
  return rows[0]!.id;
}

async function ok(t: Tenant, id: string) {
  const r = await renderEvent(h.c, t.organizationId, id);
  if (r.kind !== 'ok') throw new Error('expected an ok render');
  return { ...r, json: JSON.parse(r.body) as Record<string, any> };
}

describe('renderEvent', () => {
  it('renders comment.received with the public comment resource and nothing else', async () => {
    const t = await tenant('rcv');
    const c = await comment(t);
    const r = await ok(t, await eventId(t, `comment.received:${c}`));
    expect(r.type).toBe('comment.received');
    expect(WEBHOOK_PAYLOAD_SCHEMAS['comment.received'].parse(r.json)).toBeTruthy();
    expect(Object.keys(r.json.data.comment).sort()).toEqual(
      Object.keys(CommentResource.shape).sort(),
    );
    expect(r.json).toMatchObject({
      type: 'comment.received',
      organizationId: t.organizationId,
      createdAt: r.occurredAt.toISOString(),
      data: { comment: { id: c, text: 'hello', textTruncated: false } },
    });
    expect(r.body).not.toMatch(/\s{2}|\n/);
  });

  it('renders comment.hidden with the reason of the matching rule decision', async () => {
    const t = await tenant('hr');
    const c = await comment(t);
    await h.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1, $2, $3, 'hide', 'enforce', 'rule', $4, 'Matched the spam rule')`,
      [t.organizationId, t.brandId, c, t.ruleId],
    );
    const action = await hide(t, c, { type: 'rule', ruleId: t.ruleId });
    const r = await ok(t, await eventId(t, `comment.hidden:${action}`));
    expect(WEBHOOK_PAYLOAD_SCHEMAS['comment.hidden'].parse(r.json)).toBeTruthy();
    expect(r.json.data.comment.status).toBe('hidden');
    expect(r.json.data.hide).toMatchObject({
      actionId: action,
      source: 'rule',
      reason: 'Matched the spam rule',
      ruleId: t.ruleId,
    });
  });

  it('ignores decisions made after the action when picking the reason', async () => {
    const t = await tenant('hl');
    const c = await comment(t);
    const insert = (reason: string, at: string) =>
      h.c.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason, created_at)
         VALUES ($1, $2, $3, 'hide', 'enforce', 'rule', $4, $5, $6)`,
        [t.organizationId, t.brandId, c, t.ruleId, reason, at],
      );
    await insert('before', '2020-01-01T00:00:00Z');
    const action = await hide(t, c, { type: 'rule', ruleId: t.ruleId });
    await insert('after', '2999-01-01T00:00:00Z');
    const r = await ok(t, await eventId(t, `comment.hidden:${action}`));
    expect(r.json.data.hide.reason).toBe('before');
  });

  it.each([
    ['rule', 'Hidden by an automatic rule.'],
    ['classifier', 'Hidden by the AI classifier.'],
    ['policy', 'Hidden by a custom policy.'],
    ['system', 'Hidden by FeedBouncer.'],
    ['api_key', 'Hidden through the FeedBouncer API.'],
  ])('falls back to a fixed reason for %s without a decision', async (type, reason) => {
    const t = await tenant(`fb-${type}`);
    const c = await comment(t);
    const action = await hide(t, c, { type, ...(type === 'rule' && { ruleId: t.ruleId }) });
    const r = await ok(t, await eventId(t, `comment.hidden:${action}`));
    expect(r.json.data.hide).toMatchObject({
      source: type === 'api_key' ? 'api' : type,
      reason,
    });
    expect(WEBHOOK_PAYLOAD_SCHEMAS['comment.hidden'].parse(r.json)).toBeTruthy();
  });

  it('describes a user hide as a team member action', async () => {
    const t = await tenant('hu');
    const c = await comment(t);
    const action = await hide(t, c, { type: 'user', userId: t.userId });
    const r = await ok(t, await eventId(t, `comment.hidden:${action}`));
    expect(r.json.data.hide).toMatchObject({
      source: 'user',
      reason: 'Hidden by a team member.',
      ruleId: null,
    });
  });

  it('renders item.flagged with its comment', async () => {
    const t = await tenant('fl');
    const c = await comment(t);
    const { rows } = await h.c.query<{ id: string }>(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       VALUES ($1, $2, $3, $4, 'user') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, c],
    );
    const r = await ok(t, await eventId(t, `item.flagged:${rows[0]!.id}`));
    expect(WEBHOOK_PAYLOAD_SCHEMAS['item.flagged'].parse(r.json)).toBeTruthy();
    expect(Object.keys(r.json.data.flaggedItem).sort()).toEqual(
      Object.keys(FlaggedItemResource.shape).sort(),
    );
    expect(r.json.data.flaggedItem.comment.id).toBe(c);
  });

  it('renders webhook.test', async () => {
    const t = await tenant('test');
    const ep = (
      await h.c.query<{ id: string }>(
        'SELECT id FROM webhook_endpoint WHERE organization_id = $1',
        [t.organizationId],
      )
    ).rows[0]!.id;
    const { rows } = await h.c.query<{ id: string }>(
      `INSERT INTO webhook_event (organization_id, type, dedupe_key, test_endpoint_id, occurred_at)
       VALUES ($1, 'webhook.test', $2, $3, now()) RETURNING id`,
      [t.organizationId, `test:${uuid()}`, ep],
    );
    const r = await ok(t, rows[0]!.id);
    expect(WEBHOOK_PAYLOAD_SCHEMAS['webhook.test'].parse(r.json)).toBeTruthy();
    expect(r.json.data).toEqual({
      endpointId: ep,
      message: 'This is a test event from FeedBouncer.',
    });
  });

  it('truncates text beyond 10,000 code points and says so', async () => {
    const t = await tenant('long');
    const c = await comment(t, 'x'.repeat(12_000));
    const r = await ok(t, await eventId(t, `comment.received:${c}`));
    expect(r.json.data.comment.textTruncated).toBe(true);
    expect([...r.json.data.comment.text]).toHaveLength(10_000);
  });

  it('is gone for a deleted comment, an archived brand, a missing event and another organization', async () => {
    const t = await tenant('gone');
    const c = await comment(t);
    const id = await eventId(t, `comment.received:${c}`);
    const other = await tenant('gone-other');
    expect((await renderEvent(h.c, other.organizationId, id)).kind).toBe('gone');
    expect((await renderEvent(h.c, t.organizationId, uuid())).kind).toBe('gone');
    await h.c.query(`UPDATE brand SET archived_at = now() WHERE id = $1`, [t.brandId]);
    expect((await renderEvent(h.c, t.organizationId, id)).kind).toBe('gone');
    await h.c.query(`UPDATE brand SET archived_at = NULL WHERE id = $1`, [t.brandId]);
    expect((await renderEvent(h.c, t.organizationId, id)).kind).toBe('ok');
    await h.c.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c]);
    expect((await renderEvent(h.c, t.organizationId, id)).kind).toBe('gone');
  });

  it('is gone for a flagged item whose comment was deleted', async () => {
    const t = await tenant('flgone');
    const c = await comment(t);
    const { rows } = await h.c.query<{ id: string }>(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       VALUES ($1, $2, $3, $4, 'user') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, c],
    );
    const id = await eventId(t, `item.flagged:${rows[0]!.id}`);
    await h.c.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c]);
    expect((await renderEvent(h.c, t.organizationId, id)).kind).toBe('gone');
  });
});
