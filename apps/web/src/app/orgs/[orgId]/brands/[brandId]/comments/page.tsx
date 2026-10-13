import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CommentActions } from '../../../../../../components/comment-actions';
import { CommentBody } from '../../../../../../components/comment-body';
import { CommentLinks } from '../../../../../../components/comment-links';
import { formatUtc } from '../../../../../../lib/format';
import { isUuid } from '../../../../../../lib/ids';
import type { Availability, ReplyLimits } from '../../../../../../lib/moderation';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

interface Comment {
  id: string;
  platform: string;
  parentCommentId: string | null;
  authorName: string | null;
  body: string;
  state: 'visible' | 'hidden' | 'deleted';
  postedAt: string;
  permalink: string | null;
  isOwnAccount: boolean;
  mediaExternalId: string;
  /** Computed by the API with the same rules it applies to a request. */
  availability: Availability;
  replyLimits: ReplyLimits;
}

const PAGE_SIZE = 50;
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
  return (
    <main>
      <h1>Comments</h1>
      {comments.length === 0 ? <p>No comments yet.</p> : null}
      <ul>
        {comments.map((c) => (
          <li key={c.id}>
            <p>
              <strong>{c.authorName ?? 'Unknown author'}</strong> · {formatUtc(c.postedAt)} ·{' '}
              <span>{c.state}</span>
            </p>
            {c.parentCommentId ? <p>Reply to another comment</p> : null}
            <CommentBody body={c.body} />
            <CommentLinks
              platform={c.platform}
              permalink={c.permalink}
              mediaExternalId={c.mediaExternalId}
            />
            <CommentActions
              orgId={orgId}
              brandId={brandId}
              commentId={c.id}
              platform={c.platform}
              state={c.state}
              availability={c.availability}
              replyLimits={c.replyLimits}
            />
          </li>
        ))}
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
