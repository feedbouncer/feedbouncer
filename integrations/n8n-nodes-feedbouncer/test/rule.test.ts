import { describe, expect, it } from 'vitest';
import { FeedBouncer } from '../nodes/FeedBouncer/FeedBouncer.node';
import { fakeExecute } from './fakes';
import type { FakeInit, Scripted } from './fakes';

const BRAND_A = '0b9c2f7e-8a4d-4c1e-9f3a-1d2e3f4a5b6c';
const BRAND_B = '1c0d3a8f-9b5e-4d2f-8a4b-2e3f4a5b6c7d';
const RULE_1 = '2d1e4b9a-0c6f-4e30-9b5c-3f4a5b6c7d8e';
const RULE_2 = '3e2f5c0b-1d70-4f41-8c6d-4a5b6c7d8e9f';
const RULE_3 = '4f306d1c-2e81-4052-9d7e-5b6c7d8e9fa0';

const rule = (id: string, name: string, priority: number) => ({
  id,
  name,
  conditions: { contains: ['refund'] },
  actions: [{ type: 'hide' }],
  mode: 'enforce',
  priority,
  enabled: true,
});
const brand = (id: string, name: string, rules: unknown[]) => ({ id, name, ruleRevision: 3, rules, changes: [{ id: 'x' }] });
const ruleSet = (...brands: unknown[]): Scripted => ({ status: 200, body: { brands } });

const THREE = ruleSet(
  brand(BRAND_A, 'Acme', [rule(RULE_1, 'First', 1), rule(RULE_2, 'Second', 2)]),
  brand(BRAND_B, 'Beta', [rule(RULE_3, 'Third', 1)]),
);

const run = (init: FakeInit) => {
  const ctx = fakeExecute(init);
  return { ctx, result: new FeedBouncer().execute.call(ctx) };
};

describe('rule list', () => {
  it('flattens brands to one item per rule, keeping evaluation order, without changes', async () => {
    const { ctx, result } = run({ params: { resource: 'rule', operation: 'list', returnAll: true }, http: [THREE] });
    const [items] = await result;
    expect(ctx.calls[0]).toMatchObject({ method: 'GET', url: 'https://fb.acme.io/v1/rules' });
    expect(items.map((item) => item.json.id)).toEqual([RULE_1, RULE_2, RULE_3]);
    expect(items[0]).toEqual({
      json: { ...rule(RULE_1, 'First', 1), brandId: BRAND_A, brandName: 'Acme' },
      pairedItem: { item: 0 },
    });
    expect(items[2].json).toMatchObject({ brandId: BRAND_B, brandName: 'Beta' });
  });

  it('limit 2 of 3 gives 2 items; return all gives 3', async () => {
    const limited = run({ params: { resource: 'rule', operation: 'list', returnAll: false, limit: 2 }, http: [THREE] });
    expect((await limited.result)[0]).toHaveLength(2);
    const all = run({ params: { resource: 'rule', operation: 'list', returnAll: true }, http: [THREE] });
    expect((await all.result)[0]).toHaveLength(3);
  });

  it('sends the brand filter as brandId', async () => {
    const { ctx, result } = run({
      params: { resource: 'rule', operation: 'list', returnAll: true, brandId: BRAND_A },
      http: [ruleSet(brand(BRAND_A, 'Acme', []))],
    });
    await result;
    expect(ctx.calls[0].qs).toEqual({ brandId: BRAND_A });
  });

  it('rejects a non-UUID brand before any HTTP call', async () => {
    const { ctx, result } = run({ params: { resource: 'rule', operation: 'list', returnAll: true, brandId: 'acme' } });
    await expect(result).rejects.toThrow('Brand ID must be a FeedBouncer ID (a UUID).');
    expect(ctx.calls).toHaveLength(0);
  });

  it('a brand the account cannot see (API 404) reads as a missing brand', async () => {
    const { result } = run({
      params: { resource: 'rule', operation: 'list', returnAll: true, brandId: BRAND_B },
      http: [{ status: 404, body: { error: { code: 'not_found', message: 'nope' } } }],
    });
    await expect(result).rejects.toThrow(`No brand with ID ${BRAND_B} in this FeedBouncer workspace.`);
  });

  it('a brand without rules gives zero items and no error', async () => {
    const { result } = run({
      params: { resource: 'rule', operation: 'list', returnAll: true },
      http: [ruleSet(brand(BRAND_A, 'Acme', []))],
    });
    expect((await result)[0]).toEqual([]);
  });
});

describe('rule get', () => {
  it('finds the rule across brands', async () => {
    const { ctx, result } = run({ params: { resource: 'rule', operation: 'get', ruleId: RULE_3 }, http: [THREE] });
    const [items] = await result;
    expect(ctx.calls[0].qs).toEqual({});
    expect(items).toEqual([
      { json: { ...rule(RULE_3, 'Third', 1), brandId: BRAND_B, brandName: 'Beta' }, pairedItem: { item: 0 } },
    ]);
  });

  it('narrows the lookup with a brand ID', async () => {
    const { ctx, result } = run({
      params: { resource: 'rule', operation: 'get', ruleId: RULE_1, brandId: BRAND_A },
      http: [ruleSet(brand(BRAND_A, 'Acme', [rule(RULE_1, 'First', 1)]))],
    });
    await result;
    expect(ctx.calls[0].qs).toEqual({ brandId: BRAND_A });
  });

  it('an unknown id reads as not found', async () => {
    const { result } = run({
      params: { resource: 'rule', operation: 'get', ruleId: '5a417e2d-3f92-4163-8e8f-6c7d8e9fa0b1' },
      http: [THREE],
    });
    await expect(result).rejects.toMatchObject({
      message: 'No rule with ID 5a417e2d-3f92-4163-8e8f-6c7d8e9fa0b1 in this FeedBouncer workspace.',
      httpCode: '404',
    });
  });

  it('a foreign brand (API 404) reads as not found', async () => {
    const { result } = run({
      params: { resource: 'rule', operation: 'get', ruleId: RULE_1, brandId: BRAND_B },
      http: [{ status: 404, body: { error: { code: 'not_found', message: 'nope' } } }],
    });
    await expect(result).rejects.toThrow(`No rule with ID ${RULE_1} in this FeedBouncer workspace.`);
  });

  it('rejects a non-UUID rule id before any HTTP call', async () => {
    const { ctx, result } = run({ params: { resource: 'rule', operation: 'get', ruleId: 'x' } });
    await expect(result).rejects.toThrow('Rule ID must be a FeedBouncer ID (a UUID).');
    expect(ctx.calls).toHaveLength(0);
  });
});
