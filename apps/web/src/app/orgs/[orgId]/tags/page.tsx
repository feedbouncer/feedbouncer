import { notFound } from 'next/navigation';
import { DeleteTagButton } from '../../../../components/org-comments/delete-tag-button';
import { ListPanel, ListRow } from '../../../../components/ui/list';
import { PageHeader } from '../../../../components/ui/page-header';
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
      <PageHeader title="Tags" />
      {list.length === 0 ? (
        <p data-state="empty">No tags yet. Add one to a comment on the Comments page.</p>
      ) : (
        <ListPanel>
          {list.map((t) => (
            <ListRow key={t.id}>
              <div className="flex items-baseline gap-2">
                <span dir="auto" className="font-semibold text-foreground">
                  {t.name}
                </span>
                <span className="text-small text-dim">{totalText(t.commentCount)}</span>
              </div>
              {canManage ? <DeleteTagButton orgId={orgId} tag={t} /> : null}
            </ListRow>
          ))}
        </ListPanel>
      )}
    </main>
  );
}
