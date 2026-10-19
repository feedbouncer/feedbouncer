import { afterEach, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { ApiCallError, FeedBouncerApi } from './api-client.js';
import { BRAND_ID, COMMENT_ID, RULE_ID, FakeApi, makeComment } from './testing/fake-api.js';
import { connect, textOf, type Harness } from './testing/harness.js';
import { UNTRUSTED_NOTICE } from './present.js';

const KEY = `fbk_abcdefghij234567_${'A'.repeat(43)}`;

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  list_inbox: {},
  search_inbox: { query: 'refund' },
  reply_to_comment: { commentId: COMMENT_ID, text: 'Thanks!' },
  set_comment_visibility: { commentId: COMMENT_ID, visibility: 'hidden' },
  summarize_period: {},
  read_rules: {},
  propose_rule_change: {
    brandId: BRAND_ID,
    operation: 'archive',
    ruleId: RULE_ID,
  },
};

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('buildServer', () => {
  it('lists exactly the seven tools with descriptions and hints', async () => {
    h = await connect();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_inbox',
      'propose_rule_change',
      'read_rules',
      'reply_to_comment',
      'search_inbox',
      'set_comment_visibility',
      'summarize_period',
    ]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(byName('read_rules').annotations?.readOnlyHint).toBe(true);
    expect(byName('propose_rule_change').annotations?.readOnlyHint).toBe(false);
    expect(tools.some((t) => /approve/i.test(t.name))).toBe(false);
    for (const n of ['list_inbox', 'search_inbox', 'summarize_period', 'read_rules']) {
      expect(byName(n).annotations?.readOnlyHint).toBe(true);
      expect(byName(n).description).toMatch(/^Read-only\./);
    }
    for (const n of ['reply_to_comment', 'set_comment_visibility']) {
      expect(byName(n).description).toContain('Acts on the live social platform.');
      expect(byName(n).annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(byName('list_inbox').annotations?.openWorldHint).toBe(false);
    expect(byName('reply_to_comment').annotations?.openWorldHint).toBe(true);
  });

  it('explains untrusted content and that proposals need a person to approve', async () => {
    h = await connect();
    const instructions = h.client.getInstructions() ?? '';
    expect(instructions).toContain(UNTRUSTED_NOTICE);
    expect(instructions).toContain(
      'propose_rule_change only creates a pending proposal; a person must approve it in the FeedBouncer web app. No tool can approve.',
    );
  });

  it.each(Object.keys(VALID_ARGS))('%s reports rate limits with the retry delay', async (tool) => {
    const api = new FakeApi();
    api.error = new ApiCallError(429, 'rate_limited', 'Too many requests', undefined, 7);
    h = await connect({}, api);
    const r = await h.call(tool, VALID_ARGS[tool]);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Retry after 7 seconds');
  });

  it('logs tool, target and outcome but never text bodies', async () => {
    const api = new FakeApi();
    api.page = { data: [makeComment({ text: 'SECRET BODY' })], nextCursor: null };
    h = await connect({}, api);
    await h.call('list_inbox', {});
    await h.call('reply_to_comment', { commentId: COMMENT_ID, text: 'PRIVATE REPLY' });
    const entries = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries).toContainEqual(
      expect.objectContaining({
        tool: 'reply_to_comment',
        targetId: COMMENT_ID,
        outcome: 'posted',
      }),
    );
    expect(entries).toContainEqual(expect.objectContaining({ tool: 'list_inbox', outcome: 'ok' }));
    expect(h.logs.join('\n')).not.toMatch(/SECRET BODY|PRIVATE REPLY/);
  });
});

describe('API key never leaks', () => {
  const realApi = (fetchImpl: typeof fetch) =>
    new FeedBouncerApi(
      {
        apiBaseUrl: new URL('http://127.0.0.1:3001'),
        apiKey: new Secret(KEY),
        requestTimeoutMs: 1000,
        replyWaitMs: 50,
      },
      fetchImpl,
    );
  const failures: [string, typeof fetch][] = [
    [
      'network error',
      async () => {
        throw new Error(`connect failed with Bearer ${KEY}`);
      },
    ],
    [
      'error body',
      async () =>
        new Response(JSON.stringify({ error: { code: 'boom', message: KEY, key: KEY } }), {
          status: 500,
        }),
    ],
  ];

  it.each(failures)('from any tool on %s', async (_name, fetchImpl) => {
    h = await connect({}, realApi(fetchImpl) as unknown as FakeApi);
    for (const [tool, args] of Object.entries(VALID_ARGS)) {
      const r = await h.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(JSON.stringify(r)).not.toContain('fbk_');
    }
    expect(h.logs.join('\n')).not.toContain('fbk_');
  });

  it('from any successful tool result', async () => {
    const api = new FakeApi();
    api.page = { data: [makeComment()], nextCursor: 'c2' };
    h = await connect({}, api);
    for (const [tool, args] of Object.entries(VALID_ARGS)) {
      const r = await h.call(tool, args);
      expect(r.isError, `${tool}: ${textOf(r)}`).toBeFalsy();
      expect(JSON.stringify(r)).not.toContain('fbk_');
    }
  });
});
