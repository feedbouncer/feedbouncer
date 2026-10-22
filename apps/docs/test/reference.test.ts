import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STEP_TYPES } from '@feedbouncer/actions';
import { CONDITION_LIMITS } from '@feedbouncer/rules';
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

  it('publishes numeric limits that agree with the generated condition schemas', () => {
    const schemaOf = (type: string) =>
      ref.rules.conditions.find((c) => c.type === type)!.schema as {
        properties: Record<string, { maxItems?: number; items?: { maxLength?: number } }>;
      };
    const L = CONDITION_LIMITS;
    const keyword = schemaOf('keyword').properties.terms!;
    expect(keyword.maxItems).toBe(L.terms);
    expect(keyword.items?.maxLength).toBe(ref.rules.limits.termCharsBeforeTrim);
    expect(ref.rules.limits.termCharsBeforeTrim).toBeGreaterThanOrEqual(L.termChars);
    expect(schemaOf('regex').properties.patterns!.maxItems).toBe(L.patterns);
    expect(schemaOf('link_domain').properties.domains!.maxItems).toBe(L.domains);
    expect(schemaOf('emoji').properties.emoji!.maxItems).toBe(L.emoji);
    expect(
      (schemaOf('emoji').properties.maxCount as unknown as { anyOf: { maximum?: number }[] })
        .anyOf[0]!.maximum,
    ).toBe(L.maxCount);
    const author = schemaOf('author').properties;
    expect(author.entries!.maxItems).toBe(L.authorEntries);
    const entry = (author.entries as unknown as { items: { properties: typeof author } }).items;
    expect((entry.properties.externalId as unknown as { maxLength: number }).maxLength).toBe(
      L.idChars,
    );
    const competitor = schemaOf('competitor').properties;
    expect(competitor.names!.maxItems).toBe(L.competitorEach);
    expect(competitor.names!.items?.maxLength).toBe(ref.rules.limits.termCharsBeforeTrim);
    expect(competitor.handles!.maxItems).toBe(L.competitorEach);
    expect(competitor.domains!.maxItems).toBe(L.competitorEach);
  });
});
