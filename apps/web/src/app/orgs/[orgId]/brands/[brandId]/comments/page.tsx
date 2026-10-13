import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CommentActions } from '../../../../../../components/comment-actions';
import { formatUtc } from '../../../../../../lib/format';
import { isUuid } from '../../../../../../lib/ids';
import { facebookPermalink } from '../../../../../../lib/permalink';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

interface Comment {
  id: string;
  parentCommentId: string | null;
  authorName: string | null;
  hasAuthor: boolean;
  body: string;
  state: 'visible' | 'hidden' | 'deleted';
  postedAt: string;
  permalink: string | null;
  isOwnAccount: boolean;
}

const PAGE_SIZE = 50;
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function cursor(v: string | string[] | undefined): Date | null {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function CommentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/comments`);
  const sp = await searchParams;
  const before = cursor(sp.before);
  const beforeId = isUuid(sp.beforeId) ? sp.beforeId : null;
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before) {
    query.set('before', before.toISOString());
    if (beforeId) query.set('beforeId', beforeId);
  }
  const { comments } = dataOrThrow(
    await serverGet<{ comments: Comment[] }>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/comments?${query.toString()}`,
    ),
    'comments',
  );
  const last = comments.at(-1);
  const now = Date.now();
  return (
    <main>
      <h1>Comments</h1>
      {comments.length === 0 ? <p>No comments yet.</p> : null}
      <ul>
        {comments.map((c) => {
          const permalink = facebookPermalink(c.permalink);
          return (
            <li key={c.id}>
              <p>
                <strong>{c.authorName ?? 'Unknown author'}</strong> · {formatUtc(c.postedAt)} ·{' '}
                <span>{c.state}</span>
              </p>
              {c.parentCommentId ? <p>Reply to another comment</p> : null}
              <p style={{ whiteSpace: 'pre-wrap' }}>
                {c.body || '(no text: sticker or attachment)'}
              </p>
              {permalink ? (
                <a href={permalink} rel="noopener noreferrer" target="_blank">
                  View on Facebook
                </a>
              ) : null}
              <CommentActions
                orgId={orgId}
                brandId={brandId}
                commentId={c.id}
                state={c.state}
                canBan={!c.isOwnAccount && c.hasAuthor}
                privateReplyOpen={Date.parse(c.postedAt) + PRIVATE_REPLY_WINDOW_MS > now}
              />
            </li>
          );
        })}
      </ul>
      {last && comments.length === PAGE_SIZE ? (
        <p>
          <Link
            href={`/orgs/${orgId}/brands/${brandId}/comments?before=${encodeURIComponent(last.postedAt)}&beforeId=${last.id}`}
          >
            Older comments
          </Link>
        </p>
      ) : null}
      <p>
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
