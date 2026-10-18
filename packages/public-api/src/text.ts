import { MAX_TEXT_CODE_POINTS } from './constants.js';

export function truncateText(
  text: string,
  max = MAX_TEXT_CODE_POINTS,
): { text: string; truncated: boolean } {
  // UTF-16 length is an upper bound on the code point count, so short strings skip the spread.
  if (text.length <= max) return { text, truncated: false };
  const points = [...text];
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(''), truncated: true };
}

export function publicStatus(
  platformState: 'visible' | 'hidden',
  hasOpenReviewItem: boolean,
): 'visible' | 'hidden' | 'flagged' {
  if (platformState === 'hidden') return 'hidden';
  return hasOpenReviewItem ? 'flagged' : 'visible';
}
