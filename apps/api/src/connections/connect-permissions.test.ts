import { describe, expect, it } from 'vitest';
import { THREADS_SCOPE_PURPOSES } from '@feedbouncer/connector-threads';
import { connectPermissions } from './connect-permissions.js';

describe('connectPermissions', () => {
  it('lists each Threads scope with its purpose; only basic and read replies are required', () => {
    const list = connectPermissions('threads');
    expect(list.map((p) => [p.scope, p.required])).toEqual([
      ['threads_basic', true],
      ['threads_read_replies', true],
      ['threads_manage_replies', false],
      ['threads_content_publish', false],
    ]);
    for (const p of list)
      expect(p.purpose).toBe(
        THREADS_SCOPE_PURPOSES[p.scope as keyof typeof THREADS_SCOPE_PURPOSES],
      );
  });

  it('is empty for every other platform', () => {
    for (const p of ['facebook', 'instagram', 'tiktok', 'youtube'] as const)
      expect(connectPermissions(p)).toEqual([]);
  });
});
