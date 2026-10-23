import { EXAMPLE_MAX_CODE_POINTS } from './limits.js';

export function maskAuthor(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return 'Unknown';
  return words.map((w) => `${[...w][0]!.toUpperCase()}.`).join(' ');
}

export function clipText(text: string): string {
  const points = [...text.replaceAll('\0', '�')];
  return points.length <= EXAMPLE_MAX_CODE_POINTS
    ? points.join('')
    : `${points.slice(0, EXAMPLE_MAX_CODE_POINTS).join('')}…`;
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
