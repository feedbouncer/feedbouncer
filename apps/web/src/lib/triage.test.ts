import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-client';
import {
  bulkSummary,
  confirmAndDeleteTag,
  countChangedText,
  deleteConfirmText,
  tagErrorText,
  tagNameError,
  triageRequest,
  type TriageResult,
} from './triage';

const ok = (commentId: string): TriageResult => ({ commentId, status: 'ok', changed: true });

describe('triageRequest', () => {
  it('builds the body for each operation', () => {
    expect(triageRequest(['c1'], { type: 'done' })).toEqual({
      commentIds: ['c1'],
      op: { type: 'done' },
    });
    expect(triageRequest(['c1', 'c2'], { type: 'add_tags', tagIds: ['t1'] })).toEqual({
      commentIds: ['c1', 'c2'],
      op: { type: 'add_tags', tagIds: ['t1'] },
    });
  });
});

describe('bulkSummary', () => {
  it('bulkSummary 8 of 10 with two failure lines, excerpt 60 code points + …', () => {
    const long = `${'👍'.repeat(30)}${'a'.repeat(40)}`;
    const results: TriageResult[] = [
      ...Array.from({ length: 8 }, (_, i) => ok(`c${i}`)),
      { commentId: 'gone', status: 'comment_deleted', changed: false },
      { commentId: 'long', status: 'not_found', changed: false },
    ];
    const bodies = new Map([
      ['gone', 'Short one'],
      ['long', long],
    ]);
    const s = bulkSummary(results, bodies);
    expect(s.headline).toBe('Updated 8 of 10 comments.');
    expect(s.failures).toEqual([
      'Short one: Deleted on the platform',
      `${'👍'.repeat(30)}${'a'.repeat(30)}…: No longer available`,
    ]);
  });

  it('has copy for every per-comment reason', () => {
    const s = bulkSummary(
      [
        { commentId: 'a', status: 'comment_tag_limit', changed: false },
        { commentId: 'b', status: 'unknown_tag', changed: false },
        { commentId: 'c', status: 'something_new', changed: false },
      ],
      new Map([
        ['a', 'A'],
        ['b', 'line one\n\nline two'],
      ]),
    );
    expect(s.headline).toBe('Updated 0 of 3 comments.');
    expect(s.failures).toEqual([
      'A: Already has 20 tags',
      'line one line two: Tag was deleted',
      'Comment: Could not be updated',
    ]);
    expect(bulkSummary([ok('a')], new Map()).headline).toBe('Updated 1 of 1 comment.');
  });
});

describe('tagNameError', () => {
  it('tagNameError mirrors parseTagName cases', () => {
    expect(tagNameError('')).toBe('Enter a tag name.');
    expect(tagNameError('   ')).toBe('Enter a tag name.');
    expect(tagNameError('a'.repeat(51))).toBe('Tag names can be up to 50 characters.');
    expect(tagNameError('🔥'.repeat(50))).toBeNull();
    expect(tagNameError('a\u0007b')).toBe("Tag names can't contain control characters.");
    expect(tagNameError('  مهم ')).toBeNull();
  });

  it('tagErrorText: API refusals of a tag', () => {
    const err = (status: number, code: string, extra: Partial<ApiRequestError> = {}) =>
      Object.assign(new ApiRequestError(status, code, 'x'), extra);
    expect(tagErrorText(err(400, 'invalid_tag_name', { reason: 'too_long' }))).toBe(
      'Tag names can be up to 50 characters.',
    );
    expect(tagErrorText(err(400, 'invalid_tag_name'))).toBe(
      'Enter a tag name of 1 to 50 characters without control characters.',
    );
    expect(tagErrorText(err(409, 'tag_name_taken', { tag: { id: 't', name: '<b>VIP</b>' } }))).toBe(
      'A tag named "<b>VIP</b>" already exists.',
    );
    expect(tagErrorText(err(409, 'tag_limit_reached'))).toBe(
      'This workspace has the maximum of 200 tags.',
    );
    expect(tagErrorText(new Error('offline'))).toBe('Something went wrong.');
  });
});

describe('tag delete copy', () => {
  it('deleteConfirmText singular/plural', () => {
    expect(deleteConfirmText('VIP', 1)).toBe(
      'Delete tag "VIP"? It will be removed from 1 comment.',
    );
    expect(deleteConfirmText('VIP', 0)).toBe(
      'Delete tag "VIP"? It will be removed from 0 comments.',
    );
    expect(deleteConfirmText('VIP', 12)).toBe(
      'Delete tag "VIP"? It will be removed from 12 comments.',
    );
  });

  it('countChangedText', () => {
    expect(countChangedText(3)).toBe('This tag is now on 3 comments. Confirm again to delete it.');
    expect(countChangedText(1)).toBe('This tag is now on 1 comment. Confirm again to delete it.');
  });

  it('confirmAndDeleteTag confirms again with the returned count when it changed', async () => {
    const asked: string[] = [];
    const sent: number[] = [];
    const r = await confirmAndDeleteTag(
      'VIP',
      2,
      (m) => {
        asked.push(m);
        return true;
      },
      async (n) => {
        sent.push(n);
        if (n === 2)
          throw Object.assign(new ApiRequestError(409, 'tag_count_changed', 'x'), { count: 5 });
      },
    );
    expect(r).toBe('deleted');
    expect(asked).toEqual([
      'Delete tag "VIP"? It will be removed from 2 comments.',
      'This tag is now on 5 comments. Confirm again to delete it.',
    ]);
    expect(sent).toEqual([2, 5]);
  });

  it('confirmAndDeleteTag sends nothing when cancelled and rethrows other errors', async () => {
    const del = async () => {
      throw new ApiRequestError(404, 'not_found', 'x');
    };
    expect(await confirmAndDeleteTag('VIP', 1, () => false, del)).toBe('cancelled');
    await expect(confirmAndDeleteTag('VIP', 1, () => true, del)).rejects.toThrow(ApiRequestError);
  });
});
