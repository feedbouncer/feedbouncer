// The MCP tools against a real API: two workspaces, each with a write key, a Facebook Page
// (FakeGraph) and comments. Execute jobs run inline, as the worker would run them.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExecuteJob } from '@feedbouncer/api/testing';
import { ApiCallError, FeedBouncerApi } from './api-client.js';
import { loadConfig } from './config.js';
import {
  mcpSession,
  startLiveApi,
  textOf,
  type LiveApi,
  type McpSession,
  type Tenant,
} from './testing/live-api.js';

let live: LiveApi;
let A: Tenant;
let B: Tenant;
let mcp: McpSession;

const REPLY_TEXT = 'Sorry about the wait, reply-text-k39x';
const RULE_TERM = 'rule-term-p72v';

async function brandRevision(brandId: string): Promise<string> {
  const { rows } = await live.api.pool.query<{ rev: string }>(
    'SELECT rule_revision::text AS rev FROM brand WHERE id = $1',
    [brandId],
  );
  return rows[0]!.rev;
}

/** The newest moderation action on a comment, waiting until the API has stored it. */
async function latestAction(commentId: string, kind: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await live.api.pool.query<{ id: string }>(
      `SELECT id FROM moderation_action WHERE comment_id = $1 AND kind = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [commentId, kind],
    );
    if (rows[0]) return rows[0].id;
    await sleep(20);
  }
  throw new Error(`no ${kind} action for ${commentId}`);
}

/** Everything about workspace B that a cross-tenant call could change. */
async function snapshotB() {
  const q = async (sql: string) => (await live.api.pool.query(sql, [B.orgId])).rows;
  return {
    comments: await q(
      'SELECT id, body, platform_state, updated_at FROM comment WHERE organization_id = $1 ORDER BY id',
    ),
    actions: await q('SELECT id FROM moderation_action WHERE organization_id = $1 ORDER BY id'),
    rules: await q(
      'SELECT id, name, enabled, archived_at FROM rule WHERE organization_id = $1 ORDER BY id',
    ),
    proposals: await q(
      'SELECT id FROM rule_change_proposal WHERE organization_id = $1 ORDER BY id',
    ),
    brands: await q('SELECT id, rule_revision FROM brand WHERE organization_id = $1 ORDER BY id'),
    audit: await q('SELECT count(*)::int AS n FROM audit_event WHERE organization_id = $1'),
  };
}

beforeAll(async () => {
  live = await startLiveApi();
  A = await live.tenant('mcpA');
  B = await live.tenant('mcpB');
  mcp = await mcpSession(live.url, A.writeKey.token);
});
afterAll(async () => {
  await mcp?.close();
  await live?.close();
});

describe('MCP tools against the real API', () => {
  it('list, search, reply, hide, hide again, unhide, summarize, read rules, propose; a person approves', async () => {
    const shipping = await live.comment(A.page, 'Where is my order? The shipping is late.');
    const praise = await live.comment(A.page, 'Great product, thanks!');
    const other = await live.comment(B.page, 'Workspace B shipping question');

    const list = await mcp.call('list_inbox', { brandId: A.brandId });
    expect(list.isError).toBeFalsy();
    const listed = (list.structuredContent as { comments: { id: string }[] }).comments.map(
      (c) => c.id,
    );
    expect(listed).toEqual(expect.arrayContaining([shipping.id, praise.id]));
    expect(listed).not.toContain(other.id);

    const found = await mcp.call('search_inbox', { query: 'shipping' });
    expect(
      (found.structuredContent as { comments: { id: string }[] }).comments.map((c) => c.id),
    ).toEqual([shipping.id]);

    // The reply tool waits for the action while the "worker" applies it.
    const replying = mcp.call('reply_to_comment', { commentId: shipping.id, text: REPLY_TEXT });
    const replyAction = await latestAction(shipping.id, 'public_reply');
    await runExecuteJob(live.api, replyAction, A.page.scope);
    const replied = await replying;
    expect(replied.isError).toBeFalsy();
    expect(replied.structuredContent).toMatchObject({
      status: 'posted',
      actionId: replyAction,
      replyId: expect.any(String) as unknown,
    });
    expect(live.graph.replies(shipping.externalId).map((r) => r.message)).toEqual([REPLY_TEXT]);

    const hide = await mcp.call('set_comment_visibility', {
      commentId: praise.id,
      visibility: 'hidden',
    });
    expect(hide.structuredContent).toEqual({ changed: true, status: 'pending' });
    const hideAction = await latestAction(praise.id, 'hide');
    await runExecuteJob(live.api, hideAction, A.page.scope);
    expect(live.graph.state(praise.externalId)).toBe('hidden');

    const again = await mcp.call('set_comment_visibility', {
      commentId: praise.id,
      visibility: 'hidden',
    });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toEqual({ changed: false, reason: 'already_hidden' });
    expect(textOf(again)).toBe('Already hidden — nothing changed.');

    const unhide = await mcp.call('set_comment_visibility', {
      commentId: praise.id,
      visibility: 'visible',
    });
    expect(unhide.structuredContent).toEqual({ changed: true, status: 'pending' });
    const unhideAction = await latestAction(praise.id, 'unhide');
    await runExecuteJob(live.api, unhideAction, A.page.scope);
    expect(live.graph.state(praise.externalId)).toBe('visible');

    const summary = await mcp.call('summarize_period', { brandId: A.brandId });
    expect(summary.isError).toBeFalsy();
    expect(
      (summary.structuredContent as { totals: { comments: number } }).totals.comments,
    ).toBeGreaterThanOrEqual(2);

    const rules = await mcp.call('read_rules', { brandId: A.brandId });
    expect(rules.isError).toBeFalsy();
    const revision = await brandRevision(A.brandId);

    const proposed = await mcp.call('propose_rule_change', {
      brandId: A.brandId,
      operation: 'create',
      rule: {
        name: 'Hide scam links',
        conditions: { type: 'keyword', terms: [RULE_TERM] },
        actions: [{ type: 'hide' }],
        mode: 'enforce',
      },
      rationale: 'Several scam comments this week',
    });
    expect(proposed.isError).toBeFalsy();
    const { proposalId } = proposed.structuredContent as { proposalId: string; status: string };
    expect(proposed.structuredContent).toMatchObject({ status: 'pending' });
    expect(await brandRevision(A.brandId)).toBe(revision);
    const pending = await mcp.call('read_rules', { brandId: A.brandId });
    expect(textOf(pending)).not.toContain('Hide scam links');

    const approved = await live.api.req(
      'POST',
      `/api/v1/orgs/${A.orgId}/brands/${A.brandId}/rule-changes/${proposalId}/approve`,
      { cookie: A.admin.cookie, body: {} },
    );
    expect(approved.status).toBe(200);
    const after = await mcp.call('read_rules', { brandId: A.brandId });
    expect(textOf(after)).toContain('Hide scam links');
    expect(textOf(after)).toContain(`${proposalId}: create (new rule) approved`);

    // One audit row per write, attributed to the tool's key (or, for approval, the person).
    const { rows: audit } = await live.api.pool.query<{
      action: string;
      actor_type: string;
      actor_user_id: string | null;
      subject_id: string;
      details: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, actor_user_id, subject_id, details FROM audit_event
        WHERE organization_id = $1 AND action IN ('comment.moderated', 'rule_change.proposed', 'rule_change.approved')
        ORDER BY sequence`,
      [A.orgId],
    );
    const byKey = { actor_type: 'api_key', actor_user_id: null };
    const keyDetails = (extra: object) =>
      expect.objectContaining({ apiKeyId: A.writeKey.id, ...extra }) as unknown;
    expect(audit).toEqual([
      {
        ...byKey,
        action: 'comment.moderated',
        subject_id: shipping.id,
        details: keyDetails({ actionId: replyAction, kind: 'public_reply', status: 'applied' }),
      },
      {
        ...byKey,
        action: 'comment.moderated',
        subject_id: praise.id,
        details: keyDetails({ actionId: hideAction, kind: 'hide', status: 'applied' }),
      },
      {
        ...byKey,
        action: 'comment.moderated',
        subject_id: praise.id,
        details: keyDetails({ kind: 'hide', status: 'noop' }),
      },
      {
        ...byKey,
        action: 'comment.moderated',
        subject_id: praise.id,
        details: keyDetails({ actionId: unhideAction, kind: 'unhide', status: 'applied' }),
      },
      {
        ...byKey,
        action: 'rule_change.proposed',
        subject_id: proposalId,
        details: keyDetails({ operation: 'create' }),
      },
      {
        action: 'rule_change.approved',
        actor_type: 'user',
        actor_user_id: A.admin.userId,
        subject_id: proposalId,
        details: expect.objectContaining({ proposalId, operation: 'create' }) as unknown,
      },
    ]);
    const { rows: all } = await live.api.pool.query<{ details: unknown }>(
      'SELECT details FROM audit_event WHERE organization_id = $1',
      [A.orgId],
    );
    const details = JSON.stringify(all);
    expect(details).not.toContain('reply-text-k39x');
    expect(details).not.toContain(RULE_TERM);
    expect(details).not.toContain('Hide scam links');
    expect(details).not.toContain('Several scam comments');
  });

  it('a key of workspace A gets not_found for every ID of workspace B, and B is unchanged', async () => {
    const bComment = await live.comment(B.page, 'Private to workspace B');
    const created = await live.api.req(
      'POST',
      `/api/v1/orgs/${B.orgId}/brands/${B.brandId}/rules`,
      {
        cookie: B.owner.cookie,
        body: {
          name: 'B rule',
          conditions: { type: 'keyword', terms: ['b-only'] },
          actions: [{ type: 'flag_for_review' }],
        },
      },
    );
    expect(created.status).toBe(201);
    const bRule = created.body.id as string;
    const before = await snapshotB();

    const NOT_FOUND =
      'No comment/rule/brand with that ID in this workspace. List the inbox to get current IDs.';
    const calls: [string, Record<string, unknown>][] = [
      ['reply_to_comment', { commentId: bComment.id, text: 'cross-tenant reply' }],
      ['set_comment_visibility', { commentId: bComment.id, visibility: 'hidden' }],
      ['set_comment_visibility', { commentId: bComment.id, visibility: 'visible' }],
      ['summarize_period', { brandId: B.brandId }],
      ['read_rules', { brandId: B.brandId }],
      [
        'propose_rule_change',
        {
          brandId: B.brandId,
          operation: 'create',
          rule: {
            name: 'x',
            conditions: { type: 'keyword', terms: ['x'] },
            actions: [{ type: 'hide' }],
          },
        },
      ],
      ['propose_rule_change', { brandId: B.brandId, operation: 'archive', ruleId: bRule }],
      ['propose_rule_change', { brandId: A.brandId, operation: 'archive', ruleId: bRule }],
      [
        'propose_rule_change',
        { brandId: A.brandId, operation: 'update', ruleId: bRule, patch: { enabled: false } },
      ],
    ];
    for (const [tool, args] of calls) {
      const r = await mcp.call(tool, args);
      expect({ tool, args, isError: r.isError, text: textOf(r) }).toEqual({
        tool,
        args,
        isError: true,
        text: NOT_FOUND,
      });
    }
    // Listing filters by brand: B's brand ID matches nothing of A's and leaks nothing of B's.
    for (const tool of ['list_inbox', 'search_inbox']) {
      const r = await mcp.call(tool, {
        brandId: B.brandId,
        ...(tool === 'search_inbox' && { query: 'Private' }),
      });
      expect(r.structuredContent).toEqual({ comments: [], nextCursor: null });
    }
    const all = await mcp.call('list_inbox', { limit: 50 });
    expect(JSON.stringify(all)).not.toContain(bComment.id);

    expect(await snapshotB()).toEqual(before);
    expect(live.graph.replies(bComment.externalId)).toEqual([]);
    expect(live.graph.state(bComment.externalId)).toBe('visible');
  });

  it('an invalid key is unauthenticated, and the API logs the failure without the key', async () => {
    const forged = `fbk_${'a'.repeat(16)}_${'Q'.repeat(43)}`;
    const client = new FeedBouncerApi(
      loadConfig({ FEEDBOUNCER_API_URL: live.url, FEEDBOUNCER_API_KEY: forged }),
    );
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' });

    const lines = live.api.logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'request', route: '/v1/key', status: 401 }),
    );
    const logs = live.api.logLines.join('\n');
    expect(logs).not.toContain(forged);
    expect(logs).not.toContain('Q'.repeat(43));
    expect(logs).not.toContain(A.writeKey.token);
  });
});
