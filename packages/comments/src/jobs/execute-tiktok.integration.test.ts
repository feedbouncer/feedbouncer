// The execute job over the real TikTok connectors and FakeTikTok: rule actions on ad
// comments, replays, comments gone on TikTok and the V19 single-comment lookup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorError, type Connector } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { ModerationActions } from '../actions.js';
import type { ActionKind } from '../action-kinds.js';
import { tiktokAdsPollJob } from '../tiktok/poll-ads.js';
import { tiktokPollJob } from '../tiktok/poll-organic.js';
import { SETTINGS, log, tiktokWorld, type TikTokWorld } from '../tiktok/test-world.js';
import { executeActionJob } from './execute.js';
import { EXECUTE_JOB, TIKTOK_ADS_POLL_JOB, TIKTOK_POLL_JOB } from './specs.js';

let lookup: 'real' | 'unsupported' = 'real';
const wrap = (c: Connector): Connector => ({
  ...c,
  getComment: (ctx, ref) => {
    if (lookup === 'unsupported') throw new ConnectorError('unsupported', 'single_comment_lookup');
    return c.getComment(ctx, ref);
  },
});

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('execute', { wrap });
});
afterAll(() => w.close());
beforeEach(() => {
  w.reset();
  lookup = 'real';
});

const producer = () => ({
  enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
});
const actions = () =>
  new ModerationActions({
    pool: w.pool,
    store: w.store,
    producer: producer(),
    capabilities: (p) => w.registry.get(p)?.capabilities,
    clock: w.clock,
    log,
  });
const pollDeps = () => ({
  runtime: w.runtime,
  polling: w.polling,
  store: w.store,
  clock: w.now,
  settings: SETTINGS,
});
const execute = (scope: ConnectionScope, platform: 'tiktok' | 'tiktok_ads', actionId: string) =>
  executeActionJob({
    pool: w.pool,
    runtime: w.runtime,
    log,
    producer: producer(),
    clock: w.clock,
  }).handle(w.jobCtx(scope, platform, EXECUTE_JOB.type), { actionId });

async function ruleOf(scope: ConnectionScope): Promise<string> {
  const r = await w.pool.query<{ id: string }>(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode)
     VALUES ($1, $2, 'No spam', '{"type":"keyword","terms":["spam"]}', 'hide', '[{"type":"hide"}]', 'enforce')
     RETURNING id`,
    [scope.organizationId, scope.brandId],
  );
  return r.rows[0]!.id;
}
const storedId = async (scope: ConnectionScope, externalId: string) =>
  (
    await w.pool.query<{ id: string }>(
      'SELECT id FROM comment WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4',
      [scope.organizationId, scope.brandId, scope.connectionId, externalId],
    )
  ).rows[0]!.id;
const actionRows = async (commentId: string) =>
  (
    await w.pool.query<{
      kind: string;
      rule_id: string | null;
      status: string;
      outcome_code: string | null;
      platform_ref: string | null;
      completed_at: Date | null;
    }>(
      `SELECT kind, rule_id, status, outcome_code, platform_ref, completed_at
         FROM moderation_action WHERE comment_id = $1 ORDER BY created_at`,
      [commentId],
    )
  ).rows;

let nextAd = 1_900_000_000_000_000;
async function adComment(label: string) {
  const tenant = await w.tenant(label);
  const { scope, advertiserId } = await w.connectAds(tenant);
  // Rules act outside the first-connection review window.
  await w.pool.query(`UPDATE connection SET review_mode = 'legacy' WHERE id = $1`, [
    scope.connectionId,
  ]);
  const ad = { adId: String(nextAd++), itemId: String(nextAd++) };
  const { commentId: externalId } = w.fake.addAdComment(advertiserId, {
    ...ad,
    text: 'buy spam',
    createdAt: new Date(w.clock.now() - 60_000),
  });
  await tiktokAdsPollJob(pollDeps()).handle(
    w.jobCtx(scope, 'tiktok_ads', TIKTOK_ADS_POLL_JOB.type),
    { connectionId: scope.connectionId },
  );
  return { scope, externalId, id: await storedId(scope, externalId) };
}
const ruleRequest = async (
  scope: ConnectionScope,
  commentId: string,
  ruleId: string,
  kind: ActionKind = 'hide',
) => {
  const r = await actions().request({
    scope,
    commentId,
    kind,
    actor: { type: 'rule', ruleId },
    requestKey: `auto:${commentId}:${kind}`,
  });
  if (r.status !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(r)}`);
  return r.action.id;
};

describe('moderation execute job on TikTok', () => {
  it('rule hide on a tiktok_ads comment hides on TikTok and records rule, time, outcome and request id', async () => {
    const c = await adComment('rule-hide');
    const ruleId = await ruleOf(c.scope);
    const actionId = await ruleRequest(c.scope, c.id, ruleId);
    expect(await execute(c.scope, 'tiktok_ads', actionId)).toMatchObject({ status: 'applied' });
    expect(w.fake.commentState(c.externalId)).toBe('HIDDEN');
    const [row] = await actionRows(c.id);
    expect(row).toMatchObject({ kind: 'hide', rule_id: ruleId, status: 'applied' });
    expect(row!.platform_ref).toBe(w.requestIds('comment/status/update/').at(-1));
    expect(row!.completed_at).toBeInstanceOf(Date);
  });

  it('replaying the same ingest does not repeat the action', async () => {
    const c = await adComment('replay');
    const ruleId = await ruleOf(c.scope);
    const before = w.fake.calls('adCommentStatusUpdate').length;
    const first = await ruleRequest(c.scope, c.id, ruleId);
    await execute(c.scope, 'tiktok_ads', first);
    await tiktokAdsPollJob(pollDeps()).handle(
      w.jobCtx(c.scope, 'tiktok_ads', TIKTOK_ADS_POLL_JOB.type),
      { connectionId: c.scope.connectionId },
    );
    const again = await ruleRequest(c.scope, c.id, ruleId);
    expect(again).toBe(first);
    expect(await execute(c.scope, 'tiktok_ads', again)).toEqual({ status: 'applied' });
    expect(await actionRows(c.id)).toHaveLength(1);
    expect(w.fake.calls('adCommentStatusUpdate').length - before).toBe(1);
  });

  it('action on a comment deleted on TikTok is not_applicable/comment_gone, not an error', async () => {
    const c = await adComment('gone');
    const ruleId = await ruleOf(c.scope);
    const actionId = await ruleRequest(c.scope, c.id, ruleId);
    w.fake.deleteComment(c.externalId);
    expect(await execute(c.scope, 'tiktok_ads', actionId)).toEqual({
      status: 'noop',
      outcomeCode: 'comment_gone',
      undo: null,
    });
    expect(await actionRows(c.id)).toMatchObject([
      { status: 'noop', outcome_code: 'comment_gone' },
    ]);
  });

  it('getComment unsupported during resync does not fail the action job', async () => {
    const tenant = await w.tenant('lookup');
    const { scope, businessId } = await w.connectTikTok(tenant);
    const { itemId } = w.fake.addVideo(businessId);
    const top = w.fake.addComment(itemId, {
      text: 'top',
      createdAtSec: Math.floor(w.clock.now() / 1000) - 120,
    }).commentId;
    const reply = w.fake.addComment(itemId, {
      text: 'reply',
      parentId: top,
      createdAtSec: Math.floor(w.clock.now() / 1000) - 60,
      hidden: true,
    }).commentId;
    await tiktokPollJob(pollDeps()).handle(w.jobCtx(scope, 'tiktok', TIKTOK_POLL_JOB.type), {
      connectionId: scope.connectionId,
    });
    const id = await storedId(scope, reply);
    await w.pool.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [id]);
    const unhide = async () => {
      const r = await actions().request({
        scope,
        commentId: id,
        kind: 'unhide',
        actor: { type: 'user', userId: tenant.userId },
        requestKey: `rk-${lookup}-${id}`,
      });
      if (r.status !== 'accepted') throw new Error(`expected accepted, got ${r.status}`);
      return execute(scope, 'tiktok', r.action.id);
    };
    // A reply is outside the lookup's scan: null there does not mean deleted.
    expect(await unhide()).toMatchObject({ status: 'applied' });
    expect(w.fake.commentState(reply)).toBe('PUBLIC');
    await w.pool.query(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [id]);
    lookup = 'unsupported';
    expect(await unhide()).toMatchObject({ status: 'applied' });
    const state = await w.pool.query<{ platform_state: string }>(
      'SELECT platform_state FROM comment WHERE id = $1',
      [id],
    );
    expect(state.rows[0]!.platform_state).toBe('visible');
  });
});
