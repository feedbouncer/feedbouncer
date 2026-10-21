import { describe, expect, it } from 'vitest';
import { CommentResource, toCommentResource, type CommentRow } from './comment.js';
import { FlaggedItemResource, toFlaggedItemResource, type FlaggedItemRow } from './flagged-item.js';
import { pageOf } from './page.js';

const id = '3f1f5f7e-9381-4c0a-8a0c-5b6de5e7b6d1';
const row: CommentRow = {
  id,
  brandId: id,
  connectionId: id,
  platform: 'instagram',
  externalId: 'ig_1',
  parentId: null,
  parentRemoved: false,
  authorDisplayName: 'Ann',
  authorAnonymizedAt: null,
  body: 'hello',
  postedAt: new Date('2026-10-18T10:00:00.000Z'),
  ingestedAt: new Date('2026-10-18T10:00:01.000Z'),
  platformState: 'visible',
  hasOpenReviewItem: false,
  permalink: null,
  isOwnAccount: false,
};

describe('toCommentResource', () => {
  it('maps a plain row', () => {
    const out = CommentResource.parse(toCommentResource(row));
    expect(out).toMatchObject({
      authorName: 'Ann',
      text: 'hello',
      textTruncated: false,
      status: 'visible',
      flagged: false,
    });
    expect(out.postedAt).toBe('2026-10-18T10:00:00.000Z');
  });

  it('includes parentRemoved', () => {
    expect(CommentResource.parse(toCommentResource(row)).parentRemoved).toBe(false);
    expect(
      CommentResource.parse(toCommentResource({ ...row, parentRemoved: true })).parentRemoved,
    ).toBe(true);
  });

  it('hides the author when anonymized', () => {
    const out = CommentResource.parse(
      toCommentResource({ ...row, authorDisplayName: 'Ann', authorAnonymizedAt: new Date() }),
    );
    expect(out.authorName).toBeNull();
    expect(
      CommentResource.parse(toCommentResource({ ...row, authorDisplayName: null })).authorName,
    ).toBeNull();
  });

  it('derives status and truncation', () => {
    const flagged = toCommentResource({ ...row, hasOpenReviewItem: true });
    expect(flagged).toMatchObject({ status: 'flagged', flagged: true });
    const hidden = toCommentResource({
      ...row,
      platformState: 'hidden',
      hasOpenReviewItem: true,
      body: 'x'.repeat(10_001),
    });
    expect(hidden).toMatchObject({ status: 'hidden', flagged: true, textTruncated: true });
    expect(hidden.text).toHaveLength(10_000);
  });
});

describe('toFlaggedItemResource', () => {
  const item: FlaggedItemRow = {
    id,
    brandId: id,
    commentId: id,
    source: 'rule',
    ruleId: null,
    status: 'resolved',
    resolution: 'hidden',
    createdAt: new Date('2026-10-18T10:00:00.000Z'),
    resolvedAt: new Date('2026-10-18T11:00:00.000Z'),
  };

  it('nests the comment and parses', () => {
    const out = FlaggedItemResource.parse(toFlaggedItemResource(item, toCommentResource(row)));
    expect(out.comment?.id).toBe(id);
    expect(out.resolvedAt).toBe('2026-10-18T11:00:00.000Z');
    expect(FlaggedItemResource.parse(toFlaggedItemResource(item, null)).comment).toBeNull();
  });
});

describe('pageOf', () => {
  it('wraps items with a cursor', () => {
    const page = pageOf(CommentResource, 'CommentPage');
    expect(page.parse({ data: [toCommentResource(row)], nextCursor: null }).nextCursor).toBeNull();
    expect(() => page.parse({ data: [] })).toThrow();
  });
});
