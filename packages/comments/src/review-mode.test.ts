import { describe, expect, it } from 'vitest';
import { GATED_KINDS } from './review-mode.js';

describe('review mode gate', () => {
  it('gates every kind that acts on the comment or its author, but not the undo kinds', () => {
    expect([...GATED_KINDS].sort()).toEqual(
      ['ban_author', 'delete', 'hide', 'private_reply', 'public_reply'].sort(),
    );
  });
});
