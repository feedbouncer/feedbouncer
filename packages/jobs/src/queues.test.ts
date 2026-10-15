import { describe, expect, it } from 'vitest';
import { laneMap, NO_LANES, queueName } from './queues.js';

describe('queueName', () => {
  it('keeps platform queues unchanged and names lane queues per platform', () => {
    expect(queueName('facebook')).toBe('platform-facebook');
    expect(queueName('facebook', null)).toBe('platform-facebook');
    expect(queueName('instagram', 'classify')).toBe('lane-classify-instagram');
  });
});

describe('laneMap', () => {
  it('maps job types that declare a lane and returns null otherwise', () => {
    const laneOf = laneMap([
      { type: 'comment_classify', lane: 'classify' },
      { type: 'ingest_comment' },
    ]);
    expect(laneOf('comment_classify')).toBe('classify');
    expect(laneOf('ingest_comment')).toBeNull();
    expect(laneOf('unknown')).toBeNull();
    expect(NO_LANES('comment_classify')).toBeNull();
  });
  it('rejects invalid lane names', () => {
    expect(() => laneMap([{ type: 'x', lane: 'Bad-Lane' }])).toThrow(RangeError);
  });
});
