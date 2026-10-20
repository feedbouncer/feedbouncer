import { describe, expect, it } from 'vitest';
import { DEDUPE_MAX_IDS, DEDUPE_TTL_MS } from '../nodes/shared/constants';
import { rememberEvent } from '../nodes/FeedBouncerTrigger/dedupe';
import type { TriggerStaticData } from '../nodes/FeedBouncerTrigger/lifecycle';

describe('rememberEvent', () => {
  it('accepts an id once', () => {
    const data: TriggerStaticData = {};
    expect(rememberEvent(data, 'a', 1000)).toBe(true);
    expect(rememberEvent(data, 'a', 2000)).toBe(false);
  });

  it('keeps at most 1,000 ids and evicts the oldest', () => {
    const data: TriggerStaticData = {};
    for (let i = 0; i <= DEDUPE_MAX_IDS; i++) rememberEvent(data, `e${i}`, 1000 + i);
    expect(Object.keys(data.seen ?? {})).toHaveLength(DEDUPE_MAX_IDS);
    expect(rememberEvent(data, 'e0', 5000)).toBe(true);
    expect(rememberEvent(data, `e${DEDUPE_MAX_IDS}`, 5000)).toBe(false);
  });

  it('prunes ids older than 31 days', () => {
    const data: TriggerStaticData = {};
    rememberEvent(data, 'a', 0);
    expect(rememberEvent(data, 'a', DEDUPE_TTL_MS - 1)).toBe(false);
    expect(rememberEvent(data, 'a', DEDUPE_TTL_MS + 1)).toBe(true);
  });
});
