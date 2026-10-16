// ModerationActions.request over the Pg comment store with a stub job
// producer. Every case checks both the returned result and the stored row.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  PRIVATE_REPLY_WINDOW_MS,
  type Clock,
  type ConnectorCapabilities,
  type NormalizedComment,
} from '@feedbouncer/connectors';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from './store.js';
import type { ActionActor, ActionKind } from './action-kinds.js';
import { ModerationActions } from './actions.js';
import { EXECUTE_JOB } from './jobs/specs.js';

const PAGE = '1000000001';
const IG_ACCOUNT = '17841400000000001';
const log = createLogger('comments-actions-test', 'error', () => {});
const META = {
  appId: '111',
  appSecret: new Secret('fb-app-secret-0123456789'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};
const capabilities = createFacebookConnector(META).capabilities;
const igCapabilities = createInstagramConnector({ meta: META }).capabilities;

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let other: Tenant;
let scope: ConnectionScope;
/** An Instagram connection in tenant t's brand. */
let igScope: ConnectionScope;
let store: PgCommentStore;
let nowMs = Date.UTC(2026, 9, 13, 12, 0, 0);
const clock: Clock = { now: () => nowMs };
let enqueue: ReturnType<typeof vi.fn>;
let actions: ModerationActions;
let seq = 0;

const user = (): ActionActor => ({ type: 'user', userId: t.userId });
const key = () => `rk-${randomUUID()}`;

async function seedComment(
  o: {
    authorId?: string | null;
    postedAt?: Date;
    state?: NormalizedComment['platformState'];
    tenant?: Tenant;
  } = {},
): Promise<string> {
  const tenant = o.tenant ?? t;
  const n = ++seq;
  const authorId = o.authorId === undefined ? String(3_000_000_000 + n) : o.authorId;
  const r = await store.upsertFromPlatform(
    {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      connectionId: tenant.connectionId,
    },
    {
      externalId: `${PAGE}_1_${n}`,
      sourceExternalId: `${PAGE}_1`,
      parentExternalId: null,
      author:
        authorId === null ? null : { externalId: authorId, displayName: 'A', profileUrl: null },
      body: 'hello',
      postedAt: o.postedAt ?? new Date(nowMs - 60_000),
      platformState: o.state ?? 'visible',
      permalink: null,
    },
    { ownAccountExternalId: PAGE, syncedAt: new Date(nowMs) },
  );
  return r.commentId;
}

/** An Instagram comment on media 17900000000000001 of the tenant's Instagram connection. */
async function seedIgComment(
  o: {
    parentExternalId?: string | null;
    state?: NormalizedComment['platformState'];
    authorId?: string | null;
    postedAt?: Date;
  } = {},
): Promise<string> {
  const n = ++seq;
  const authorId = o.authorId === undefined ? `178414990${String(n).padStart(8, '0')}` : o.authorId;
  const r = await store.upsertFromPlatform(
    igScope,
    {
      externalId: `178000000${String(n).padStart(8, '0')}`,
      sourceExternalId: '17900000000000001',
      parentExternalId: o.parentExternalId ?? null,
      author:
        authorId === null
          ? null
          : { externalId: authorId, displayName: 'someone', profileUrl: null },
      body: 'hello from instagram',
      postedAt: o.postedAt ?? new Date(nowMs - 60_000),
      platformState: o.state ?? 'visible',
      permalink: null,
    },
    { ownAccountExternalId: IG_ACCOUNT, syncedAt: new Date(nowMs) },
  );
  return r.commentId;
}

const rowsFor = async (commentId: string) =>
  (
    await pool.query(
      `SELECT id, kind, status, outcome_code, request_key, reply_text, actor_type, actor_user_id,
              rule_id, completed_at
         FROM moderation_action WHERE comment_id = $1 ORDER BY created_at, id`,
      [commentId],
    )
  ).rows;

const request = (
  commentId: string,
  kind: ActionKind,
  o: { actor?: ActionActor; requestKey?: string; text?: string } = {},
) =>
  actions.request({
    scope: t,
    commentId,
    kind,
    actor: o.actor ?? user(),
    requestKey: o.requestKey ?? key(),
    ...(o.text !== undefined ? { text: o.text } : {}),
  });

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-actions-test',
    onIdleError: () => {},
  });
  t = await seedTenant(ctx.c, 'act');
  other = await seedTenant(ctx.c, 'oth');
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    PAGE,
    t.connectionId,
  ]);
  const ig = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'instagram', $3) RETURNING id`,
    [t.organizationId, t.brandId, IG_ACCOUNT],
  );
  igScope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: ig.rows[0]!.id };
  store = new PgCommentStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(() => {
  nowMs += 1_000;
  enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }));
  actions = new ModerationActions({
    pool,
    store,
    producer: { enqueue } as never,
    capabilities: (p) =>
      p === 'facebook' ? capabilities : p === 'instagram' ? igCapabilities : undefined,
    clock,
    log,
  });
});

describe('ModerationActions.request', () => {
  it('accepts a hide on a visible comment and enqueues exactly once per request key', async () => {
    const commentId = await seedComment();
    const requestKey = key();
    const r = await request(commentId, 'hide', { requestKey });
    expect(r).toMatchObject({
      status: 'accepted',
      action: {
        commentId,
        kind: 'hide',
        actorType: 'user',
        actorUserId: t.userId,
        status: 'pending',
        outcomeCode: null,
        replyText: null,
        undoKind: null,
        completedAt: null,
      },
    });
    const rows = await rowsFor(commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', request_key: requestKey, kind: 'hide' });
    if (r.status !== 'accepted') throw new Error('unreachable');
    expect(rows[0].id).toBe(r.action.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      scope,
      platform: 'facebook',
      type: EXECUTE_JOB.type,
      payload: { actionId: r.action.id },
    });
  });

  it('same request key twice returns the same action and does not insert twice', async () => {
    const commentId = await seedComment();
    const requestKey = key();
    const a = await request(commentId, 'hide', { requestKey });
    const b = await request(commentId, 'hide', { requestKey });
    expect(a.status).toBe('accepted');
    expect(b).toEqual(a);
    expect(await rowsFor(commentId)).toHaveLength(1);
    // Still pending: re-enqueued (the producer dedupes by action id).
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);

    // Completed actions come back as they are, without another enqueue.
    await pool.query(
      "UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE request_key = $1",
      [requestKey],
    );
    const c = await request(commentId, 'hide', { requestKey });
    expect(c).toMatchObject({ status: 'accepted', action: { status: 'applied' } });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('marks the action failed when it cannot be queued, so a private reply can be retried', async () => {
    const commentId = await seedComment();
    enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(request(commentId, 'private_reply', { text: 'hello' })).rejects.toThrow(
      'redis down',
    );
    const rows = await rowsFor(commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', outcome_code: 'enqueue_failed' });

    const retry = await request(commentId, 'private_reply', { text: 'hello' });
    expect(retry).toMatchObject({ status: 'accepted', action: { status: 'pending' } });
  });

  it('request key reused for another kind -> refused request_key_conflict', async () => {
    const commentId = await seedComment();
    const requestKey = key();
    await request(commentId, 'hide', { requestKey });
    expect(await request(commentId, 'delete', { requestKey })).toEqual({
      status: 'refused',
      code: 'request_key_conflict',
    });
    // Another comment with the same key conflicts too.
    expect(await request(await seedComment(), 'hide', { requestKey })).toEqual({
      status: 'refused',
      code: 'request_key_conflict',
    });
    expect(await rowsFor(commentId)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('hide on an already hidden comment is recorded as noop already_hidden, not enqueued', async () => {
    const commentId = await seedComment({ state: 'hidden' });
    const r = await request(commentId, 'hide');
    expect(r).toMatchObject({
      status: 'recorded',
      action: { status: 'noop', outcomeCode: 'already_hidden', completedAt: expect.any(Date) },
    });
    expect(await rowsFor(commentId)).toMatchObject([
      { status: 'noop', outcome_code: 'already_hidden' },
    ]);
    const visible = await seedComment();
    expect(await request(visible, 'unhide')).toMatchObject({
      status: 'recorded',
      action: { status: 'noop', outcomeCode: 'already_visible' },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('comment-targeted actions on a deleted comment are noop already_deleted', async () => {
    const commentId = await seedComment({ state: 'deleted' });
    for (const kind of ['hide', 'unhide', 'delete', 'public_reply', 'private_reply'] as const) {
      const r = await request(
        commentId,
        kind,
        kind === 'public_reply' || kind === 'private_reply' ? { text: 'hi' } : {},
      );
      expect(r).toMatchObject({
        status: 'recorded',
        action: { kind, status: 'noop', outcomeCode: 'already_deleted' },
      });
    }
    expect((await rowsFor(commentId)).map((r) => r.outcome_code)).toEqual(
      Array(5).fill('already_deleted'),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ban and unban by author are accepted on a deleted comment', async () => {
    const commentId = await seedComment({ state: 'deleted' });
    for (const kind of ['ban_author', 'unban_author'] as const)
      expect(await request(commentId, kind)).toMatchObject({
        status: 'accepted',
        action: { kind, status: 'pending', outcomeCode: null },
      });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('stores reverses_action_id for an action of the same brand only', async () => {
    const commentId = await seedComment();
    const hide = await request(commentId, 'hide');
    const hideId = (hide as { action: { id: string } }).action.id;
    await pool.query(
      `UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1`,
      [hideId],
    );
    await pool.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [commentId]);
    const r = await actions.request({
      scope: t,
      commentId,
      kind: 'unhide',
      actor: user(),
      requestKey: key(),
      reverses: hideId,
    });
    expect(r).toMatchObject({ status: 'accepted' });
    const { rows } = await pool.query(
      `SELECT reverses_action_id FROM moderation_action WHERE id = $1`,
      [(r as { action: { id: string } }).action.id],
    );
    expect(rows[0].reverses_action_id).toBe(hideId);

    const foreign = await actions.request({
      scope: other,
      commentId: await seedComment({ tenant: other }),
      kind: 'hide',
      actor: { type: 'user', userId: other.userId },
      requestKey: key(),
      reverses: hideId,
    });
    expect(foreign).toEqual({ status: 'refused', code: 'not_found' });
    await expect(
      actions.request({
        scope: t,
        commentId,
        kind: 'unhide',
        actor: user(),
        requestKey: key(),
        reverses: 'nope',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('a ban made before the comment was deleted can still be undone', async () => {
    const commentId = await seedComment();
    expect(await request(commentId, 'ban_author')).toMatchObject({ status: 'accepted' });
    await pool.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [commentId]);
    expect(await request(commentId, 'unban_author')).toMatchObject({
      status: 'accepted',
      action: { kind: 'unban_author', status: 'pending' },
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('rule actor on a page-authored comment -> not_eligible own_account_comment', async () => {
    const commentId = await seedComment({ authorId: PAGE });
    const r = await request(commentId, 'hide', { actor: { type: 'rule', ruleId: t.ruleId } });
    expect(r).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'own_account_comment', actorType: 'rule' },
    });
    expect(await rowsFor(commentId)).toMatchObject([
      { status: 'not_eligible', outcome_code: 'own_account_comment', rule_id: t.ruleId },
    ]);
    expect(await request(commentId, 'hide', { actor: { type: 'classifier' } })).toMatchObject({
      status: 'recorded',
      action: { outcomeCode: 'own_account_comment' },
    });
    // A person may still hide the Page's own comment.
    expect(await request(commentId, 'hide')).toMatchObject({ status: 'accepted' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts a policy actor and stores actor_type policy', async () => {
    const commentId = await seedComment();
    const r = await request(commentId, 'hide', { actor: { type: 'policy' } });
    expect(r.status).toBe('accepted');
    expect(await rowsFor(commentId)).toMatchObject([
      { actor_type: 'policy', rule_id: null, actor_user_id: null },
    ]);
  });

  it('user ban on a page-authored comment -> not_eligible author_is_page', async () => {
    const commentId = await seedComment({ authorId: PAGE });
    for (const kind of ['ban_author', 'unban_author'] as const)
      expect(await request(commentId, kind)).toMatchObject({
        status: 'recorded',
        action: { kind, status: 'not_eligible', outcomeCode: 'author_is_page' },
      });
    expect(await rowsFor(commentId)).toHaveLength(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ban with no stored author -> not_eligible author_unavailable', async () => {
    const commentId = await seedComment({ authorId: null });
    expect(await request(commentId, 'ban_author')).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'author_unavailable' },
    });
    expect(await request(commentId, 'private_reply', { text: 'hi' })).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'author_unavailable' },
    });
    expect(await rowsFor(commentId)).toMatchObject([
      { kind: 'ban_author', status: 'not_eligible' },
      { kind: 'private_reply', status: 'not_eligible' },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('private reply after 7 days -> not_eligible private_reply_window_closed', async () => {
    const closed = await seedComment({ postedAt: new Date(nowMs - PRIVATE_REPLY_WINDOW_MS) });
    expect(await request(closed, 'private_reply', { text: 'hi' })).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'private_reply_window_closed' },
    });
    expect(await rowsFor(closed)).toMatchObject([
      { status: 'not_eligible', outcome_code: 'private_reply_window_closed', reply_text: 'hi' },
    ]);
    const open = await seedComment({ postedAt: new Date(nowMs - PRIVATE_REPLY_WINDOW_MS + 1) });
    expect(await request(open, 'private_reply', { text: '  hi  ' })).toMatchObject({
      status: 'accepted',
      action: { status: 'pending', replyText: 'hi' },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('second private reply -> not_eligible private_reply_already_sent (even under a concurrent race: run two requests with Promise.all)', async () => {
    const commentId = await seedComment();
    expect(await request(commentId, 'private_reply', { text: 'one' })).toMatchObject({
      status: 'accepted',
    });
    expect(await request(commentId, 'private_reply', { text: 'two' })).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'private_reply_already_sent' },
    });

    const raced = await seedComment();
    const results = await Promise.all([
      request(raced, 'private_reply', { text: 'a' }),
      request(raced, 'private_reply', { text: 'b' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'recorded']);
    const rows = await rowsFor(raced);
    expect(rows.map((r) => r.status).sort()).toEqual(['not_eligible', 'pending']);
    expect(rows.find((r) => r.status === 'not_eligible')).toMatchObject({
      outcome_code: 'private_reply_already_sent',
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('connection reconnect_required -> refused connection_needs_reconnect; nothing recorded', async () => {
    const commentId = await seedComment();
    try {
      await ctx.c.query(
        "UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1",
        [t.connectionId],
      );
      expect(await request(commentId, 'hide')).toEqual({
        status: 'refused',
        code: 'connection_needs_reconnect',
      });
      await ctx.c.query(
        "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE id = $1",
        [t.connectionId],
      );
      expect(await request(commentId, 'hide')).toEqual({
        status: 'refused',
        code: 'connection_inactive',
      });
      expect(await rowsFor(commentId)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await ctx.c.query(
        "UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1",
        [t.connectionId],
      );
    }
  });

  it('comment from another brand -> refused not_found', async () => {
    const foreign = await seedComment({ tenant: other });
    expect(await request(foreign, 'hide')).toEqual({ status: 'refused', code: 'not_found' });
    expect(await request(randomUUID(), 'hide')).toEqual({ status: 'refused', code: 'not_found' });
    expect(await request('not-a-uuid', 'hide')).toEqual({ status: 'refused', code: 'not_found' });
    expect(await rowsFor(foreign)).toHaveLength(0);
    expect(await actions.list(t, foreign)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a kind the platform does not support -> refused unsupported', async () => {
    const commentId = await seedComment();
    const limited = new ModerationActions({
      pool,
      store,
      producer: { enqueue } as never,
      capabilities: () => ({ ...(capabilities as ConnectorCapabilities), responses: [] }),
      clock,
      log,
    });
    expect(
      await limited.request({
        scope: t,
        commentId,
        kind: 'public_reply',
        actor: user(),
        requestKey: key(),
        text: 'hi',
      }),
    ).toEqual({ status: 'refused', code: 'unsupported' });
    expect(await rowsFor(commentId)).toHaveLength(0);
  });

  it('rejects malformed request keys and reply text before touching storage', async () => {
    const commentId = await seedComment();
    for (const bad of ['', 'a b', 'x'.repeat(129), 'é'])
      await expect(request(commentId, 'hide', { requestKey: bad })).rejects.toBeInstanceOf(
        TypeError,
      );
    for (const text of [undefined, '   ', 'a\u0000b', 'x'.repeat(8001)])
      await expect(
        request(commentId, 'public_reply', text === undefined ? {} : { text }),
      ).rejects.toBeInstanceOf(TypeError);
    await expect(request(commentId, 'hide', { text: 'hi' })).rejects.toBeInstanceOf(TypeError);
    expect(await rowsFor(commentId)).toHaveLength(0);
  });

  it('recorded outcomes are audited without reply text; list returns the history oldest first', async () => {
    const commentId = await seedComment({ state: 'deleted' });
    const r = await request(commentId, 'public_reply', { text: 'secret reply words' });
    if (r.status !== 'recorded') throw new Error('expected recorded');
    const audit = await pool.query(
      `SELECT actor_type, actor_user_id, action, subject_type, subject_id, brand_id, details
         FROM audit_event WHERE organization_id = $1 AND details->>'actionId' = $2`,
      [t.organizationId, r.action.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'user',
        actor_user_id: t.userId,
        action: 'comment.moderated',
        subject_type: 'comment',
        subject_id: commentId,
        brand_id: t.brandId,
        details: {
          actionId: r.action.id,
          kind: 'public_reply',
          status: 'noop',
          outcomeCode: 'already_deleted',
        },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('secret reply');
    await request(commentId, 'hide');
    expect((await actions.list(t, commentId)).map((a) => a.kind)).toEqual(['public_reply', 'hide']);
  });
  it('instagram: private reply on a nested reply is recorded not_eligible private_reply_nested_comment and not enqueued', async () => {
    const top = await seedIgComment();
    const topExternal = (await store.load(t, top))!.externalId;
    const nested = await seedIgComment({ parentExternalId: topExternal });
    expect(await request(nested, 'private_reply', { text: 'hi there' })).toMatchObject({
      status: 'recorded',
      action: {
        kind: 'private_reply',
        status: 'not_eligible',
        outcomeCode: 'private_reply_nested_comment',
        completedAt: expect.any(Date),
      },
    });
    expect(await rowsFor(nested)).toMatchObject([
      {
        kind: 'private_reply',
        status: 'not_eligible',
        outcome_code: 'private_reply_nested_comment',
      },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    // The top-level comment itself may be replied to privately.
    expect(await request(top, 'private_reply', { text: 'hi there' })).toMatchObject({
      status: 'accepted',
      action: { status: 'pending' },
    });
    expect(enqueue).toHaveBeenCalledWith({
      scope: igScope,
      platform: 'instagram',
      type: EXECUTE_JOB.type,
      payload: { actionId: expect.any(String) },
    });
  });

  it('instagram: public reply on a hidden comment -> not_eligible reply_to_hidden_comment', async () => {
    const hidden = await seedIgComment({ state: 'hidden' });
    expect(await request(hidden, 'public_reply', { text: 'thanks' })).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'reply_to_hidden_comment' },
    });
    expect(await rowsFor(hidden)).toMatchObject([
      { kind: 'public_reply', status: 'not_eligible', outcome_code: 'reply_to_hidden_comment' },
    ]);
    // Unhiding stays possible.
    expect(await request(hidden, 'unhide')).toMatchObject({ status: 'accepted' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('instagram: hide on the account own comment -> not_eligible own_comment_always_visible', async () => {
    const own = await seedIgComment({ authorId: IG_ACCOUNT });
    expect((await store.load(t, own))?.isOwnAccount).toBe(true);
    expect(await request(own, 'hide')).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'own_comment_always_visible' },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('instagram: ban_author -> refused unsupported', async () => {
    const commentId = await seedIgComment();
    for (const kind of ['ban_author', 'unban_author'] as const)
      expect(await request(commentId, kind)).toEqual({ status: 'refused', code: 'unsupported' });
    expect(await rowsFor(commentId)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('instagram: 2201-code-point public reply -> refused text_too_long, no row inserted', async () => {
    const commentId = await seedIgComment();
    // Astral characters: 2201 code points are 4402 UTF-16 units, inside the generic 8000 limit.
    expect(await request(commentId, 'public_reply', { text: '😀'.repeat(2201) })).toEqual({
      status: 'refused',
      code: 'text_too_long',
      max: 2200,
    });
    expect(await request(commentId, 'private_reply', { text: 'x'.repeat(1001) })).toEqual({
      status: 'refused',
      code: 'text_too_long',
      max: 1000,
    });
    // Refused before anything is recorded, even when the outcome would have been a noop.
    const deleted = await seedIgComment({ state: 'deleted' });
    expect(await request(deleted, 'public_reply', { text: 'y'.repeat(2201) })).toEqual({
      status: 'refused',
      code: 'text_too_long',
      max: 2200,
    });
    expect(await rowsFor(commentId)).toHaveLength(0);
    expect(await rowsFor(deleted)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();

    // Exactly at the limits is accepted.
    expect(await request(commentId, 'public_reply', { text: '😀'.repeat(2200) })).toMatchObject({
      status: 'accepted',
    });
    expect(await request(commentId, 'private_reply', { text: 'x'.repeat(1000) })).toMatchObject({
      status: 'accepted',
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('instagram: two concurrent private replies -> exactly one pending, one private_reply_already_sent', async () => {
    const commentId = await seedIgComment();
    expect((await store.load(t, commentId))?.privateReplied).toBe(false);
    const results = await Promise.all([
      request(commentId, 'private_reply', { text: 'a' }),
      request(commentId, 'private_reply', { text: 'b' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'recorded']);
    const rows = await rowsFor(commentId);
    expect(rows.map((r) => r.status).sort()).toEqual(['not_eligible', 'pending']);
    expect(rows.find((r) => r.status === 'not_eligible')).toMatchObject({
      outcome_code: 'private_reply_already_sent',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await store.load(t, commentId))?.privateReplied).toBe(true);
    const listed = await store.list(t, {
      before: null,
      limit: 100,
      connectionId: igScope.connectionId,
    });
    expect(listed.find((r) => r.id === commentId)?.privateReplied).toBe(true);
    // A third request sees the stored reply without racing.
    expect(await request(commentId, 'private_reply', { text: 'c' })).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'private_reply_already_sent' },
    });
  });

  it('instagram: comment in brand A requested from brand B scope -> refused not_found', async () => {
    const commentId = await seedIgComment();
    const brandB = await ctx.c.query<{ id: string }>(
      'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
      [t.organizationId, `Brand B ${randomUUID()}`],
    );
    for (const s of [
      { organizationId: t.organizationId, brandId: brandB.rows[0]!.id },
      { organizationId: other.organizationId, brandId: other.brandId },
    ])
      expect(
        await actions.request({
          scope: s,
          commentId,
          kind: 'hide',
          actor: user(),
          requestKey: key(),
        }),
      ).toEqual({ status: 'refused', code: 'not_found' });
    expect(await rowsFor(commentId)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('facebook: behaviour unchanged (hidden comment public reply still accepted)', async () => {
    const hidden = await seedComment({ state: 'hidden' });
    expect(await request(hidden, 'public_reply', { text: 'thanks' })).toMatchObject({
      status: 'accepted',
      action: { kind: 'public_reply', status: 'pending' },
    });
    // 8000 characters is still within Facebook's limit.
    expect(await request(hidden, 'public_reply', { text: 'z'.repeat(8000) })).toMatchObject({
      status: 'accepted',
    });
    // A person may hide the Page's own comment.
    const own = await seedComment({ authorId: PAGE });
    expect(await request(own, 'hide')).toMatchObject({ status: 'accepted' });
    // Facebook private replies are not limited to top-level comments.
    const top = await seedComment();
    const nested = await store.upsertFromPlatform(
      scope,
      {
        externalId: `${PAGE}_1_nested_${++seq}`,
        sourceExternalId: `${PAGE}_1`,
        parentExternalId: (await store.load(t, top))!.externalId,
        author: { externalId: '3999999999', displayName: 'A', profileUrl: null },
        body: 'a reply',
        postedAt: new Date(nowMs - 60_000),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: PAGE, syncedAt: new Date(nowMs) },
    );
    expect(await request(nested.commentId, 'private_reply', { text: 'dm' })).toMatchObject({
      status: 'accepted',
    });
    expect(enqueue).toHaveBeenCalledTimes(4);
  });
});
