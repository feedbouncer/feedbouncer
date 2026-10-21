import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STEP_TYPES } from '@feedbouncer/actions';
import { buildProductReference } from '../scripts/write-reference';

const file = new URL('../../../docs/reference/product-reference.json', import.meta.url);

describe('product reference', () => {
  const ref = buildProductReference();

  it('matches the committed docs/reference/product-reference.json', () => {
    const committed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    expect(
      committed,
      'docs/reference/product-reference.json is out of date; run `pnpm --filter @feedbouncer/docs reference:write` and commit the result',
    ).toEqual(JSON.parse(JSON.stringify(ref)));
  });

  it('lists every condition type and step type from the code', () => {
    expect(ref.rules.conditions.map((c) => c.type)).toEqual([
      'keyword',
      'regex',
      'link_domain',
      'emoji',
      'author',
      'competitor',
    ]);
    expect(ref.rules.steps.map((s) => s.type)).toEqual([...STEP_TYPES]);
    expect(ref.api.rateLimit.defaultPerMinute).toBe(60);
  });

  it('orders outcomes by severity', () => {
    expect(ref.rules.outcomes).toEqual(['approve', 'flag', 'hide', 'remove']);
  });
});
