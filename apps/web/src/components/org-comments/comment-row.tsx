import { platformLabel } from '../../lib/actions';
import {
  categoryLabel,
  rowAdLabel,
  statusLabel,
  type VisibleCommentDto,
} from '../../lib/org-comments';
import { CommentBody } from '../comment-body';
import { LocalTime } from '../local-time';

export function CommentRow({ item }: { item: VisibleCommentDto }) {
  return (
    <li id={`comment-${item.id}`}>
      <p>
        <strong>{item.authorName ?? 'Unknown author'}</strong> ·{' '}
        <LocalTime iso={item.postedAt} exactTitle />
        {item.isReply ? <> · Reply</> : null}
        {item.stale ? <> · May be out of date</> : null}
      </p>
      <CommentBody body={item.body} />
      <p>
        {platformLabel(item.platform)} · {item.connectionName ?? 'Unnamed account'} ·{' '}
        {item.brandName}
      </p>
      <p>
        {rowAdLabel(item)} · {categoryLabel(item.category)} · {statusLabel(item.status)}
      </p>
    </li>
  );
}
