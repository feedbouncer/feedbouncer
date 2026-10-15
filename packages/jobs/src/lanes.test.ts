import { describe, expect, it } from 'vitest';
import { KNOWN_JOB_LANES, knownLaneOf } from './queues.js';

describe('knownLaneOf', () => {
  it('routes lane job types to their lane queue and everything else to the platform queue', () => {
    expect(knownLaneOf('comment_classify')).toBe('classify');
    expect(knownLaneOf('comment_ingest')).toBeNull();
    expect(Object.values(KNOWN_JOB_LANES).every((l) => /^[a-z][a-z0-9]{0,15}$/.test(l))).toBe(true);
  });
});
