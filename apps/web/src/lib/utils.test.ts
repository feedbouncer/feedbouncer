import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it.each([
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
  ])('keeps custom font size text-%s next to a text colour', (size) => {
    expect(cn(`text-${size}`, 'text-good')).toBe(`text-${size} text-good`);
  });

  it('still dedupes real conflicts', () => {
    expect(cn('text-ui', 'text-small')).toBe('text-small');
    expect(cn('text-good', 'text-danger')).toBe('text-danger');
  });
});
