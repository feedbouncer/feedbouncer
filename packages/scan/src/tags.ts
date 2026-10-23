import type { ScanTag } from './contract.js';

const LINK =
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|top|site|link|ly|me)\b|wa\.me|t\.me/i;
const CRYPTO =
  /\b(crypto|bitcoin|btc|usdt|eth|forex|invest(ment|ing|or)?|trading|profit|binary)\b/i;
const GIVEAWAY =
  /\b(giveaway|you('ve| have)? won|winner|claim (your )?(prize|reward|gift)|free (iphone|gift|prize))\b/i;

const squash = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

export function tagComment(text: string, authorName: string | null, pageName: string): ScanTag[] {
  const page = squash(pageName);
  const tags: ScanTag[] = [];
  if (CRYPTO.test(text)) tags.push('crypto_investment');
  if (GIVEAWAY.test(text)) tags.push('fake_giveaway');
  if (LINK.test(text)) tags.push('phishing_link');
  if (authorName && page.length >= 3 && squash(authorName).includes(page)) {
    tags.push('impersonation');
  }
  return tags.length > 0 ? tags : ['generic'];
}
