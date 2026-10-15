import { expect, it } from 'vitest';
import { emojiGraphemes, emojiKey } from './emoji.js';

it('ZWJ families, flags, keycaps and skin tones are one emoji each', () => {
  expect(emojiGraphemes('👨‍👩‍👧 🇮🇱 1️⃣ 👍🏽 ❤️ ❤')).toHaveLength(6);
  expect(emojiGraphemes('plain text 123')).toHaveLength(0);
});
it('emojiKey folds skin tone and VS16', () => {
  expect(emojiKey('👍🏽')).toBe(emojiKey('👍'));
  expect(emojiKey('❤️')).toBe(emojiKey('❤'));
});
