import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_ID, RULE_ID } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

describe('read_rules', () => {
  it('lists rules and change requests per brand', async () => {
    h = await connect();
    const r = await h.call('read_rules', { brandId: BRAND_ID });
    expect(h.api.callsTo('rules')).toEqual([[BRAND_ID]]);
    const text = textOf(r);
    expect(text).toContain('Acme');
    expect(text).toContain('No links');
    expect(text).toContain(RULE_ID);
    expect(text).toContain('applies to: ad');
    expect(text).toMatch(/update .*pending/);
    expect(r.structuredContent).toEqual(h.api.rulesResult);
  });

  it('rejects a malformed brand ID without calling the API', async () => {
    h = await connect();
    const r = await h.call('read_rules', { brandId: 'acme' });
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
