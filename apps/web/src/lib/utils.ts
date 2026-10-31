import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Custom `--text-*` theme tokens from globals.css. Without registering them
// as font sizes, tailwind-merge reads `text-ui` etc. as colours and drops them
// when a text colour follows.
const FONT_SIZES = [
  'micro',
  'caption',
  'small',
  'label',
  'ui',
  'body',
  'card-title',
  'lede',
  'brand',
  'section',
  'page',
  'hero',
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: [...FONT_SIZES] }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
