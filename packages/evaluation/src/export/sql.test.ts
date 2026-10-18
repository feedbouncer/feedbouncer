import { describe, expect, it } from 'vitest';
import { TENANT_SQL } from './sql.js';

describe('export SQL', () => {
  it('every WHERE clause starts with the organization predicate on $1', () => {
    const entries = Object.entries(TENANT_SQL);
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const [name, sql] of entries) {
      const wheres = [...sql.matchAll(/\bWHERE\s+([^\n]*)/g)].map((m) => m[1]!);
      expect(wheres.length, name).toBeGreaterThan(0);
      for (const w of wheres)
        expect(w, name).toMatch(/^(\w+\.)?organization_id = ANY\(\$1::uuid\[\]\)/);
      expect(sql, name).not.toMatch(/\$\{/);
    }
  });
});
