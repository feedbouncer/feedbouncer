import { afterEach, describe, expect, it } from 'vitest';
import { ApiCallError } from '../api-client.js';
import { BRAND_ID, RULE_ID } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

describe('propose_rule_change', () => {
  it('creates a pending proposal and points to the review page', async () => {
    h = await connect();
    const r = await h.call('propose_rule_change', {
      brandId: BRAND_ID,
      operation: 'archive',
      ruleId: RULE_ID,
      rationale: 'Too broad',
    });
    expect(r.isError).toBeFalsy();
    const p = h.api.proposal;
    expect(r.structuredContent).toEqual({
      proposalId: p.id,
      status: 'pending',
      diff: p.diff,
      warnings: [],
      expiresAt: p.expiresAt,
      reviewUrl: p.reviewUrl,
    });
    expect(textOf(r)).toContain(
      `Pending — no rules changed. A person must approve it at ${p.reviewUrl} before ${p.expiresAt}.`,
    );
    const [body, key] = h.api.callsTo('proposeRuleChange')[0]!;
    expect(body).toEqual({
      operation: 'archive',
      brandId: BRAND_ID,
      ruleId: RULE_ID,
      rationale: 'Too broad',
    });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps create and update operations onto the request body', async () => {
    h = await connect();
    const rule = { name: 'No spam', conditions: { keywords: ['spam'] }, actions: [] };
    await h.call('propose_rule_change', {
      brandId: BRAND_ID,
      operation: 'create',
      rule,
      idempotencyKey: 'p-1',
    });
    await h.call('propose_rule_change', {
      brandId: BRAND_ID,
      operation: 'update',
      ruleId: RULE_ID,
      patch: { enabled: false },
    });
    const calls = h.api.callsTo('proposeRuleChange');
    expect(calls[0]).toEqual([{ operation: 'create', brandId: BRAND_ID, rule }, 'p-1']);
    expect(calls[1]![0]).toEqual({
      operation: 'update',
      brandId: BRAND_ID,
      ruleId: RULE_ID,
      patch: { enabled: false },
    });
  });

  it('reports a rejected rule with the reason', async () => {
    h = await connect();
    h.api.error = new ApiCallError(422, 'rule_rejected', 'The rule would match every comment', {
      reason: 'matches_everything',
    });
    const r = await h.call('propose_rule_change', {
      brandId: BRAND_ID,
      operation: 'archive',
      ruleId: RULE_ID,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('matches_everything');
  });

  it('advertises a flat object schema with an operation enum and a closed world', async () => {
    h = await connect();
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'propose_rule_change')!;
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties?.operation).toMatchObject({
      enum: ['create', 'update', 'archive'],
    });
    expect(tool.annotations?.openWorldHint).toBe(false);
  });

  it.each([
    { brandId: BRAND_ID, operation: 'approve', ruleId: RULE_ID },
    { brandId: BRAND_ID, operation: 'create' },
    { brandId: BRAND_ID, operation: 'update', ruleId: RULE_ID },
    { brandId: BRAND_ID, operation: 'update', patch: { enabled: false } },
    { brandId: BRAND_ID, operation: 'archive' },
    { brandId: BRAND_ID, operation: 'archive', ruleId: RULE_ID, rule: { name: 'x' } },
    { brandId: BRAND_ID, operation: 'create', rule: { name: 'x'.repeat(16_400) } },
    { brandId: BRAND_ID, operation: 'update', ruleId: RULE_ID, patch: { n: 'x'.repeat(16_400) } },
    { brandId: BRAND_ID, operation: 'archive', ruleId: RULE_ID, rationale: 'x'.repeat(1001) },
  ])('rejects invalid input without calling the API', async (bad) => {
    h = await connect();
    const r = await h.call('propose_rule_change', bad);
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
