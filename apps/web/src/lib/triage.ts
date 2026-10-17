// Done, reopen and tags on the Comments page, kept free of React so it can be tested directly.
import { TAGS_PER_COMMENT, TAGS_PER_ORG, parseTagName } from '@feedbouncer/actions/shared';
import { ApiRequestError } from './api-client';
import { messageFor } from './messages';

export type TriageOp =
  | { type: 'done' }
  | { type: 'reopen' }
  | { type: 'add_tags'; tagIds: string[] }
  | { type: 'remove_tags'; tagIds: string[] };

export interface TriageResult {
  commentId: string;
  status: string;
  changed: boolean;
}

export const triageRequest = (
  commentIds: string[],
  op: TriageOp,
): { commentIds: string[]; op: TriageOp } => ({ commentIds, op });

const ITEM_REASONS: Record<string, string> = {
  not_found: 'No longer available',
  comment_deleted: 'Deleted on the platform',
  comment_tag_limit: `Already has ${TAGS_PER_COMMENT} tags`,
  unknown_tag: 'Tag was deleted',
};

export const itemReasonText = (status: string): string =>
  Object.hasOwn(ITEM_REASONS, status) ? ITEM_REASONS[status]! : 'Could not be updated';

const EXCERPT_MAX = 60;

/** The start of a comment, on one line: at most 60 code points, with … when cut. */
function excerpt(body: string | undefined): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Comment';
  const chars = Array.from(flat);
  return chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX).join('')}…` : flat;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a bulk run did: a headline and one line per comment that was not updated. */
export function bulkSummary(
  results: readonly TriageResult[],
  bodies: ReadonlyMap<string, string>,
): { headline: string; failures: string[] } {
  const ok = results.filter((r) => r.status === 'ok').length;
  return {
    headline: `Updated ${ok} of ${plural(results.length, 'comment', 'comments')}.`,
    failures: results
      .filter((r) => r.status !== 'ok')
      .map((r) => `${excerpt(bodies.get(r.commentId))}: ${itemReasonText(r.status)}`),
  };
}

const TAG_NAME_ERRORS: Record<string, string> = {
  empty: 'Enter a tag name.',
  too_long: 'Tag names can be up to 50 characters.',
  control_chars: "Tag names can't contain control characters.",
};

/** The same check the API makes on a new tag name, for instant feedback. */
export function tagNameError(raw: string): string | null {
  const r = parseTagName(raw);
  return r.ok ? null : TAG_NAME_ERRORS[r.error]!;
}

/** Text for a refused tag request (create, apply or delete). */
export function tagErrorText(err: unknown): string {
  if (!(err instanceof ApiRequestError)) return 'Something went wrong.';
  switch (err.code) {
    case 'invalid_tag_name':
      return err.reason !== undefined && Object.hasOwn(TAG_NAME_ERRORS, err.reason)
        ? TAG_NAME_ERRORS[err.reason]!
        : messageFor(err.code);
    case 'tag_name_taken':
      return err.tag ? `A tag named "${err.tag.name}" already exists.` : messageFor(err.code);
    case 'tag_limit_reached':
      return `This workspace has the maximum of ${TAGS_PER_ORG} tags.`;
    default:
      return messageFor(err.code);
  }
}

/** Text when one comment could not be changed. */
export function rowResultText(status: string): string | null {
  if (status === 'ok') return null;
  if (status === 'comment_tag_limit') return `A comment can have up to ${TAGS_PER_COMMENT} tags.`;
  return `${itemReasonText(status)}.`;
}

export const deleteConfirmText = (name: string, n: number): string =>
  `Delete tag "${name}"? It will be removed from ${plural(n, 'comment', 'comments')}.`;

export const countChangedText = (n: number): string =>
  `This tag is now on ${plural(n, 'comment', 'comments')}. Confirm again to delete it.`;

/**
 * Asks before deleting a tag, naming how many comments lose it. When that number changed in the
 * meantime the API refuses, and this asks again with the new number. Nothing is sent unless the
 * viewer confirms the number being sent.
 */
export async function confirmAndDeleteTag(
  name: string,
  count: number,
  ask: (message: string) => boolean,
  remove: (confirmCount: number) => Promise<void>,
): Promise<'deleted' | 'cancelled'> {
  let n = count;
  let message = deleteConfirmText(name, n);
  for (;;) {
    if (!ask(message)) return 'cancelled';
    try {
      await remove(n);
      return 'deleted';
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.code === 'tag_count_changed')) throw err;
      if (err.count === undefined) throw err;
      n = err.count;
      message = countChangedText(n);
    }
  }
}
