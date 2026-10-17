import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeleteTagButton } from '../../../../components/org-comments/delete-tag-button';
import { isUuid } from '../../../../lib/ids';
import { totalText, type TagDto } from '../../../../lib/org-comments';
import { dataOrThrow, requireMe, serverGet } from '../../../../lib/server-api';

export default async function TagsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/tags`);
  const base = `/api/v1/orgs/${orgId}` as const;
  const { tags: list, canManage } = dataOrThrow(
    await serverGet<{ tags: TagDto[]; canManage: boolean }>(`${base}/tags`),
    'tags',
  );
  return (
    <main>
      <h1>Tags</h1>
      {list.length === 0 ? (
        <p>No tags yet. Add one to a comment on the Comments page.</p>
      ) : (
        <ul>
          {list.map((t) => (
            <li key={t.id}>
              <span dir="auto">{t.name}</span> · {totalText(t.commentCount)}
              {canManage ? (
                <>
                  {' '}
                  <DeleteTagButton orgId={orgId} tag={t} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href={`/orgs/${orgId}/comments`}>Back to comments</Link>
      </p>
    </main>
  );
}
