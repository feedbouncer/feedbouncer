import { describe, expect, it } from 'vitest';
import { escapeLike } from './like.js';

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves other text alone', () => {
    expect(escapeLike('plain text')).toBe('plain text');
  });
});
