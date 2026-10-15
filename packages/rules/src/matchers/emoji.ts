import type { EmojiConditions } from '../conditions.js';
import { emojiKey } from '../emoji.js';
import type { Matcher } from './types.js';

export function compileEmojiRule(c: EmojiConditions): Matcher {
  const keys = new Set(c.emoji.map(emojiKey));
  return (v) => {
    const found = v.emoji;
    if (keys.size > 0)
      for (const e of found) if (keys.has(emojiKey(e))) return { kind: 'emoji', emoji: e };
    if (c.maxCount !== null && found.length > c.maxCount)
      return { kind: 'emoji_count', count: found.length, max: c.maxCount };
    return null;
  };
}
