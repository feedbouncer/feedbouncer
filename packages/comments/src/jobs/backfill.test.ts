import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('connection_backfill is read-only toward the platform', () => {
  it('never acts, responds, sets up, or requests moderation, and reads only at background priority', () => {
    const src = readFileSync(new URL('./backfill.ts', import.meta.url), 'utf8');
    for (const banned of [
      '.act(',
      '.respond(',
      '.setup(',
      'ModerationActions',
      "priority: 'bulk'",
      "priority: 'urgent'",
      '.getComment(',
    ])
      expect(src.includes(banned), banned).toBe(false);
    expect(src.match(/priority: 'background'/g)?.length).toBe(2);
  });
});
