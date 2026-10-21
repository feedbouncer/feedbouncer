import type { ReactNode } from 'react';
import { platformLabel } from '../../lib/actions';
import { formatUtc } from '../../lib/format';
import {
  categoryLabel,
  rowAdLabel,
  statusLabel,
  type CommentReplyDto,
  type VisibleCommentDto,
} from '../../lib/org-comments';
import { CommentBody } from '../comment-body';
import { LocalTime } from '../local-time';

function replyAuthor(r: CommentReplyDto): string {
  if (r.actorType !== 'user') return 'Automation';
  return r.authorName ?? 'A teammate';
}

/**
 * One comment. Every name and text renders as a text node. `select`, `triage` (shown in place of
 * the read-only tags) and `children` (actions) are filled by the interactive list.
 */
export function CommentRow({
  item,
  select,
  triage,
  children,
}: {
  item: VisibleCommentDto;
  select?: ReactNode;
  triage?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li id={`comment-${item.id}`}>
      {select}
      <p>
        <strong>{item.authorName ?? 'Unknown author'}</strong> ·{' '}
        <LocalTime iso={item.postedAt} exactTitle />
        {item.parentRemoved ? (
          <> · Reply to a removed comment</>
        ) : item.isReply ? (
          <> · Reply</>
        ) : null}
        {item.stale ? <> · May be out of date</> : null}
        {item.done ? (
          <>
            {' '}
            ·{' '}
            <span
              title={`Marked done by ${item.done.byName ?? 'a teammate'} ${formatUtc(item.done.at)}`}
            >
              Done
            </span>
          </>
        ) : null}
      </p>
      <CommentBody body={item.body} />
      <p>
        {platformLabel(item.platform)} · {item.connectionName ?? 'Unnamed account'} ·{' '}
        {item.brandName}
      </p>
      <p>
        {rowAdLabel(item)} · {categoryLabel(item.category)} · {statusLabel(item.status)}
      </p>
      {triage ??
        (item.tags.length > 0 ? (
          <div>
            Tags:{' '}
            <ul aria-label="Tags">
              {item.tags.map((t) => (
                <li key={t.id}>{t.name}</li>
              ))}
            </ul>
          </div>
        ) : null)}
      {item.replies.length > 0 ? (
        <ul aria-label="Replies">
          {item.replies.map((r) => (
            <li key={r.id}>
              <p>
                {`${replyAuthor(r)} replied · `}
                <LocalTime iso={r.createdAt} exactTitle />
                {r.status === 'pending' ? <> · Sending…</> : null}
              </p>
              <CommentBody body={r.text} />
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </li>
  );
}
